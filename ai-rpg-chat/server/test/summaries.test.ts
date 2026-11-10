import { describe, it, expect, beforeEach } from "vitest";
import { openCampaignStore, type CampaignStore } from "../src/campaign/store.js";
import type { AppendableEvent } from "../src/campaign/events.js";
import { createGameMaster } from "../src/game-master/game-master.js";
import { createSummarizer } from "../src/memory/summarizer.js";
import { testCampaignStart } from "./support/fixtures.js";
import { scriptedModel } from "./support/scripted-model.js";

let store: CampaignStore;
let id: string;
beforeEach(() => {
  store = openCampaignStore(":memory:");
  id = store.createCampaign(testCampaignStart());
});

const turns = (from: number, count: number): AppendableEvent[] =>
  Array.from({ length: count }, (_, i) => [
    { type: "player_said" as const, text: `player move ${from + i}` },
    { type: "gm_narrated" as const, text: `narration ${from + i}` },
  ]).flat();

const options = { sceneEvery: 6, keepRecent: 2, chapterEvery: 2 };

describe("rolling summaries", () => {
  it("does nothing until enough unsummarized history piles up", async () => {
    store.append(id, turns(1, 2)); // 4 entries < 6
    const { provider, turns: calls } = scriptedModel();
    await createSummarizer({ store, model: provider, ...options }).maybeSummarize(id);
    expect(calls).toHaveLength(0);
  });

  it("summarizes older turns into a scene, keeping the most recent turns verbatim", async () => {
    store.append(id, turns(1, 3)); // 6 entries
    const { provider, turns: calls } = scriptedModel({ text: "Arin made moves 1 and 2." });

    await createSummarizer({ store, model: provider, ...options }).maybeSummarize(id);

    expect(calls[0]!.request.tier).toBe("fast");
    expect(calls[0]!.request.messages[0]!.text).toContain("player move 1");
    expect(calls[0]!.request.messages[0]!.text).not.toContain("player move 3");
    expect(store.state(id).summaries.scenes).toEqual([{ from: 0, to: 4, text: "Arin made moves 1 and 2." }]);
  });

  it("never splits a turn: a player's message and its narration land on the same side", async () => {
    store.append(id, turns(1, 3)); // entries 0..5; keeping 1 would cut after a player message
    const { provider } = scriptedModel({ text: "Moves 1 and 2." });

    await createSummarizer({ store, model: provider, sceneEvery: 6, keepRecent: 1 }).maybeSummarize(id);

    expect(store.state(id).summaries.scenes[0]).toMatchObject({ from: 0, to: 4 });
  });

  it("combines scenes into a chapter once enough scenes exist", async () => {
    const { provider } = scriptedModel({ text: "Scene A." }, { text: "Scene B." }, { text: "Chapter one: A then B." });
    const summarizer = createSummarizer({ store, model: provider, ...options });
    store.append(id, turns(1, 3));
    await summarizer.maybeSummarize(id);
    store.append(id, turns(4, 2));
    await summarizer.maybeSummarize(id);

    expect(store.state(id).summaries.chapters).toEqual([{ fromScene: 0, toScene: 2, text: "Chapter one: A then B." }]);
  });

  it("the Game Master gets the summaries plus only the turns after them", async () => {
    store.append(id, [...turns(1, 2), { type: "scene_summarized", from: 0, to: 4, text: "Arin explored the docks." }, ...turns(3, 1)]);
    const { provider, turns: calls } = scriptedModel({ text: "On you go." });
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await gm.takeTurn(id, "Next.");

    const req = calls[0]!.request;
    expect(req.system).toContain("Arin explored the docks.");
    const history = req.messages.map((m) => m.text).join("\n");
    expect(history).toContain("player move 3");
    expect(history).not.toContain("player move 1");
  });

  it("summaries are searchable by recall", async () => {
    store.append(id, [{ type: "scene_summarized", from: 0, to: 0, text: "Arin swore an oath to the river spirit." }]);
    expect((await store.search(id, "oath"))[0]).toMatchObject({ kind: "scene_summarized" });
  });
});
