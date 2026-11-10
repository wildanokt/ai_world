import { describe, it, expect } from "vitest";
import { createDrafter, DraftFailed } from "../src/world/drafts.js";
import { testWorld } from "./support/fixtures.js";
import { scriptedModel } from "./support/scripted-model.js";

const draftCharacter = (name: string) => ({
  name,
  description: "Tall, scarred, wears a grey cloak.",
  personality: "quiet and watchful",
  goals: "find her missing brother",
  secrets: "was once a royal spy",
  maxHp: 18,
  skills: [{ name: "Stealth", modifier: 3 }],
  location: "Harbor",
  inventory: [{ item: "dagger", quantity: 2 }],
});

const worldDraft = {
  name: "Saltmarch",
  premise: "Fog-bound port city ruled by merchant guilds.",
  tone: "noir, grim",
  contentLimits: "",
  lethality: "deadly",
  startingLocation: "Harbor",
  locations: [{ name: "Harbor", description: "Creaking docks." }],
  playerCharacter: draftCharacter("Mira"),
  npcs: [draftCharacter("Old Tom"), draftCharacter("Old Tom")],
};

describe("World Drafts", () => {
  it("turns keywords into a complete, valid World for review", async () => {
    const { provider, turns } = scriptedModel(
      { toolCalls: [{ name: "submit_world_draft", input: worldDraft }] },
      { text: "Here is your World." },
    );
    const drafter = createDrafter({ model: provider });

    const world = await drafter.draftWorld("fog, port city, guilds");

    expect(turns[0]!.request.tier).toBe("strong");
    expect(turns[0]!.request.messages[0]!.text).toContain("fog, port city, guilds");
    expect(world.name).toBe("Saltmarch");
    expect(world.characters.map((c) => [c.id, c.role])).toEqual([
      ["mira", "player"],
      ["old-tom", "npc"],
      ["old-tom-2", "npc"],
    ]);
    expect(world.characters[0]).toMatchObject({ skills: { Stealth: 3 }, inventory: { dagger: 2 } });
  });

  it("tells the AI what was wrong with an invalid draft so it can fix it", async () => {
    const { provider, turns } = scriptedModel(
      { toolCalls: [{ name: "submit_world_draft", input: { ...worldDraft, lethality: "brutal" } }] },
      { toolCalls: [{ name: "submit_world_draft", input: worldDraft }] },
      { text: "Fixed." },
    );
    const drafter = createDrafter({ model: provider });

    const world = await drafter.draftWorld("fog");

    expect(turns[0]!.toolResults[0]!.result).toMatchObject({ isError: true, content: expect.stringContaining("lethality") });
    expect(world.lethality).toBe("deadly");
  });

  it("fails clearly when the AI never submits a draft", async () => {
    const { provider } = scriptedModel({ text: "I would rather not." });
    const drafter = createDrafter({ model: provider });

    await expect(drafter.draftWorld("fog")).rejects.toThrow(DraftFailed);
  });
});

describe("Character Drafts", () => {
  it("drafts a character that fits the World and does not clash with existing ids", async () => {
    const { provider, turns } = scriptedModel(
      { toolCalls: [{ name: "submit_character_draft", input: draftCharacter("Bram") }] },
      { text: "Done." },
    );
    const drafter = createDrafter({ model: provider });

    const character = await drafter.draftCharacter("retired spy", { world: testWorld(), role: "npc" });

    const prompt = turns[0]!.request.messages[0]!.text;
    expect(prompt).toContain("retired spy");
    expect(prompt).toContain("Eldoria");
    expect(character).toMatchObject({ id: "bram-2", name: "Bram", role: "npc", maxHp: 18, secrets: "was once a royal spy" });
  });
});
