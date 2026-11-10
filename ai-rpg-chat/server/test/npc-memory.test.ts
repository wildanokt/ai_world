import { describe, it, expect, beforeEach } from "vitest";
import { openCampaignStore, type CampaignStore } from "../src/campaign/store.js";
import { createGameMaster } from "../src/game-master/game-master.js";
import { testCampaignStart } from "./support/fixtures.js";
import { scriptedModel } from "./support/scripted-model.js";

let store: CampaignStore;
let campaignId: string;
beforeEach(() => {
  store = openCampaignStore(":memory:");
  campaignId = store.createCampaign(testCampaignStart());
});

const fullContext = (req: { system: string; messages: { text: string }[] }) =>
  [req.system, ...req.messages.map((m) => m.text)].join("\n");

describe("NPC Memory", () => {
  it("an NPC remembers what it witnessed, and the memory is in context on later turns", async () => {
    const { provider, turns } = scriptedModel(
      { toolCalls: [{ name: "remember", input: { characterId: "bram", note: "Arin paid for a round for the whole tavern." } }] },
      { text: "Cheers erupt." },
      { text: "Bram smiles at you." },
    );
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await gm.takeTurn(campaignId, "Drinks on me!");
    await gm.takeTurn(campaignId, "I wave at Bram.");

    expect(store.state(campaignId).characters.bram!.memories).toEqual(["Arin paid for a round for the whole tavern."]);
    expect(turns[1]!.request.messages.at(-1)!.text).toContain("Arin paid for a round");
  });

  it("relationships move with the player's actions and stay between -10 and +10", async () => {
    const { provider, turns } = scriptedModel(
      {
        toolCalls: [
          { name: "adjust_relationship", input: { characterId: "bram", delta: 3, reason: "saved his tavern" } },
          { name: "adjust_relationship", input: { characterId: "bram", delta: 3, reason: "paid his debt" } },
          { name: "adjust_relationship", input: { characterId: "bram", delta: 3, reason: "fixed his roof" } },
          { name: "adjust_relationship", input: { characterId: "bram", delta: 3, reason: "found his daughter" } },
        ],
      },
      { text: "Bram would die for you." },
    );
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await gm.takeTurn(campaignId, "I do everything for Bram.");

    expect(JSON.parse(turns[0]!.toolResults[3]!.result.content)).toMatchObject({ relationship: 10 });
    expect(store.state(campaignId).characters.bram!.relationship).toBe(10);
  });

  it("only NPCs keep memories and relationships, not the Player Character", async () => {
    const { provider, turns } = scriptedModel(
      {
        toolCalls: [
          { name: "remember", input: { characterId: "pc", note: "I am great." } },
          { name: "adjust_relationship", input: { characterId: "pc", delta: 1, reason: "self-love" } },
        ],
      },
      { text: "..." },
    );
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await gm.takeTurn(campaignId, "I admire myself.");

    expect(turns[0]!.toolResults.map((r) => r.result.isError)).toEqual([true, true]);
  });

  it("NPCs elsewhere are listed but their profile and memories are not loaded", async () => {
    store.append(campaignId, [
      { type: "npc_remembered", characterId: "bram", note: "Arin broke a chair." },
      { type: "moved", characterId: "bram", to: "cellar" },
    ]);
    const { provider, turns } = scriptedModel({ text: "The tavern is quiet." });
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await gm.takeTurn(campaignId, "I look around.");

    const context = fullContext(turns[0]!.request);
    expect(context).toMatch(/Bram.*cellar/);
    expect(context).not.toContain("smuggler's tunnel");
    expect(context).not.toContain("broke a chair");
  });
});
