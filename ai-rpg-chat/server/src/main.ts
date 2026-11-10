import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bodyLimit } from "hono/body-limit";
import { portraitType, portraits } from "./world/portraits.js";
import { type AppendableEvent } from "./campaign/events.js";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { openCampaignStore } from "./campaign/store.js";
import { createGameMaster } from "./game-master/game-master.js";
import { codexCli, createCodexProvider, MODEL } from "./model/codex.js";
import { createCodexAuth, runCodexAuth } from "./model/codex-auth.js";
import { createOpenAIEmbedder } from "./memory/embedder.js";
import { createSummarizer } from "./memory/summarizer.js";
import { randomD20 } from "./rules/checks.js";
import { DEFAULT_WORLD } from "./world/default-world.js";
import { createDrafter, DraftFailed } from "./world/drafts.js";
import { campaignStartFrom, CharacterProfileSchema, WorldInvalid } from "./world/world.js";
import { openWorldStore, WorldNotFound } from "./world/world-store.js";

const DATA_DIR = process.env.RPG_DATA_DIR ?? fileURLToPath(new URL("../../data/", import.meta.url));
mkdirSync(DATA_DIR, { recursive: true });

const embedder = process.env.OPENAI_API_KEY
  ? createOpenAIEmbedder({ apiKey: process.env.OPENAI_API_KEY, model: process.env.EMBEDDING_MODEL })
  : undefined;
console.log(`Recall: ${embedder ? `keywords + semantic (${embedder.model})` : "keywords only (set OPENAI_API_KEY for semantic)"}`);
const store = openCampaignStore(join(DATA_DIR, "game.db"), { embedder });
const worlds = openWorldStore(join(DATA_DIR, "game.db"));
if (worlds.list().length === 0) worlds.create(DEFAULT_WORLD);

const Effort = z.enum(["none", "low", "medium", "high"]);
const Settings = z.object({ fast: Effort, strong: Effort });
const settingsPath = join(DATA_DIR, "ai-settings.json");
let settings = Settings.parse({
  fast: process.env.CODEX_EFFORT_FAST ?? "low",
  strong: process.env.CODEX_EFFORT_STRONG ?? "medium",
});
try { settings = Settings.parse(JSON.parse(readFileSync(settingsPath, "utf8"))); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const codexBin = process.env.CODEX_BIN ?? (process.platform === "win32" ? "codex.exe" : "codex");
const codexAuth = createCodexAuth((command) => runCodexAuth(codexBin, command));
const model = createCodexProvider({
  invoke: codexCli(codexBin),
  effort: (tier) => settings[tier],
});
console.log(`AI engine: Codex CLI (${MODEL})`);
const gm = createGameMaster({ store, model, d20: randomD20() });
const drafter = createDrafter({ model });
const summarizer = createSummarizer({ store, model });

/** Background upkeep after a turn: summaries and embeddings. Failures never affect play. */
function afterTurn(campaignId: string) {
  summarizer.maybeSummarize(campaignId).catch((err) => console.error("Summary failed:", err));
  store.embedPending().catch((err) => console.error("Embedding failed:", err));
}
afterTurn.startup = () => store.embedPending().catch((err) => console.error("Embedding failed:", err));
afterTurn.startup();

const app = new Hono();
const turnsInProgress = new Set<string>();
const port = Number(process.env.PORT ?? 8787);
app.use("/api/*", async (c, next) => {
  const host = c.req.header("host");
  const origin = c.req.header("origin");
  const validHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!host || !validHosts.includes(host) ||
      (origin && ![...validHosts, "127.0.0.1:5173", "localhost:5173"].some((allowed) => origin === `http://${allowed}`))) {
    return c.json({ error: "Local access only." }, 403);
  }
  await next();
});

/** Known domain errors become clean HTTP errors; anything else is a 500. */
app.onError((err, c) => {
  if (err instanceof WorldInvalid || err instanceof BadRequest) return c.json({ error: err.message }, 400);
  if (err instanceof WorldNotFound) return c.json({ error: err.message }, 404);
  if (err instanceof DraftFailed) return c.json({ error: err.message }, 502);
  console.error(err);
  return c.json({ error: err.message || "Something went wrong." }, 500);
});

class BadRequest extends Error {}
async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new BadRequest(z.prettifyError(parsed.error));
  return parsed.data;
}

// --- Worlds (God Console) ---------------------------------------------------------------

