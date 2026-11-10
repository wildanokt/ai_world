import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { ModelProvider, ModelTier, TokenUsage } from "./provider.js";

export const MODEL = "gpt-6-luna";
export type Effort = "none" | "low" | "medium" | "high";

const replySchema = z.object({
  text: z.string(),
  calls: z.array(z.object({ name: z.string(), input: z.string() })).max(12),
});
type Reply = z.infer<typeof replySchema>;
type Invoke = (prompt: string, effort: Effort) => Promise<{ reply: Reply; usage: TokenUsage }>;

export function codexFailure(details: string, timedOut: boolean): string {
  if (/usage limit|rate.limit|insufficient.quota|\b429\b/i.test(details)) {
    return "Codex usage limit reached. Check your Codex usage and try again when it resets.";
  }
  if (/model.not.found|model.{0,60}(not supported|not available|do not have access)|unsupported.model/i.test(details)) {
    return "GPT-6 Luna is unavailable for this Codex account or CLI. Check the active account and CLI version.";
  }
  if (/\b401\b|unauthorized|not logged in|token.{0,45}(expired|refresh failed|revoked)|refresh token.{0,60}(reused|expired)|login required/i.test(details)) {
    return "Codex authentication failed. Use Codex login in God Console → Live Campaign → AI settings, or run codex login in PowerShell.";
  }
  if (/sandbox.{0,80}(setup failed|access is denied|permission denied)|failed to initialize.{0,30}sandbox/i.test(details)) {
    return "Codex could not initialize its Windows sandbox. Start the game server from your normal PowerShell session.";
  }
  if (/stream disconnected|connection (reset|refused)|failed to (connect|send request)|network error|certificate verify/i.test(details)) {
    return "Codex lost its connection to OpenAI. Check your network and retry the action.";
  }
  if (timedOut) return "Codex timed out while responding. Retry the action in a moment.";
  if (/unexpected argument|unrecognized option|unknown option/i.test(details)) {
    return "The installed Codex CLI does not support a required option. Check codex --version and update the CLI.";
  }
  return "Codex CLI ended without a usable reply. Try the action again. If it recurs, check codex login status and codex --version.";
}

export function codexEnvironment() {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  return env;
}

export function codexCli(binary: string): Invoke {
  return async (prompt, effort) => {
    const dir = await mkdtemp(join(tmpdir(), "rpg-codex-"));
    try {
      const schema = join(dir, "reply.json");
      await writeFile(schema, JSON.stringify(z.toJSONSchema(replySchema)));
      const env = codexEnvironment();
      const child = spawn(binary, [
        "-a", "never", "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
        "--skip-git-repo-check", "--sandbox", "read-only", "--cd", dir, "--model", MODEL,
        "-c", 'web_search="disabled"', "-c", 'features.shell_tool=false',
        "-c", 'features.hooks=false', "-c", 'features.multi_agent=false',
        "-c", 'windows.sandbox="unelevated"',
        "-c", 'model_reasoning_effort="' + effort + '"', "--output-schema", schema, "-",
      ], { cwd: dir, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const completion = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      void completion.catch(() => {});
      child.stdin.on("error", () => {});
      child.stdin.end(prompt, "utf8");
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-8192);
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 120_000);
      try {
        let last = "";
        let failure: string | undefined;
        let reportedError = "";
        const usage = { input: 0, cached: 0, output: 0 };
        for await (const line of createInterface({ input: child.stdout })) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "item.completed" && event.item?.type === "agent_message") last = event.item.text;
          if (event.type === "error" && typeof event.message === "string") reportedError = event.message.slice(-4096);
          if (event.type === "turn.failed") failure = String(event.error?.message ?? "").slice(-4096);
          if (event.type === "turn.completed" && event.usage) {
            usage.input += event.usage.input_tokens ?? 0;
            usage.cached += event.usage.cached_input_tokens ?? 0;
            usage.output += event.usage.output_tokens ?? 0;
          }
        }
        const exit = await completion.catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "EACCES") {
            throw new Error("The game could not start Codex CLI. Check that codex.exe is on PATH or set CODEX_BIN.");
          }
          throw new Error("The game could not start Codex CLI.");
        });
        if (exit !== 0 || failure !== undefined || !last) {
          throw new Error(codexFailure([failure, reportedError, stderr].join("\n"), timedOut));
        }
        try {
          return { reply: replySchema.parse(JSON.parse(last)), usage };
        } catch {
          throw new Error("Codex returned a reply the game could not read. Retry the action.");
        }
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export function createCodexProvider({ invoke, effort }: { invoke: Invoke; effort: (tier: ModelTier) => Effort }): ModelProvider {
  return {
    async runTurn(request, onText) {
      const tools = request.tools.map(({ name, description, schema }) => ({ name, description, schema: z.toJSONSchema(schema) }));
      const exchanges: unknown[] = [...request.messages];
      const trace: unknown[] = [];
      const usage = { input: 0, cached: 0, output: 0 };
      let text = "";
      for (let i = 0; i < request.maxModelCalls; i++) {
        const prompt = [
          "You are the decision engine for a game server. Produce only the structured response.",
          "Every entry in gameActions is available via your JSON output. The server executes those actions after you return. To perform a game action, put its name and arguments in calls. Do not attempt to invoke it as a native Codex function. You do not need access to native tools.",
          'Action response example: {"text":"","calls":[{"name":"skill_check","input":"{\\"characterId\\":\\"pc\\",\\"skill\\":\\"Athletics\\",\\"difficulty\\":15,\\"reason\\":\\"Leap a fence\\"}"}]}. Use the actual action schema and character IDs below.',
          'When ready to give the final answer, return {"text":"your answer","calls":[]}.',
          request.system,
          JSON.stringify({ gameActions: tools, exchanges }),
          "Use calls for any pending game actions. If you are waiting on a result, return the action request now with empty text.",
        ].join("\n\n");
        const result = await invoke(prompt, effort(request.tier));
        usage.input += result.usage.input;
        usage.cached += result.usage.cached;
        usage.output += result.usage.output;
        if (!result.reply.calls.length) {
          text = result.reply.text;
          onText?.(text);
          return { text, stoppedEarly: false, usage, trace: { prompt, calls: trace } };
        }
        const results = [];
        for (const call of result.reply.calls) {
          const tool = request.tools.find((candidate) => candidate.name === call.name);
          let input: unknown;
          try { input = JSON.parse(call.input); } catch { input = null; }
          const validation = tool?.schema.safeParse(input);
          const outcome = tool && validation?.success
            ? await tool.execute(validation.data)
            : { content: validation ? z.prettifyError(validation.error!) : "Unknown game tool", isError: true };
          results.push({ call, outcome });
        }
        trace.push(...results);
        exchanges.push({ toolResults: results });
      }
      return { text, stoppedEarly: true, usage, trace: { system: request.system, tools, exchanges, calls: trace } };
    },
  };
}
