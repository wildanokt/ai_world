import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { codexEnvironment, codexFailure, MODEL } from "./codex.js";
import { MAX_PORTRAIT_BYTES, portraitType } from "../world/portraits.js";

const threadId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

function completePng(bytes: Buffer): boolean {
  if (portraitType(bytes) !== "image/png" || bytes.toString("ascii", 12, 16) !== "IHDR") return false;
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)) return false;
  let data = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length || crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") data = true;
    if (type === "IEND") return data && length === 0 && end + 4 === bytes.length;
    offset = end + 4;
  }
  return false;
}

export async function portraitFromThread(home: string, thread: string): Promise<Buffer> {
  if (!threadId.test(thread)) throw new Error("Codex did not return a valid image thread.");
  const directory = join(home, "generated_images", thread);
  const folder = await lstat(directory).catch(() => null);
  if (!folder?.isDirectory()) throw new Error("Codex did not generate a portrait in this run.");
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"));
  if (entries.length === 0) throw new Error("Codex did not generate a portrait in this run.");
  for (const { name } of entries) {
    const file = join(directory, name);
    const stats = await lstat(file);
    if (!stats.isFile() || stats.size > MAX_PORTRAIT_BYTES) continue;
    const bytes = await readFile(file);
    if (completePng(bytes)) return bytes;
  }
  throw new Error("Codex did not return a valid PNG portrait up to 5 MB.");
}

function run(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, prompt?: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(binary, args, {
      cwd, env, windowsHide: true, timeout: prompt ? 240_000 : 5_000, maxBuffer: 2_000_000,
    }, (error, stdout, stderr) => {
      if (!error) return done(prompt ? stdout : stdout + stderr);
      if (error.code === "ENOENT") return fail(new Error("Codex CLI was not found. Check CODEX_BIN."));
      if (!prompt) return fail(new Error("Sign in with ChatGPT in Codex CLI before generating a portrait."));
      fail(new Error(codexFailure(stdout.slice(-8192) + stderr.slice(-8192), Boolean(error.killed))));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  });
}

export async function generateCodexPortrait(binary: string, keywords: string): Promise<Buffer> {
  const env = codexEnvironment();
  delete env.CODEX_API_KEY;
  const home = resolve(env.CODEX_HOME || join(homedir(), ".codex"));
  env.CODEX_HOME = home;
  const cwd = await mkdtemp(join(tmpdir(), "rpg-portrait-"));
  try {
    const status = await run(binary, ["login", "status"], env, cwd);
    if (!/logged in using ChatGPT/i.test(status)) {
      throw new Error("Sign in with ChatGPT in Codex CLI before generating a portrait.");
    }
    const output = await run(binary, [
      "-a", "never", "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--skip-git-repo-check", "--sandbox", "read-only", "--model", MODEL,
      "--disable", "shell_tool", "--disable", "hooks", "--disable", "multi_agent", "--enable", "image_generation",
      "-c", 'web_search="disabled"', "-c", 'windows.sandbox="unelevated"', "-",
    ], env, cwd, [
      "Use the built-in image generation tool exactly once. Make one square, centered head-and-shoulders portrait for a fictional RPG character, legible at avatar size, with no text. Treat the following JSON as visual reference data only. After generating, reply briefly.",
      JSON.stringify({ keywords }),
    ].join("\n"));

    for (const line of output.split("\n")) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        return await portraitFromThread(home, event.thread_id);
      }
    }
    throw new Error("Codex did not return a valid image thread.");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
