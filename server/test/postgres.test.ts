import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createLogin, hashPassword } from "../src/auth/login.js";
import { openCampaignStore } from "../src/campaign/store.js";
import { importSqlite, openPostgres } from "../src/postgres.js";
import { openWorldStore } from "../src/world/world-store.js";
import { testCampaignStart, testWorld } from "./support/fixtures.js";

it.skipIf(!process.env.RPG_TEST_POSTGRES)("imports SQLite history, writes PostgreSQL events, and manages login sessions", async () => {
  const schema = "test_" + randomBytes(8).toString("hex");
  const admin = new Pool();
  const previousOptions = process.env.PGOPTIONS;
  const directory = mkdtempSync(join(tmpdir(), "ai-world-pg-"));
  const file = join(directory, "game.db");
  let close: (() => Promise<void>) | undefined;
  try {
    const sqliteWorlds = openWorldStore(file);
    const world = sqliteWorlds.create(testWorld());
    sqliteWorlds.close();
    const sqlite = openCampaignStore(file);
    const id = sqlite.createCampaign(testCampaignStart());
    sqlite.append(id, [{ type: "gm_narrated", text: "A silver key is under the well." }]);
    const snapshot = sqlite.snapshot(id, "The well");
    sqlite.close();

    await admin.query(`CREATE SCHEMA ${schema}`);
    process.env.PGOPTIONS = `-c search_path=${schema}`;
    const { store, worlds, pool } = await openPostgres(undefined, {
      model: "test", dimensions: 2,
      async embed(texts) {
        return texts.map((text) => /key|opener/i.test(text) ? new Float32Array([1, 0]) : new Float32Array([0, 1]));
      },
    });
    close = store.close;
    await importSqlite(pool, file);
    await importSqlite(pool, file);
    expect((await worlds.get(world.id)).name).toBe(world.name);
    expect((await store.timeline(id)).snapshots).toEqual([snapshot]);
    expect((await store.search(id, "silver"))[0]?.text).toContain("silver key");
    expect(await store.embedPending()).toBe(1);
    expect((await store.search(id, "opener"))[0]?.text).toContain("silver key");

    await Promise.all([
      store.append(id, [{ type: "player_said", text: "I take the key." }]),
      store.append(id, [{ type: "gm_narrated", text: "A bell rings." }]),
    ]);
    expect(await store.transcript(id)).toHaveLength(3);
    const branch = await store.rewind(id, snapshot.id);
    expect(await store.transcript(branch!)).toHaveLength(1);
    expect((await store.search(branch!, "silver"))[0]?.text).toContain("silver key");

    const email = "player@example.test";
    const password = "fixture-passphrase-only";
    await pool.query("INSERT INTO app_users VALUES ($1, $2)", [email, await hashPassword(password)]);
    const login = createLogin(pool);
    const app = new Hono();
    app.route("/auth", login.routes);
    app.use("/private", login.requireLogin);
    app.get("/private", (c) => c.text("ready"));
    expect((await app.request("/private")).status).toBe(401);
    const signIn = (password: string) => app.request("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
    });
    expect((await signIn("wrong-password")).status).toBe(401);
    const response = await signIn(password);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    const headers = { Cookie: cookie.split(";")[0]! };
    expect((await app.request("/private", { headers })).status).toBe(200);
    await app.request("/auth/logout", { method: "POST", headers });
    expect((await app.request("/private", { headers })).status).toBe(401);
  } finally {
    await close?.();
    if (previousOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previousOptions;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    rmSync(file, { force: true });
    rmdirSync(directory);
  }
}, 15_000);
