import { campaignStartFrom, parseWorld, type World } from "../../src/world/world.js";

/** A small valid World: Arin (player) and Bram the barkeep (NPC) in Eldoria. */
export function testWorld(overrides: Partial<World> = {}): World {
  return {
    id: "w1",
    ...parseWorld({
      name: "Eldoria",
      premise: "A kingdom recovering from a long war.",
      tone: "hopeful, low magic",
      contentLimits: "no graphic gore",
      lethality: "standard",
      startingLocation: "tavern",
      locations: [
        { name: "tavern", description: "The Gilded Tankard.", links: ["cellar"] },
        { name: "cellar", description: "Damp and dark." },
      ],
      characters: [
        { id: "pc", name: "Arin", role: "player", maxHp: 20, inventory: { "short sword": 1 }, skills: { Stealth: 4 } },
        {
          id: "bram",
          name: "Bram",
          role: "npc",
          maxHp: 12,
          personality: "gruff but kind",
          goals: "keep the tavern afloat",
          secrets: "hides a smuggler's tunnel under the cellar",
        },
      ],
    }),
    ...overrides,
  };
}

export const testCampaignStart = () => campaignStartFrom(testWorld());
