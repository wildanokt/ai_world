import type { AppendableEvent, CampaignState, Character, Journey, Location, Route } from "./events.js";

export class TravelRejected extends Error {}

export function routesFrom(location: Location): Route[] {
  return location.routes ?? [...new Set(location.links ?? [])].map((to) => ({ to, minutes: 30 }));
}

function availableRoutes(state: CampaignState, from: string): Route[] {
  const locations = state.world.locations;
  const location = locations.find(({ name }) => name === from);
  if (!location) return [];
  return routesFrom(location).filter(({ to }) => to !== from && locations.some(({ name }) => name === to));
}

export function travelOptions(state: CampaignState): Route[] {
  return availableRoutes(state, state.characters[state.playerCharacterId]!.location);
}

export function playerTravel(state: CampaignState, from: string, to: string) {
  const player = state.characters[state.playerCharacterId]!;
  if (player.location !== from) throw new TravelRejected("Your location has changed. Check the available routes again.");
  if (state.combat) throw new TravelRejected("End combat before travelling.");
  if (player.hp <= 0) throw new TravelRejected("Your character cannot travel while incapacitated.");
  const route = travelOptions(state).find((candidate) => candidate.to === to);
  if (!route) throw new TravelRejected("There is no direct route to that location.");
  const events: AppendableEvent[] = [
    { type: "journey_completed", characterId: player.id, from, ...route },
    ...advanceClock(state, route.minutes, to),
  ];
  return { events, result: { from, ...route, location: to, clock: state.clock + route.minutes } };
}

export function npcTravel(state: CampaignState, npc: Character, to: string) {
  if (state.combat || npc.hp <= 0) throw new TravelRejected("This character cannot travel right now.");
  if (npc.journey) throw new TravelRejected("This character is already travelling.");
  const route = availableRoutes(state, npc.location).find((candidate) => candidate.to === to);
  if (!route) throw new TravelRejected("There is no direct route to that location.");
  const events: AppendableEvent[] = [{
    type: "npc_journey_progress", characterId: npc.id, journey: { ...route, remaining: route.minutes, routine: false },
  }];
  return { events, result: { from: npc.location, ...route, arrived: false } };
}

export function advanceClock(state: CampaignState, minutes: number, arrival?: string): AppendableEvent[] {
  const events: AppendableEvent[] = [{ type: "clock_advanced", minutes }];
  const scene = state.characters[state.playerCharacterId]!.location;
  const locations = new Map(state.world.locations.map((location) => [location.name, routesFrom(location)]));
  for (const npc of Object.values(state.characters)) {
    if (npc.role !== "npc" || npc.hp <= 0) continue;
    let location = npc.location;
    let remaining = minutes;
    let journey = npc.journey ?? undefined;
    while (remaining > 0) {
      if (location === scene && (!journey || journey.routine)) break;
      journey ??= routineJourney(locations, npc, location);
      if (!journey) break;
      if (journey.remaining > remaining) {
        events.push({ type: "npc_journey_progress", characterId: npc.id, journey: {
          ...journey, remaining: journey.remaining - remaining,
        } });
        break;
      }
      remaining -= journey.remaining;
      events.push({
        type: "journey_completed", characterId: npc.id, from: location, to: journey.to, minutes: journey.minutes,
      });
      location = journey.to;
      journey = undefined;
      if (location === scene || location === arrival) break;
    }
  }
  return events;
}

function routineJourney(locations: Map<string, Route[]>, npc: Character, from: string): Journey | undefined {
  const stops = npc.routine;
  if (!stops?.length) return undefined;
  const next = stops[(stops.indexOf(from) + 1) % stops.length];
  if (!next || next === from || !locations.has(next)) return undefined;
  const route = locations.get(from)?.find(({ to }) => to === next);
  return route && { ...route, remaining: route.minutes, routine: true };
}
