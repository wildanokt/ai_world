import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCampaignStore } from "../src/campaign/store.js";
import { createGameMaster } from "../src/game-master/game-master.js";
import type { Embedder } from "../src/memory/embedder.js";
import { testCampaignStart } from "./support/fixtures.js";
import { scriptedModel } from "./support/scripted-model.js";

const story = [
  { type: "player_said", text: "I search the old well." },
  { type: "gm_narrated", text: "At the bottom you find a tarnished silver key bearing a raven crest." },
  { type: "player_said", text: "I head to the market." },
  { type: "gm_narrated", text: "The market is loud with fishmongers and spice sellers." },
] as const;

function campaignWithStory(embedder?: Embedder) {
  const store = openCampaignStore(":memory:", { embedder });
  const id = store.createCampaign(testCampaignStart());
  store.append(id, [...story]);
  return { store, id };
}

describe("Recall: searching the full history", () => {
  it("finds an old detail by keywords, best match first", async () => {
    const { store, id } = campaignWithStory();

    const hits = await store.search(id, "silver key");

    expect(hits[0]).toMatchObject({ kind: "gm_narrated", text: expect.stringContaining("silver key") });
  });

  it("handles questions with punctuation, and returns nothing for no match", async () => {
    const { store, id } = campaignWithStory();
    expect((await store.search(id, "what's that raven-crest key?!"))[0]?.text).toContain("raven crest");
    expect(await store.search(id, "dragon")).toEqual([]);
    expect(await store.search(id, "?!")).toEqual([]);
  });

  it("only searches the campaign it is asked about", async () => {
    const { store } = campaignWithStory();
    const other = store.createCampaign(testCampaignStart());
    expect(await store.search(other, "silver key")).toEqual([]);
  });

  it("indexes NPC memories too", async () => {
    const { store, id } = campaignWithStory();
    store.append(id, [{ type: "npc_remembered", characterId: "bram", note: "Arin asked about smuggling routes." }]);
    expect((await store.search(id, "smuggling"))[0]).toMatchObject({ kind: "npc_remembered", text: expect.stringContaining("Bram") });
  });

  it("history written before the index existed is indexed when the database is opened", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "rpg-")), "game.db");
    const first = openCampaignStore(file);
    const id = first.createCampaign(testCampaignStart());
    first.append(id, [...story]);
    first.close();
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE search_fts; DROP TABLE search_docs;");
    raw.close();

    const reopened = openCampaignStore(file);
    expect((await reopened.search(id, "silver key"))[0]?.text).toContain("silver key");
    reopened.close();
  });
});

/** Fake embedder: words map onto shared "concept" axes, so synonyms land close together. */
const CONCEPTS = [
  ["key", "lock", "unlock", "opener"],
  ["well", "shaft", "pit"],
  ["market", "bazaar", "shop", "merchant"],
  ["fish", "fishmongers", "seafood"],
];
const fakeEmbedder: Embedder = {
  model: "fake-concepts",
  dimensions: CONCEPTS.length,
  async embed(texts) {
    return texts.map((t) => {
      const words = t.toLowerCase().match(/\p{L}+/gu) ?? [];
      const v = new Float32Array(CONCEPTS.length);
      CONCEPTS.forEach((group, i) => (v[i] = words.filter((w) => group.includes(w)).length));
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  },
};

describe("Recall with semantic search", () => {
  it("finds history by meaning, even with no shared keywords", async () => {
    const { store, id } = campaignWithStory(fakeEmbedder);
    await store.embedPending();

    const hits = await store.search(id, "bazaar");

    expect(hits[0]?.text).toContain("market");
  });

  it("still finds keyword matches that have not been embedded yet", async () => {
    const { store, id } = campaignWithStory(fakeEmbedder);
    expect((await store.search(id, "raven"))[0]?.text).toContain("raven crest");
  });
});

describe("the Game Master's recall tool", () => {
  it("returns matching history to the model without changing the campaign", async () => {
    const { store, id } = campaignWithStory();
    const before = store.transcript(id).length;
    const { provider, turns } = scriptedModel(
      { toolCalls: [{ name: "recall", input: { query: "key from the well" } }] },
      { text: "You remember the silver key." },
    );
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await gm.takeTurn(id, "What did I find in the well?");

    const result = turns[0]!.toolResults[0]!.result;
    expect(result.isError).toBe(false);
    expect(result.content).toContain("silver key");
    expect(store.transcript(id).length).toBe(before + 2);
  });
});
