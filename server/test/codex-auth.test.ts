import { expect, it, vi } from "vitest";
import { createCodexAuth } from "../src/model/codex-auth.js";

it("runs one login at a time and checks the credential status after it finishes", async () => {
  let complete!: () => void;
  const login = new Promise<void>((resolve) => { complete = resolve; });
  const run = vi.fn().mockImplementation((command: string) => command === "login" ? login : Promise.resolve());
  const auth = createCodexAuth(run);
  expect(auth.start()).toBe(true);
  expect(auth.start()).toBe(false);
  expect(await auth.status()).toEqual({ credentials: "unknown", login: "pending" });
  complete();
  await login;
  expect(await auth.status()).toEqual({ credentials: "present", login: "succeeded" });
  expect(run.mock.calls).toEqual([["login"], ["status"]]);
});

it("reports failed login separately from stored credentials", async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error("private output")).mockResolvedValueOnce(undefined);
  const auth = createCodexAuth(run);
  auth.start();
  await Promise.resolve();
  expect(await auth.status()).toEqual({ credentials: "present", login: "failed" });
});
