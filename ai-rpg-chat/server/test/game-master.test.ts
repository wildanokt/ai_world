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

describe("Game Master turn", () => {
  it("records the player's message and the narration, and streams the narration", async () => {
    const { provider } = scriptedModel({ text: "The tavern smells of ale and smoke." });
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });
    const streamed: string[] = [];

    const result = await gm.takeTurn(campaignId, "I walk in.", { onText: (t) => streamed.push(t) });

    expect(result.narration).toBe("The tavern smells of ale and smoke.");
    expect(streamed.join("")).toBe("The tavern smells of ale and smoke.");
    expect(store.transcript(campaignId)).toEqual([
      { kind: "player", text: "I walk in." },
      { kind: "gm", text: "The tavern smells of ale and smoke." },
    ]);
  });
});

describe("skill checks", () => {
  it("rolls the die in code, records the roll, and feeds the result back to the model", async () => {
    const { provider, turns } = scriptedModel(
      {
        toolCalls: [
          { name: "skill_check", input: { characterId: "pc", reason: "Stealth", modifier: 2, difficulty: 15 } },
        ],
      },
      { text: "You slip past the guard unseen." },
    );
    const gm = createGameMaster({ store, model: provider, d20: () => 14 });

    await gm.takeTurn(campaignId, "I sneak past the guard.");

    const [check] = turns[0]!.toolResults;
    expect(check!.result.isError).toBe(false);
    expect(JSON.parse(check!.result.content)).toMatchObject({ roll: 14, total: 16, success: true });
    expect(store.transcript(campaignId)).toEqual([
      { kind: "player", text: "I sneak past the guard." },
      { kind: "roll", characterId: "pc", reason: "Stealth", roll: 14, total: 16, difficulty: 15, success: true, critical: null },
      { kind: "gm", text: "You slip past the guard unseen." },
    ]);
  });

  it("uses the character's own skill modifier when the check names one of their skills", async () => {
    const { provider, turns } = scriptedModel(
      {
        toolCalls: [
          { name: "skill_check", input: { characterId: "pc", reason: "Sneak", skill: "stealth", modifier: 0, difficulty: 15 } },
          { name: "skill_check", input: { characterId: "pc", reason: "Climb", skill: "Athletics", modifier: 1, difficulty: 15 } },
        ],
      },
      { text: "You creep along, then scramble up the wall." },
    );
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await gm.takeTurn(campaignId, "I sneak and climb.");

    const [sneak, climb] = turns[0]!.toolResults.map((r) => JSON.parse(r.result.content));
    expect(sneak).toMatchObject({ total: 14, modifier: 4 }); // Arin's Stealth +4
    expect(climb).toMatchObject({ total: 11, modifier: 1 }); // no Athletics skill: the given modifier
  });
});

describe("state changes proposed by the Game Master", () => {
  it("applies valid changes to the campaign state", async () => {
    const { provider } = scriptedModel(
      {
        toolCalls: [
          { name: "apply_damage", input: { characterId: "pc", amount: 6 } },
          { name: "give_item", input: { characterId: "pc", item: "rusty key", quantity: 1 } },
          { name: "move_character", input: { characterId: "pc", to: "cellar" } },
        ],
      },
      { text: "A rat bites you as you grab the key and descend." },
    );
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await gm.takeTurn(campaignId, "I grab the key and head down.");

    const pc = store.state(campaignId).characters.pc!;
    expect(pc.hp).toBe(14);
    expect(pc.inventory).toEqual({ "short sword": 1, "rusty key": 1 });
    expect(pc.location).toBe("cellar");
  });

  it("refuses to take an item the character does not have, and tells the model why", async () => {
    const { provider, turns } = scriptedModel(
      { toolCalls: [{ name: "take_item", input: { characterId: "pc", item: "gold crown", quantity: 1 } }] },
      { text: "You pat your pockets, but there is no crown." },
    );
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await gm.takeTurn(campaignId, "I hand over the gold crown.");

    expect(turns[0]!.toolResults[0]!.result).toMatchObject({
      isError: true,
      content: expect.stringContaining("has 0"),
    });
    expect(store.state(campaignId).characters.pc!.inventory).toEqual({ "short sword": 1 });
  });

  it("refuses changes to characters that do not exist", async () => {
    const { provider, turns } = scriptedModel(
      { toolCalls: [{ name: "heal", input: { characterId: "ghost", amount: 5 } }] },
      { text: "Nothing happens." },
    );
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await gm.takeTurn(campaignId, "I heal the ghost.");

    expect(turns[0]!.toolResults[0]!.result).toMatchObject({
      isError: true,
      content: expect.stringContaining("No character"),
    });
  });

  it("a later tool call in the same turn sees the effects of earlier ones", async () => {
    const { provider, turns } = scriptedModel(
      {
        toolCalls: [
          { name: "give_item", input: { characterId: "pc", item: "apple", quantity: 1 } },
          { name: "take_item", input: { characterId: "pc", item: "apple", quantity: 1 } },
        ],
      },
      { text: "You pocket the apple, then eat it." },
    );
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await gm.takeTurn(campaignId, "I take an apple and eat it.");

    expect(turns[0]!.toolResults.map((r) => r.result.isError)).toEqual([false, false]);
    expect(store.state(campaignId).characters.pc!.inventory).toEqual({ "short sword": 1 });
  });
});

