import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEvent } from "../src/campaign/events.js";
import { openCampaignStore, type CampaignStore } from "../src/campaign/store.js";
import { testCampaignStart } from "./support/fixtures.js";

let store: CampaignStore;
beforeEach(() => {
  store = openCampaignStore(":memory:");
});

describe("campaign store", () => {
  it("a new campaign starts with the World's characters", () => {
    const id = store.createCampaign(testCampaignStart());
    const state = store.state(id);
    expect(state.playerCharacterId).toBe("pc");
    expect(state.world.name).toBe("Eldoria");
    expect(state.characters.pc).toMatchObject({ name: "Arin", hp: 20, maxHp: 20, location: "tavern", inventory: { "short sword": 1 } });
    expect(state.characters.bram).toMatchObject({ role: "npc", hp: 12 });
  });

  it("campaigns saved before Worlds existed still load", () => {
    const state = applyEvent(null, {
      type: "campaign_started",
      worldName: "Eldoria",
      playerCharacter: { id: "pc", name: "Arin", hp: 20, maxHp: 20, location: "tavern", inventory: {} },
    });
    expect(state.world).toMatchObject({ id: null, name: "Eldoria", lethality: "standard" });
    expect(state.characters.pc).toMatchObject({ role: "player", skills: {}, profile: { secrets: "" } });
  });
});

describe("hit points", () => {
  it("keeps live character profile and placement changes when replaying the Campaign", () => {
    const store = openCampaignStore(":memory:");
    try {
      const id = store.createCampaign(testCampaignStart());
      store.append(id, [
        { type: "character_edited", characterId: "pc", patch: { name: "Rin", profile: {
          description: "A cartographer", personality: "Speaks briefly", goals: "", secrets: "",
        } } },
        { type: "moved", characterId: "bram", to: "cellar" },
      ]);
      expect(store.state(id).characters.pc).toMatchObject({ name: "Rin", hp: 20, profile: { personality: "Speaks briefly" } });
      expect(store.state(id).characters.bram?.location).toBe("cellar");
    } finally { store.close(); }
  });

  it("damage lowers HP and stops at zero", () => {
    const id = store.createCampaign(testCampaignStart());
    store.append(id, [{ type: "damage_taken", characterId: "pc", amount: 7 }]);
    expect(store.state(id).characters.pc?.hp).toBe(13);
    store.append(id, [{ type: "damage_taken", characterId: "pc", amount: 50 }]);
    expect(store.state(id).characters.pc?.hp).toBe(0);
  });

  it("healing raises HP and stops at max HP", () => {
    const id = store.createCampaign(testCampaignStart());
    store.append(id, [
      { type: "damage_taken", characterId: "pc", amount: 10 },
      { type: "healed", characterId: "pc", amount: 4 },
    ]);
    expect(store.state(id).characters.pc?.hp).toBe(14);
    store.append(id, [{ type: "healed", characterId: "pc", amount: 100 }]);
    expect(store.state(id).characters.pc?.hp).toBe(20);
  });
});

describe("inventory and location", () => {
  it("gaining and losing items adjusts quantities and drops empty stacks", () => {
    const id = store.createCampaign(testCampaignStart());
    store.append(id, [
      { type: "item_gained", characterId: "pc", item: "healing potion", quantity: 2 },
      { type: "item_lost", characterId: "pc", item: "short sword", quantity: 1 },
      { type: "item_lost", characterId: "pc", item: "healing potion", quantity: 1 },
    ]);
    expect(store.state(id).characters.pc?.inventory).toEqual({ "healing potion": 1 });
  });

  it("moving changes the character's location", () => {
    const id = store.createCampaign(testCampaignStart());
    store.append(id, [{ type: "moved", characterId: "pc", to: "market square" }]);
    expect(store.state(id).characters.pc?.location).toBe("market square");
  });
});

describe("transcript", () => {
  it("returns player and Game Master messages and rolls in order, ignoring state-only events", () => {
    const id = store.createCampaign(testCampaignStart());
    store.append(id, [
      { type: "player_said", text: "I look around the tavern." },
      { type: "check_rolled", characterId: "pc", reason: "Perception", roll: 14, total: 16, difficulty: 12, success: true, critical: null },
      { type: "moved", characterId: "pc", to: "bar" },
      { type: "gm_narrated", text: "You spot a hooded figure in the corner." },
    ]);
    expect(store.transcript(id)).toEqual([
      { kind: "player", text: "I look around the tavern." },
      { kind: "roll", characterId: "pc", reason: "Perception", roll: 14, total: 16, difficulty: 12, success: true, critical: null },
      { kind: "gm", text: "You spot a hooded figure in the corner." },
    ]);
  });
});

describe("durability", () => {
  it("a campaign's state and transcript survive reopening the database file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "rpg-")), "game.db");
    const first = openCampaignStore(file);
    const id = first.createCampaign(testCampaignStart());
    first.append(id, [
      { type: "player_said", text: "Hello?" },
      { type: "damage_taken", characterId: "pc", amount: 5 },
    ]);
    first.close();

    const reopened = openCampaignStore(file);
    expect(reopened.state(id).characters.pc?.hp).toBe(15);
    expect(reopened.transcript(id)).toEqual([{ kind: "player", text: "Hello?" }]);
    reopened.close();
  });
});
