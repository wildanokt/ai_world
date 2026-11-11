import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Pool } from "pg";
import { z } from "zod";

const deriveKey = promisify(scrypt);
const cookie = "__Host-aiworld";
const sessionSeconds = 7 * 24 * 60 * 60;
const cookieOptions = { httpOnly: true, secure: true, sameSite: "Strict", path: "/" } as const;
const dummyHash = `${"0".repeat(32)}:${"0".repeat(64)}`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
const credentials = z.object({ email: emailSchema, password: z.string().min(1).max(256) });

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, salt, 32) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}

async function passwordMatches(password: string, hash: string) {
  const [salt, expected] = hash.split(":");
  if (!salt || !expected || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const key = await deriveKey(password, salt, 32) as Buffer;
  return timingSafeEqual(key, Buffer.from(expected, "hex"));
}

export function createLogin(pool?: Pool) {
  const routes = new Hono();
  const findSession = async (token?: string) => {
    if (!pool || !token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const { rows: [session] } = await pool.query<{ email: string }>(
      "SELECT email FROM app_sessions WHERE token_hash = $1 AND expires_at > now()", [digest(token)]);
    return session?.email;
  };

  routes.get("/session", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ required: !!pool, email: await findSession(getCookie(c, cookie)) ?? null });
  });
  routes.post("/login", bodyLimit({ maxSize: 4096 }), async (c) => {
    c.header("Cache-Control", "no-store");
    if (!pool) return c.json({ error: "Login is disabled." }, 404);
    const parsed = credentials.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a valid email and password." }, 400);
    const { email, password } = parsed.data;
    const ip = c.req.header("cf-connecting-ip") ?? "";
    const client = digest(isIP(ip) ? ip : "local");
    await pool.query("DELETE FROM app_login_limits WHERE expires_at <= now()");
    const { rows: [rate] } = await pool.query<{ attempts: number }>(`
      INSERT INTO app_login_limits VALUES ($1, 1, now() + interval '10 minutes')
      ON CONFLICT (client) DO UPDATE SET attempts = app_login_limits.attempts + 1
      WHERE app_login_limits.attempts < 12 RETURNING attempts
    `, [client]);
    if (!rate) return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    const { rows: [user] } = await pool.query<{ password_hash: string }>("SELECT password_hash FROM app_users WHERE email = $1", [email]);
    const matched = await passwordMatches(password, user?.password_hash ?? dummyHash);
    if (!user || !matched) return c.json({ error: "Incorrect email or password." }, 401);

    const token = randomBytes(32).toString("hex");
    await pool.query("DELETE FROM app_sessions WHERE expires_at <= now() OR token_hash = $1", [digest(getCookie(c, cookie) ?? "")]);
    await pool.query("INSERT INTO app_sessions VALUES ($1, $2, now() + $3 * interval '1 second')", [digest(token), email, sessionSeconds]);
    await pool.query("DELETE FROM app_login_limits WHERE client = $1", [client]);
    setCookie(c, cookie, token, { ...cookieOptions, maxAge: sessionSeconds });
    return c.json({ required: true, email });
  });
  routes.post("/logout", async (c) => {
    c.header("Cache-Control", "no-store");
    const token = getCookie(c, cookie);
    if (pool && token) await pool.query("DELETE FROM app_sessions WHERE token_hash = $1", [digest(token)]);
    deleteCookie(c, cookie, cookieOptions);
    return c.json({ required: !!pool, email: null });
  });

  const requireLogin: MiddlewareHandler = async (c, next) => {
    if (pool && !await findSession(getCookie(c, cookie))) {
      c.header("Cache-Control", "no-store");
      return c.json({ error: "Sign in to continue." }, 401);
    }
    await next();
    if (pool) c.header("Cache-Control", "private, no-store");
  };
  function sessionKey(c: Context) {
    const token = getCookie(c, cookie);
    return token ? digest(token) : undefined;
  }
  return { routes, requireLogin, sessionKey };
}
