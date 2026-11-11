import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { browserCallback, finishBrowserLogin, readBrowserLogin, type BrowserLogin } from "./codex-browser-login.js";
import { codexEnvironment } from "./codex.js";

type Command = "login" | "device-login" | "browser-login" | "status";
type Login = "pending" | "succeeded" | "failed" | null;
type Credentials = "present" | "missing" | "unknown";
type WaitingChallenge = { state: "preparing" | "other-session" | "canceling" | "finishing" };
type DeviceChallenge = WaitingChallenge
  | { state: "ready"; url: string; code: string };
type BrowserChallenge = WaitingChallenge | { state: "ready"; url: string };
type LoginProcess = {
  onCode: (code: string) => void;
  onBrowser: (browser: BrowserLogin) => void;
  signal: AbortSignal;
};
type RunAuth = (command: Command, process?: LoginProcess) => Promise<void>;
type HostedMethod = "browser" | "device";
type HostedAttempt = {
  method: HostedMethod;
  owner: string;
  controller: AbortController;
  code?: string;
  browser?: BrowserLogin;
  finishing?: boolean;
};

const DEVICE_URL = "https://auth.openai.com/codex/device";

class NotLoggedIn extends Error {}

export function readDeviceCode(output: string): string | undefined {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = plain.split(/\r?\n/);
  // Ignore the last line until its newline arrives, in case the code spans chunks.
  lines.pop();
  const urlIndex = lines.findIndex((line) => line.trim() === DEVICE_URL);
  if (urlIndex === -1) return undefined;
  return lines.slice(urlIndex + 1).map((line) => line.trim())
    .find((line) => /^[A-Z0-9]{3,12}(?:-[A-Z0-9]{3,12}){1,3}$/.test(line));
}

function invokeCodexAuth(binary: string, command: Command, env: NodeJS.ProcessEnv, process?: LoginProcess): Promise<void> {
  return new Promise((done, reject) => {
    const status = command === "status";
    const args = ["login"];
    if (status) args.push("status");
    if (command === "device-login") args.push("--device-auth");
    if (process) args.push("-c", 'cli_auth_credentials_store="file"');
    const child = execFile(binary, args, {
      env, windowsHide: true, signal: process?.signal,
      timeout: status ? 5_000 : command === "device-login" ? 16 * 60_000 : 5 * 60_000, maxBuffer: 32_768,
    }, (error, stdout, stderr) => {
      if (!error) return done();
      if (status && error.code === 1 && /not logged in|not authenticated/i.test(stdout + stderr)) {
        return reject(new NotLoggedIn());
      }
      reject(new Error("Codex CLI authentication command failed."));
    });
    if (process) {
      let reported = false;
      for (const stream of [child.stdout, child.stderr]) {
        let output = "";
        stream?.on("data", (chunk: Buffer) => {
          if (reported) return;
          output += chunk.toString();
          if (command === "browser-login") {
            const browser = readBrowserLogin(output);
            if (!browser) return;
            process.onBrowser(browser);
          } else {
            const code = readDeviceCode(output);
            if (!code) return;
            process.onCode(code);
          }
          reported = true;
        });
      }
    }
    child.stdin?.end();
  });
}

export async function runCodexAuth(binary: string, command: Command, process?: LoginProcess): Promise<void> {
  const env = codexEnvironment();
  if (!process) return invokeCodexAuth(binary, command, env);

  // The CLI clears its auth store when login starts. Isolate that store until login succeeds.
  const codexHome = resolve(env.CODEX_HOME || join(homedir(), ".codex"));
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const stagingHome = await mkdtemp(join(codexHome, ".ai-world-login-"));
  try {
    await copyFile(join(codexHome, "config.toml"), join(stagingHome, "config.toml")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const stagingEnv = { ...env, CODEX_HOME: stagingHome };
    await invokeCodexAuth(binary, command, stagingEnv, process);
    process.signal.throwIfAborted();
    const credentials = join(stagingHome, "auth.json");
    await chmod(credentials, 0o600);
    await rename(credentials, join(codexHome, "auth.json"));
  } finally {
    await rm(stagingHome, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function createCodexAuth(run: RunAuth, hosted = false) {
  let login: Login = null;
  let active: HostedAttempt | undefined;

  return {
    start(owner?: string, method: HostedMethod = "device") {
      if (login === "pending") return false;
      if (hosted && !owner) return false;
      login = "pending";
      const attempt: HostedAttempt | undefined = hosted && owner ? { method, owner, controller: new AbortController() } : undefined;
      active = attempt;
      const result = attempt ? run(method === "browser" ? "browser-login" : "device-login", {
        signal: attempt.controller.signal,
        onCode: (code) => { attempt.code = code; },
        onBrowser: (browser) => { attempt.browser = browser; },
      }) : run("login");
      void result.then(
        () => { login = "succeeded"; active = undefined; },
        () => { login = attempt?.controller.signal.aborted ? null : "failed"; active = undefined; },
      );
      return true;
    },

    cancel(owner?: string) {
      if (!active || active.owner !== owner || active.finishing) return false;
      active.controller.abort();
      return true;
    },

    async completeBrowser(owner: string | undefined, address: string) {
      const attempt = active;
      if (!attempt?.browser || attempt.owner !== owner || attempt.finishing || attempt.controller.signal.aborted) return "inactive";
      const callback = browserCallback(address, attempt.browser.state);
      if (!callback) return "invalid";
      attempt.finishing = true;
      try {
        if (await finishBrowserLogin(callback, attempt.controller.signal)) return "accepted";
      } catch {
        // Do not surface callback addresses or raw CLI responses.
      }
      attempt.finishing = false;
      return "failed";
    },

    async status(owner?: string): Promise<{ credentials: Credentials; login: Login; device?: DeviceChallenge; browser?: BrowserChallenge; hosted?: true }> {
      const mode = hosted ? { hosted: true as const } : {};
      if (login === "pending") {
        if (!active) return { credentials: "unknown", login, ...mode };
        let waiting: WaitingChallenge = { state: "preparing" };
        if (owner !== active.owner) waiting = { state: "other-session" };
        else if (active.controller.signal.aborted) waiting = { state: "canceling" };
        else if (active.finishing) waiting = { state: "finishing" };

        const visible = waiting.state === "preparing";
        if (active.method === "browser") {
          const browser: BrowserChallenge = visible && active.browser ? { state: "ready", url: active.browser.url } : waiting;
          return { credentials: "unknown", login, browser, ...mode };
        }
        const device: DeviceChallenge = visible && active.code ? { state: "ready", url: DEVICE_URL, code: active.code } : waiting;
        return { credentials: "unknown", login, device, ...mode };
      }
      let credentials: Credentials = "unknown";
      try {
        await run("status");
        credentials = "present";
      } catch (error) {
        if (error instanceof NotLoggedIn) credentials = "missing";
      }
      return { credentials, login, ...mode };
    },
  };
}