app.get("/api/worlds", (c) => c.json(worlds.list()));
app.get("/api/worlds/:id", (c) => c.json(worlds.get(c.req.param("id"))));
app.post("/api/worlds", async (c) => c.json(worlds.create(await c.req.json().catch(() => null)), 201));
app.put("/api/worlds/:id", async (c) => c.json(worlds.update(c.req.param("id"), await c.req.json().catch(() => null))));
app.delete("/api/worlds/:id", (c) => {
  if (worlds.list().length <= 1) throw new BadRequest("The last World cannot be deleted.");
  worlds.remove(c.req.param("id"));
  return c.body(null, 204);
});

// --- Drafts -----------------------------------------------------------------------------

const Keywords = z.string().trim().min(1, "Enter a few keywords.").max(500);

app.post("/api/drafts/world", async (c) => {
  const { keywords } = await body(c, z.object({ keywords: Keywords }));
  return c.json(await drafter.draftWorld(keywords));
});

const DraftContextBody = z.object({
  name: z.string().default(""),
  premise: z.string().default(""),
  tone: z.string().default(""),
  startingLocation: z.string().default(""),
  locations: z.array(z.object({ name: z.string(), description: z.string().default("") })).default([]),
  characters: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(["player", "npc"]) })).default([]),
});

app.post("/api/drafts/character", async (c) => {
  const { keywords, role, world } = await body(
    c,
    z.object({ keywords: Keywords, role: z.enum(["player", "npc"]), world: DraftContextBody }),
  );
  return c.json(await drafter.draftCharacter(keywords, { world, role }));
});

// --- Campaigns --------------------------------------------------------------------------

const view = (id: string) => {
  const state = store.state(id);
  return {
    id, transcript: store.transcript(id),
    state: {
      ...state,
      world: { id: state.world.id, name: state.world.name },
      characters: Object.fromEntries(Object.entries(state.characters).map(([key, { profile, memories, routine, ...character }]) => [key, character])),
    },
  };
};

const imageStore = portraits(join(DATA_DIR, "portraits"));
app.get("/api/portraits/:id", async (c) => {
  const bytes = await imageStore.load(c.req.param("id"));
  const type = bytes && portraitType(bytes);
  if (!bytes || !type) return c.json({ error: "Portrait not found." }, 404);
  return new Response(new Uint8Array(bytes), { headers: {
    "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=31536000, immutable",
  } });
});
app.post("/api/portraits", bodyLimit({ maxSize: 5 * 1024 * 1024 }), async (c) => {
  const id = await imageStore.save(Buffer.from(await c.req.arrayBuffer()));
  if (!id) throw new BadRequest("Choose a PNG, JPEG or WebP image up to 5 MB.");
  return c.json({ id }, 201);
});
app.post("/api/portraits/generate", async (c) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new BadRequest("Set OPENAI_API_KEY on the server to generate portraits.");
  const { keywords } = await body(c, z.object({ keywords: Keywords }));
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.PORTRAIT_MODEL ?? "gpt-image-2", prompt: `RPG character portrait, bust composition: ${keywords}`, size: "1024x1024", output_format: "webp", quality: "medium" }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) return c.json({ error: `Portrait generation failed (HTTP ${response.status}).` }, 502);
  const encoded = z.object({ data: z.array(z.object({ b64_json: z.string() })).min(1) }).parse(await response.json()).data[0]!.b64_json;
  const id = await imageStore.save(Buffer.from(encoded, "base64"));
  if (!id) return c.json({ error: "The image service returned an invalid portrait." }, 502);
  return c.json({ id }, 201);
});

app.get("/api/ai/codex-auth", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await codexAuth.status());
});
app.post("/api/ai/codex-auth", (c) => {
  if (!c.req.header("origin") || c.req.header("content-type") !== "application/json") {
    return c.json({ error: "Open the local game to start Codex login." }, 403);
  }
  if (!codexAuth.start()) return c.json({ error: "Codex login is already in progress." }, 409);
  return c.json({ login: "pending" }, 202);
});

app.get("/api/ai/settings", (c) => c.json({ model: MODEL, ...settings }));
app.put("/api/ai/settings", async (c) => {
  const next = await body(c, Settings);
  writeFileSync(settingsPath + ".tmp", JSON.stringify(next), "utf8");
  renameSync(settingsPath + ".tmp", settingsPath);
  settings = next;
  return c.json({ model: MODEL, ...settings });
});

