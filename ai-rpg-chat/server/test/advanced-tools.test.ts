import { expect, it } from "vitest";
import { applyEvent } from "../src/campaign/events.js";
import { runTool } from "../src/game-master/tools.js";
import { testCampaignStart } from "./support/fixtures.js";

it("resolves initiative, attacks and lethal damage in code", () => {
  const state = applyEvent(null, { ...testCampaignStart(), type: "campaign_started" });
  state.world.lethality = "deadly";
  const pc = state.characters[state.playerCharacterId]!;
  const npc = Object.values(state.characters).find((character) => character.role === "npc")!;
  npc.location = pc.location;
  npc.hp = 1;
  const start = runTool("begin_combat", { combatants: [pc.id, npc.id] }, { state, d20: () => 20 });
  const battle = start.events.reduce(applyEvent, state);
  expect(battle.combat?.order[0]).toBe(pc.id);
  const attack = runTool("combat_action", { actor: pc.id, target: npc.id }, { state: battle, d20: () => 20 });
  const result = attack.events.reduce(applyEvent, battle);
  expect(result.characters[npc.id]).toMatchObject({ hp: 0, condition: "dead" });
  expect(result.combat).toBeNull();
});

it("advances the clock and moves offscreen NPCs only along their configured routes", () => {
  const state = applyEvent(null, { ...testCampaignStart(), type: "campaign_started" });
  const npc = Object.values(state.characters).find((character) => character.role === "npc")!;
  npc.location = "Road";
  npc.routine = ["Road", "Market"];
  state.world.locations = [{ name: "Road", description: "", links: ["Market"] }, { name: "Market", description: "" }];
  const tick = runTool("advance_time", { minutes: 60 }, { state, d20: () => 1 });
  expect(tick.events.reduce(applyEvent, state)).toMatchObject({ clock: 60, characters: { [npc.id]: { location: "Market" } } });
});
