import { expect, it } from "vitest";
import { openCampaignStore } from "../src/campaign/store.js";
import { createGameMaster } from "../src/game-master/game-master.js";
import { scriptedModel } from "./support/scripted-model.js";
import { applyEvent } from "../src/campaign/events.js";
import { advanceClock, playerTravel, travelOptions } from "../src/campaign/travel.js";
import { testCampaignStart } from "./support/fixtures.js";

function start() {
  const start = testCampaignStart();
  start.world.locations = [
    { name: "tavern", description: "", links: ["road"] },
    { name: "road", description: "", routes: [{ to: "market", minutes: 90 }] },
    { name: "market", description: "", routes: [{ to: "tavern", minutes: 10 }] },
  ];
  return start;
}

function campaign() {
  return applyEvent(null, { type: "campaign_started", ...start() });
}

it("uses legacy durations, validates directed routes and advances the clock once", () => {
  const state = campaign();
  expect(travelOptions(state)).toEqual([{ to: "road", minutes: 30 }]);
  const trip = playerTravel(state, "tavern", "road");
  const next = trip.events.reduce(applyEvent, state);
  expect(next.clock).toBe(30);
  expect(next.characters.pc?.location).toBe("road");
  expect(() => playerTravel(next, "tavern", "road")).toThrow(/changed/);
  expect(() => playerTravel(next, "road", "tavern")).toThrow(/route/);
  next.combat = { order: ["pc"], turn: 0 };
  expect(() => playerTravel(next, "road", "market")).toThrow(/combat/);
});

it("carries partial NPC travel across ticks and stops when the NPC reaches the player", () => {
  const state = campaign();
  const npc = state.characters.bram!;
  npc.location = "road";
  npc.routine = ["road", "market", "tavern"];
  const partial = advanceClock(state, 45).reduce(applyEvent, state);
  expect(partial.characters.bram).toMatchObject({ location: "road", journey: { remaining: 45 } });
  const arrived = advanceClock(partial, 60).reduce(applyEvent, partial);
  expect(arrived.characters.bram).toMatchObject({ location: "tavern", journey: null });
  expect(arrived.clock).toBe(105);
});

it("uses the same direct route in chat and rejects a second trip or duplicate time advance", async () => {
  const store = openCampaignStore(":memory:");
  try {
    const id = store.createCampaign(start());
    const expected = playerTravel(store.state(id), "tavern", "road");
    const { provider, turns } = scriptedModel({ toolCalls: [
      { name: "move_character", input: { characterId: "pc", to: "road" } },
      { name: "advance_time", input: { minutes: 30 } },
      { name: "move_character", input: { characterId: "pc", to: "market" } },
    ] }, { text: "You reach the road." });
    const gm = createGameMaster({ store, model: provider, d20: () => 10 });
    await gm.takeTurn(id, "I travel to the road.");
    const results = turns[0]!.toolResults.map(({ result }) => result);
    expect(JSON.parse(results[0]!.content)).toEqual(expected.result);
    expect(results.slice(1).map(({ isError }) => isError)).toEqual([true, true]);
    expect(store.state(id)).toMatchObject({ clock: 30, characters: { pc: { location: "road" } } });
  } finally { store.close(); }
});

it("restores an NPC's in-progress journey when rewinding", () => {
  const store = openCampaignStore(":memory:");
  try {
    const initial = start();
    const npc = initial.characters.find(({ id }) => id === "bram")!;
    npc.location = "road";
    npc.routine = ["road", "market", "tavern"];
    const id = store.createCampaign(initial);
    store.append(id, advanceClock(store.state(id), 45));
    const snapshot = store.snapshot(id, "Halfway");
    store.append(id, advanceClock(store.state(id), 60));
    const branch = store.rewind(id, snapshot.id)!;
    expect(store.state(branch)).toMatchObject({ clock: 45, characters: { bram: { location: "road", journey: { remaining: 45 } } } });
    expect(store.state(id).characters.bram?.location).toBe("tavern");
  } finally { store.close(); }
});
