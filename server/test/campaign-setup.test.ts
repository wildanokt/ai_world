import { expect, it } from "vitest";
import { campaignFromSetup } from "../src/world/world.js";
import { testWorld } from "./support/fixtures.js";

it("builds a private Campaign from the chosen setting and one customized player", () => {
  const world = testWorld();
  const player = world.characters[0]!;
  const setup = { worldId: world.id, premise: "A different opening", tone: "", contentLimits: "",
    lethality: "deadly" as const, startingLocation: "cellar", characters: [{ ...player, name: "Rin", maxHp: 25 }] };
  const result = campaignFromSetup(world, setup);
  expect(result.world).toMatchObject({ premise: "A different opening", lethality: "deadly" });
  expect(result.characters).toHaveLength(1);
  expect(result.characters[0]).toMatchObject({ name: "Rin", hp: 25, location: "cellar" });
  expect(world.characters[0]?.name).toBe("Arin");
  expect(() => campaignFromSetup(world, { ...setup, startingLocation: "unknown" })).toThrow(/location/i);
  expect(() => campaignFromSetup(world, { ...setup, characters: [] })).toThrow(/Player Character/);
});
