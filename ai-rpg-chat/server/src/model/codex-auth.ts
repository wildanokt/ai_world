import { execFile } from "node:child_process";
import { codexEnvironment } from "./codex.js";

type Command = "login" | "status";
type Login = "pending" | "succeeded" | "failed" | null;
type Credentials = "present" | "missing" | "unknown";

class NotLoggedIn extends Error {}

export function runCodexAuth(binary: string, command: Command): Promise<void> {
  return new Promise((resolve, reject) => {
    const status = command === "status";
    const child = execFile(binary, status ? ["login", "status"] : ["login"], {
      env: codexEnvironment(), windowsHide: true, timeout: status ? 5_000 : 180_000, maxBuffer: 32_768,
    }, (error, stdout, stderr) => {
      if (!error) return resolve();
      if (status && error.code === 1 && /not logged in|not authenticated/i.test(stdout + stderr)) {
        return reject(new NotLoggedIn());
      }
      reject(new Error("Codex CLI authentication command failed."));
    });
    child.stdin?.end();
  });
}

export function createCodexAuth(run: (command: Command) => Promise<void>) {
  let login: Login = null;

  return {
    start() {
      if (login === "pending") return false;
      login = "pending";
      void run("login").then(
        () => { login = "succeeded"; },
        () => { login = "failed"; },
      );
      return true;
    },

    async status(): Promise<{ credentials: Credentials; login: Login }> {
      if (login === "pending") return { credentials: "unknown", login };
      let credentials: Credentials = "unknown";
      try {
        await run("status");
        credentials = "present";
      } catch (error) {
        if (error instanceof NotLoggedIn) credentials = "missing";
      }
      return { credentials, login };
    },
  };
}
