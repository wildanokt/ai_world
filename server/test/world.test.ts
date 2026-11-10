import { describe, it, expect } from "vitest";
import { campaignStartFrom, parseWorld, WorldInvalid } from "../src/world/world.js";
import { testWorld } from "./support/fixtures.js";

const pc = { id: "pc", name: "Arin", role: "player", maxHp: 20 };
const minimal = (characters: unknown[]) => ({ name: "Eldoria", startingLocation: "tavern", characters });

describe("World validation", () => {
  it("accepts a minimal World and fills in defaults", () => {
    const world = parseWorld(minimal([pc]));
    expect(world.lethality).toBe("standard");
    expect(world.locations).toEqual([]);
    expect(world.characters[0]).toMatchObject({ personality: "", secrets: "", skills: {}, inventory: {} });
  });

  it("needs exactly one Player Character", () => {
    expect(() => parseWorld(minimal([]))).toThrow(WorldInvalid);
    expect(() => parseWorld(minimal([pc, { ...pc, id: "pc2" }]))).toThrow(/exactly one Player Character/);
  });

  it("refuses two characters with the same id", () => {
    expect(() => parseWorld(minimal([pc, { id: "pc", name: "Bram", role: "npc", maxHp: 10 }]))).toThrow(/same id "pc"/);
  });

  it("explains invalid fields", () => {
    expect(() => parseWorld(minimal([{ ...pc, maxHp: 0 }]))).toThrow(/maxHp/);
  });
});

describe("starting a Campaign from a World", () => {
  it("everyone starts at full HP, at their own location or the World's starting location", () => {
    const start = campaignStartFrom(testWorld({ characters: [...testWorld().characters] }));
    const bram = start.characters.find((c) => c.id === "bram")!;

    expect(start.playerCharacterId).toBe("pc");
    expect(bram).toMatchObject({ hp: 12, maxHp: 12, location: "tavern", role: "npc" });
    expect(bram.profile.secrets).toContain("smuggler");
    expect(start.world).toMatchObject({ id: "w1", name: "Eldoria", lethality: "standard" });
  });

  it("the Campaign keeps its own copy, so later World edits do not leak in", () => {
    const world = testWorld();
    const start = campaignStartFrom(world);
    world.characters[0]!.inventory["short sword"] = 99;
    expect(start.characters[0]!.inventory["short sword"]).toBe(1);
  });
});
