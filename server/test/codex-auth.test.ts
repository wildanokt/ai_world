import { expect, it, vi } from "vitest";
import { createCodexAuth, readDeviceCode } from "../src/model/codex-auth.js";
import { readBrowserLogin } from "../src/model/codex-browser-login.js";

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

it("extracts a complete code only after the official CLI sign-in URL", () => {
  const output = "1. Open this link\r\n   \x1b[4mhttps://auth.openai.com/codex/device\x1b[0m\r\n2. Enter this one-time code\r\n";
  expect(readDeviceCode(output + "   ABCD-EF")).toBeUndefined();
  expect(readDeviceCode(output + "   \x1b[1mABCD-EFGHI\x1b[0m\r\n")).toBe("ABCD-EFGHI");
  expect(readDeviceCode(output.replace("auth.openai.com", "example.com") + "ABCD-EFGHI\n")).toBeUndefined();
});

it("limits each device code to the browser session that requested it and supports retry after cancellation", async () => {
  const auth = createCodexAuth((command, device) => {
    if (command !== "device-login" || !device) return Promise.resolve();
    device.onCode("ABCD-EFGHI");
    return new Promise((_, reject) => device.signal.addEventListener("abort", () => reject(new Error("Canceled")), { once: true }));
  }, true);

  expect(auth.start()).toBe(false);
  expect(auth.start("first")).toBe(true);
  expect(auth.start("second")).toBe(false);
  expect((await auth.status("first")).device).toEqual({
    state: "ready", url: "https://auth.openai.com/codex/device", code: "ABCD-EFGHI",
  });
  expect((await auth.status("second")).device).toEqual({ state: "other-session" });
  expect(auth.cancel("second")).toBe(false);
  expect(auth.cancel("first")).toBe(true);
  expect((await auth.status("first")).device).toEqual({ state: "canceling" });
  expect((await auth.status("first")).login).toBeNull();
  expect(auth.start("second")).toBe(true);
  expect(auth.cancel("second")).toBe(true);
});

const browserState = "test-state-with-enough-characters";
const callbackAddress = "http://127.0.0.1:1455/auth/callback";
const authorize = new URL("https://auth.openai.com/oauth/authorize");
authorize.search = new URLSearchParams({
  response_type: "code",
  redirect_uri: callbackAddress,
  code_challenge_method: "S256",
  code_challenge: "A".repeat(43),
  state: browserState,
}).toString();

it("reads the normal CLI login URL and rejects non-Codex callback addresses", () => {
  const output = `Starting local login server\n${authorize.href}\n`;
  expect(readBrowserLogin(output)).toEqual({ url: authorize.href, state: browserState });
  expect(readBrowserLogin(output.replace("1455", "3000"))).toBeUndefined();
  expect(readBrowserLogin(output.replace("auth.openai.com", "example.com"))).toBeUndefined();
});

it("forwards the browser result only for its matching session and state", async () => {
  let done!: () => void;
  const auth = createCodexAuth((command, process) => {
    if (command !== "browser-login" || !process) return Promise.resolve();
    process.onBrowser({ url: authorize.href, state: browserState });
    return new Promise<void>((resolve) => { done = resolve; });
  }, true);
  const loopback = vi.fn(async (url: URL) => url.pathname === "/auth/callback"
    ? new Response(null, { status: 302, headers: { Location: "http://localhost:1455/success" } })
    : new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", loopback);
  try {
    expect(auth.start("owner", "browser")).toBe(true);
    expect((await auth.status("other")).browser).toEqual({ state: "other-session" });
    const result = `${callbackAddress}?code=fixture-only&state=${browserState}`;
    expect(await auth.completeBrowser("other", result)).toBe("inactive");
    expect(await auth.completeBrowser("owner", result.replace(browserState, "wrong-state"))).toBe("invalid");
    expect(await auth.completeBrowser("owner", result.replace("127.0.0.1", "example.com"))).toBe("invalid");
    expect(await auth.completeBrowser("owner", result + "&code=duplicate")).toBe("invalid");
    expect(loopback).not.toHaveBeenCalled();
    expect(await auth.completeBrowser("owner", result + "&scope=openid")).toBe("accepted");
    expect(loopback.mock.calls.map(([url]) => url.href)).toEqual([result, "http://127.0.0.1:1455/success"]);
    expect(await auth.completeBrowser("owner", result)).toBe("inactive");
    done();
    await Promise.resolve();
    expect(await auth.status("owner")).toEqual({ credentials: "present", login: "succeeded", hosted: true });
  } finally {
    vi.unstubAllGlobals();
  }
});