describe("what the Game Master is told", () => {
  it("each turn includes earlier conversation, the World, and the current state", async () => {
    const { provider, turns } = scriptedModel({ text: "A bard waves at you." }, { text: "The bard grins." });
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });
    await gm.takeTurn(campaignId, "I enter.");
    store.append(campaignId, [{ type: "damage_taken", characterId: "pc", amount: 3 }]);

    await gm.takeTurn(campaignId, "I wave back.");

    const second = turns[1]!.request;
    expect(second.system).toContain("Eldoria");
    expect(second.messages.slice(0, 2)).toEqual([
      { role: "user", text: "I enter." },
      { role: "assistant", text: "A bard waves at you." },
    ]);
    const current = second.messages.at(-1)!;
    expect(current.role).toBe("user");
    expect(current.text).toContain("I wave back.");
    expect(current.text).toContain('"hp":17');
  });

  it("the Game Master knows the World's premise, tone, lethality and each NPC's profile", async () => {
    const { provider, turns } = scriptedModel({ text: "Bram nods." });
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await gm.takeTurn(campaignId, "I greet Bram.");

    const req = turns[0]!.request;
    const system = [req.system, ...req.messages.map((m) => m.text)].join("\n");
    expect(system).toContain("A kingdom recovering from a long war.");
    expect(system).toContain("hopeful, low magic");
    expect(system).toContain("no graphic gore");
    expect(system).toMatch(/lethality/i);
    expect(system).toContain("gruff but kind");
    expect(system).toContain("smuggler's tunnel");
    expect(system).toContain("Stealth +4");
  });
});

describe("runaway tool use", () => {
  it("caps model calls and still ends the turn with narration", async () => {
    const endless = Array.from({ length: 20 }, () => ({
      toolCalls: [{ name: "skill_check", input: { characterId: "pc", reason: "Search", modifier: 0, difficulty: 10 } }],
    }));
    const { provider, turns } = scriptedModel(...endless);
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    const result = await gm.takeTurn(campaignId, "I search everywhere.");

    expect(turns[0]!.modelCalls).toBeLessThan(20);
    expect(result.narration.length).toBeGreaterThan(0);
    expect(store.transcript(campaignId).at(-1)).toMatchObject({ kind: "gm" });
  });
});

describe("failed turns", () => {
  it("a turn whose model call fails leaves the campaign exactly as it was", async () => {
    const { provider } = scriptedModel(
      { toolCalls: [{ name: "apply_damage", input: { characterId: "pc", amount: 5 } }] },
      { throws: new Error("network down") },
    );
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });

    await expect(gm.takeTurn(campaignId, "I attack the troll.")).rejects.toThrow("network down");

    expect(store.transcript(campaignId)).toEqual([]);
    expect(store.state(campaignId).characters.pc!.hp).toBe(20);
  });
});