app.get("/api/campaigns/:id/timeline", (c) => c.json(store.timeline(c.req.param("id"))));
app.get("/api/campaigns/:id/inspector", (c) => c.json(store.inspect(c.req.param("id"))));
app.post("/api/campaigns/:id/snapshots", async (c) => {
  const id = c.req.param("id");
  const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
  if (turnsInProgress.has(id)) return c.json({ error: "A turn is in progress." }, 409);
  store.state(id);
  return c.json(store.snapshot(id, name), 201);
});
app.post("/api/campaigns/:id/rewind", async (c) => {
  const id = c.req.param("id");
  const { snapshotId } = await body(c, z.object({ snapshotId: z.string() }));
  if (turnsInProgress.has(id)) return c.json({ error: "A turn is in progress." }, 409);
  const next = store.rewind(id, snapshotId);
  if (!next) return c.json({ error: "Snapshot not found." }, 404);
  afterTurn.startup();
  return c.json(view(next), 201);
});

const LiveEdit = z.object({
  hp: z.number().int().min(0).max(999),
  maxHp: CharacterProfileSchema.shape.maxHp,
  skills: CharacterProfileSchema.shape.skills,
  portrait: CharacterProfileSchema.shape.portrait.nullable(),
  silent: z.boolean(),
  effect: z.enum(["blessing", "curse"]),
});

app.patch("/api/campaigns/:id/characters/:characterId", async (c) => {
  const id = c.req.param("id");
  const characterId = c.req.param("characterId");
  const { silent, effect, portrait, ...stats } = await body(c, LiveEdit);
  if (stats.hp > stats.maxHp) throw new BadRequest("HP cannot exceed maximum HP.");
  if (turnsInProgress.has(id)) return c.json({ error: "A turn is in progress." }, 409);
  const state = store.state(id);
  const character = Object.hasOwn(state.characters, characterId) ? state.characters[characterId] : undefined;
  if (!character) return c.json({ error: "Character not found." }, 404);
  turnsInProgress.add(id);
  try {
    const condition = stats.hp > 0 ? null : character.condition ?? ({
      deadly: "dead", standard: "dying", forgiving: "down",
    } as const)[state.world.lethality];
    const events: AppendableEvent[] = [{ type: "character_edited", characterId, patch: { ...stats, portrait, condition } }];
    if (!silent) {
      const label = effect === "curse" ? "God's Curse" : "God's Blessing";
      const response = await model.runTurn({
        tier: "fast", maxModelCalls: 1, tools: [],
        system: "You are the Game Master. Narrate this divine edit in one or two sentences in the player's recent language. Do not change anything else.",
        messages: [{ role: "user", text: JSON.stringify({
          effect: label, character: character.name, before: { hp: character.hp, maxHp: character.maxHp, skills: character.skills },
          after: stats, recent: store.transcript(id).filter((entry) => entry.kind === "player").slice(-1),
        }) }],
      });
      events.push({ type: "gm_narrated", text: response.text.trim() || `${character.name} is touched by ${label}.` });
      if (response.usage) events.push({ type: "ai_used", usage: response.usage });
      if (response.trace) events.push({ type: "ai_inspected", trace: response.trace });
    }
    store.append(id, events);
    afterTurn(id);
    return c.json(view(id));
  } finally { turnsInProgress.delete(id); }
});

app.post("/api/campaigns", async (c) => {
  const { worldId } = (await body(c, z.object({ worldId: z.string().optional() }).nullable())) ?? {};
  const world = worlds.get(worldId ?? worlds.list()[0]!.id);
  return c.json(view(store.createCampaign(campaignStartFrom(world))));
});

app.get("/api/campaigns/:id", (c) => {
  try {
    return c.json(view(c.req.param("id")));
  } catch {
    return c.json({ error: "Campaign not found" }, 404);
  }
});

const TurnBody = z.object({ text: z.string().trim().min(1).max(4000) });

app.post("/api/campaigns/:id/turns", async (c) => {
  const id = c.req.param("id");
  const parsed = TurnBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Message text is required" }, 400);
  try {
    store.state(id);
  } catch {
    return c.json({ error: "Campaign not found" }, 404);
  }
  if (turnsInProgress.has(id)) return c.json({ error: "A turn is already in progress" }, 409);

  turnsInProgress.add(id);
  return streamSSE(c, async (stream) => {
    try {
      await gm.takeTurn(id, parsed.data.text, {
        onText: (delta) => void stream.writeSSE({ event: "text", data: JSON.stringify(delta) }),
      });
      await stream.writeSSE({ event: "done", data: JSON.stringify(view(id)) });
      afterTurn(id);
    } catch (err) {
      console.error(err);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: err instanceof Error ? err.message : "The Game Master stumbled." }),
      });
    } finally {
      turnsInProgress.delete(id);
    }
  });
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => console.log(`AI RPG server on http://localhost:${port}`));
