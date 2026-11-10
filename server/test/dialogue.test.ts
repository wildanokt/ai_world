import { expect, it } from "vitest";
import { openCampaignStore } from "../src/campaign/store.js";
import { createGameMaster } from "../src/game-master/game-master.js";
import { scriptedModel } from "./support/scripted-model.js";
import { testCampaignStart } from "./support/fixtures.js";

it("keeps one copy of each NPC line within a turn and honors multiple selected targets", async () => {
  const store = openCampaignStore(":memory:");
  try {
    const start = testCampaignStart();
    const bram = start.characters.find(({ id }) => id === "bram")!;
    start.characters.push({ ...bram, id: "selka", name: "Selka" }, { ...bram, id: "guest", name: "Guest" });
    const id = store.createCampaign(start);
    const say = (characterId: string, text: string) => ({ name: "npc_say", input: { characterId, text } });
    const model = scriptedModel(
      { toolCalls: [say("bram", "I saw it."), say("guest", "So did I.")] },
      { toolCalls: [say("bram", "I  saw it."), say("selka", "I saw it.")] },
      { text: "Selka: I saw it." },
      { toolCalls: [say("bram", "I saw it.")] },
      { text: "" },
    );
    const gm = createGameMaster({ store, model: model.provider, d20: () => 10 });
    await gm.takeTurn(id, "Who saw it?", { targetIds: ["bram", "selka", "bram"] });
    expect(model.turns[0]?.toolResults[1]?.result.isError).toBe(true);
    expect(store.transcript(id)).toEqual([
      { kind: "player", text: "Who saw it?", targets: [{ id: "bram", name: "Bram" }, { id: "selka", name: "Selka" }] },
      { kind: "npc", characterId: "bram", name: "Bram", text: "I saw it." },
      { kind: "npc", characterId: "selka", name: "Selka", text: "I saw it." },
    ]);
    await gm.takeTurn(id, "Bram, are you sure?");
    expect(store.transcript(id).at(-1)).toEqual({ kind: "npc", characterId: "bram", name: "Bram", text: "I saw it." });
  } finally { store.close(); }
});

it("rejects stale target selections before calling the model or saving the turn", async () => {
  const store = openCampaignStore(":memory:");
  try {
    const id = store.createCampaign(testCampaignStart());
    store.append(id, [{ type: "moved", characterId: "bram", to: "cellar" }]);
    const model = scriptedModel();
    const gm = createGameMaster({ store, model: model.provider, d20: () => 10 });
    await expect(gm.takeTurn(id, "Hello", { targetIds: ["bram"] })).rejects.toThrow("selected NPC");
    expect(model.turns).toHaveLength(0);
    expect(store.transcript(id)).toEqual([]);
  } finally { store.close(); }
});

it("records the addressed NPC as the speaker without adding an empty Game Master reply", async () => {
  const store = openCampaignStore(":memory:");
  try {
    const id = store.createCampaign(testCampaignStart());
    const model = scriptedModel({ toolCalls: [{ name: "npc_say", input: { characterId: "bram", text: "Of course." } }] }, { text: "" });
    await createGameMaster({ store, model: model.provider, d20: () => 10 }).takeTurn(id, "Bram, can you help me?");
    expect(store.transcript(id)).toEqual([
      { kind: "player", text: "Bram, can you help me?" },
      { kind: "npc", characterId: "bram", name: "Bram", text: "Of course." },
    ]);
    expect(await store.search(id, "Bram")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "npc_spoke" })]));
  } finally { store.close(); }
});

it("preserves action markers and routes explicit speech even when the model only returns text", async () => {
  const store = openCampaignStore(":memory:");
  try {
    const id = store.createCampaign(testCampaignStart());
    const model = scriptedModel({ text: "**The cup is lifted from the table.**" }, { text: "One silver." });
    const gm = createGameMaster({ store, model: model.provider, d20: () => 10 });
    await gm.takeTurn(id, "**I pick up the cup.**");
    expect(store.transcript(id).at(-1)).toEqual({ kind: "gm", text: "**The cup is lifted from the table.**" });
    const streamed: string[] = [];
    await gm.takeTurn(id, "Bram, how much for the cup?", { onText: (text) => streamed.push(text) });
    expect(streamed).toEqual([]);
    expect(store.transcript(id).at(-1)).toEqual({ kind: "npc", characterId: "bram", name: "Bram", text: "One silver." });
  } finally { store.close(); }
});

it("rejects speech from an absent NPC and keeps the response with the Game Master", async () => {
  const store = openCampaignStore(":memory:");
  try {
    const id = store.createCampaign(testCampaignStart());
    store.append(id, [{ type: "moved", characterId: "bram", to: "cellar" }]);
    const model = scriptedModel({ toolCalls: [{ name: "npc_say", input: { characterId: "bram", text: "Of course." } }] }, { text: "Bram is elsewhere." });
    await createGameMaster({ store, model: model.provider, d20: () => 10 }).takeTurn(id, "Bram, can you help me?");
    expect(model.turns[0]?.toolResults[0]?.result.isError).toBe(true);
    expect(store.transcript(id).at(-1)).toEqual({ kind: "gm", text: "Bram is elsewhere." });
  } finally { store.close(); }
});
