const AUTH_ORIGIN = "https://auth.openai.com";
const CALLBACK_ORIGIN = "http://127.0.0.1:1455";
const CALLBACK_PATH = "/auth/callback";

export type BrowserLogin = { url: string; state: string };

export function readBrowserLogin(output: string): BrowserLogin | undefined {
  const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
  lines.pop();
  const line = lines.find((value) => value.trim().startsWith(`${AUTH_ORIGIN}/oauth/authorize?`));
  if (!line) return undefined;
  const url = URL.parse(line.trim());
  if (url?.origin !== AUTH_ORIGIN || url.pathname !== "/oauth/authorize" || url.username || url.password || url.hash) return undefined;
  const params = url.searchParams;
  const state = params.get("state");
  if (params.get("redirect_uri") !== CALLBACK_ORIGIN + CALLBACK_PATH ||
      params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256" ||
      !/^[\w-]{43}$/.test(params.get("code_challenge") ?? "") || !state || !/^[\w-]{16,128}$/.test(state)) return undefined;
  return { url: url.href, state };
}

export function browserCallback(address: string, expectedState: string): URL | undefined {
  const url = URL.parse(address.trim());
  if (url?.origin !== CALLBACK_ORIGIN || url.pathname !== CALLBACK_PATH || url.username || url.password || url.hash) return undefined;
  const states = url.searchParams.getAll("state");
  const codes = url.searchParams.getAll("code");
  if (states.length !== 1 || states[0] !== expectedState || codes.length !== 1 || !codes[0] ||
      codes[0].length > 4096 || url.searchParams.has("error")) return undefined;

  const callback = new URL(CALLBACK_PATH, CALLBACK_ORIGIN);
  callback.searchParams.set("code", codes[0]);
  callback.searchParams.set("state", states[0]);
  return callback;
}

export async function finishBrowserLogin(callback: URL, signal: AbortSignal): Promise<boolean> {
  const options = { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) } as const;
  const response = await fetch(callback, options);
  const location = response.headers.get("location");
  await response.body?.cancel();
  if (response.ok && !location) return true;
  if (response.status !== 302 || !location) return false;

  // Some CLI versions wait for the success page to be fetched before exiting.
  const success = URL.parse(location, CALLBACK_ORIGIN);
  if (success?.origin === AUTH_ORIGIN) return true;
  if (!success || (success.origin !== CALLBACK_ORIGIN && success.origin !== "http://localhost:1455") ||
      success.pathname !== "/success" || success.username || success.password) return false;
  const localSuccess = new URL(success.pathname + success.search, CALLBACK_ORIGIN);
  const result = await fetch(localSuccess, options);
  await result.body?.cancel();
  return result.ok;
}
