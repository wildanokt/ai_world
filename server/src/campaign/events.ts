export type Lethality = "forgiving" | "standard" | "deadly";

import type { TokenUsage } from "../model/provider.js";

export interface CatalogEntry { name: string; description: string }
export interface JournalEntry { kind: "quest" | "person" | "place" | "note"; text: string }
export interface Combat { order: string[]; turn: number }
export interface Route { to: string; minutes: number }
export interface Journey extends Route { remaining: number; routine: boolean }
export interface Location {
  routes?: Route[];
  links?: string[];
  name: string;
  description: string;
}

/** The World as copied into a Campaign when it starts. */
export interface WorldInfo {
  /** The World it came from; null for campaigns saved before Worlds existed. */
  id: string | null;
  name: string;
  premise: string;
  tone: string;
  contentLimits: string;
  lethality: Lethality;
  locations: Location[];
  items?: CatalogEntry[];
  quests?: CatalogEntry[];
}

export interface CharacterProfileText {
  description: string;
  personality: string;
  goals: string;
  secrets: string;
}

export interface Character {
  id: string;
  name: string;
  role: "player" | "npc";
  hp: number;
  maxHp: number;
  location: string;
  inventory: Record<string, number>;
  skills: Record<string, number>;
  profile: CharacterProfileText;
  /** NPC Memory: what this NPC has witnessed or been told, oldest first. */
  memories: string[];
  portrait?: string | null;
  routine?: string[];
  journey?: Journey | null;
  condition?: "down" | "dying" | "dead" | null;
  /** NPC Memory: attitude toward the Player Character, -10 (hostile) to +10 (devoted). */
  relationship: number;
}

export interface SceneSummary {
  /** Transcript entries [from, to) this summary covers. */
  from: number;
  to: number;
  text: string;
}

export interface ChapterSummary {
  /** Scene summaries [fromScene, toScene) this chapter covers. */
  fromScene: number;
  toScene: number;
  text: string;
}

export interface CampaignState {
  journal: JournalEntry[];
  clock: number;
  combat: Combat | null;
  usage: TokenUsage;
  suggestions: string[];
  world: WorldInfo;
  playerCharacterId: string;
  characters: Record<string, Character>;
  summaries: { scenes: SceneSummary[]; chapters: ChapterSummary[] };
}

export interface CampaignStart {
  world: WorldInfo;
  playerCharacterId: string;
  characters: Character[];
}

/** campaign_started as written before Worlds existed (milestone 1). */
interface LegacyCampaignStart {
  worldName: string;
  playerCharacter: Pick<Character, "id" | "name" | "hp" | "maxHp" | "location" | "inventory">;
}

export type CampaignEvent =
  | ({ type: "campaign_started" } & (CampaignStart | LegacyCampaignStart))
  | { type: "damage_taken"; characterId: string; amount: number }
  | { type: "healed"; characterId: string; amount: number }
  | { type: "item_gained"; characterId: string; item: string; quantity: number }
  | { type: "item_lost"; characterId: string; item: string; quantity: number }
  | { type: "moved"; characterId: string; to: string }
  | { type: "journey_completed"; characterId: string; from: string; to: string; minutes: number }
  | { type: "npc_journey_progress"; characterId: string; journey: Journey }
  | { type: "player_said"; text: string }
  | { type: "gm_narrated"; text: string }
  | { type: "npc_spoke"; characterId: string; name: string; text: string }
  | ({ type: "check_rolled" } & RollRecord)
  | { type: "npc_remembered"; characterId: string; note: string }
  | { type: "relationship_changed"; characterId: string; delta: number; reason: string }
  | ({ type: "scene_summarized" } & SceneSummary)
  | ({ type: "chapter_summarized" } & ChapterSummary)
  | ({ type: "journal_recorded" } & JournalEntry)
  | { type: "character_edited"; characterId: string; patch: Partial<Pick<Character, "name" | "profile" | "hp" | "maxHp" | "skills" | "portrait" | "condition">> }
  | { type: "clock_advanced"; minutes: number }
  | { type: "combat_changed"; combat: Combat | null }
  | { type: "ai_used"; usage: TokenUsage }
  | { type: "ai_inspected"; trace: unknown }
  | { type: "replies_suggested"; replies: string[] };

export const RELATIONSHIP_MIN = -10;
export const RELATIONSHIP_MAX = 10;

export interface RollRecord {
  characterId: string;
  reason: string;
  roll: number;
  total: number;
  difficulty: number;
  success: boolean;
  critical: "success" | "failure" | null;
}

export type TranscriptEntry =
  | { kind: "player"; text: string }
  | { kind: "gm"; text: string }
  | { kind: "npc"; characterId: string; name: string; text: string }
  | ({ kind: "roll" } & RollRecord);

export function toTranscriptEntry(event: CampaignEvent): TranscriptEntry | null {
  switch (event.type) {
    case "player_said":
      return { kind: "player", text: event.text };
    case "gm_narrated":
      return { kind: "gm", text: event.text };
    case "npc_spoke":
      return { kind: "npc", characterId: event.characterId, name: event.name, text: event.text };
    case "check_rolled": {
      const { type: _type, ...roll } = event;
      return { kind: "roll", ...roll };
    }
    default:
      return null;
  }
}

/** Events that may be appended after a campaign has started. */
export type AppendableEvent = Exclude<CampaignEvent, { type: "campaign_started" }>;

export function applyEvent(state: CampaignState | null, event: CampaignEvent): CampaignState {
  if (event.type === "campaign_started") {
    const start = "world" in event ? event : fromLegacy(event);
    return structuredClone({
      world: start.world,
      playerCharacterId: start.playerCharacterId,
      // Campaigns started before NPC Memory existed lack the memory fields.
      characters: Object.fromEntries(start.characters.map((c: Partial<Character>) => [c.id, { memories: [], relationship: 0, ...c } as Character])),
      summaries: { scenes: [], chapters: [] },
      journal: [{ kind: "place" as const, text: start.characters.find((c) => c.id === start.playerCharacterId)!.location }],
      clock: 0,
      combat: null,
      usage: { input: 0, cached: 0, output: 0 },
      suggestions: [],
    });
  }
  if (!state) throw new Error(`${event.type} before campaign_started`);
  switch (event.type) {
    case "damage_taken":
      return updateCharacter(state, event.characterId, (c) => ({
        ...c,
        hp: Math.max(0, c.hp - event.amount),
        ...(c.condition === "dying" && c.hp === 0 ? { condition: "dead" as const } : {}),
        ...(event.amount >= c.hp && c.hp > 0 ? { condition: ({
          forgiving: "down", standard: "dying", deadly: "dead",
        } as const)[state.world.lethality] } : {}),
      }));
    case "healed":
      return updateCharacter(state, event.characterId, (c) => ({
        ...c,
        ...(c.condition === "dead" ? {} : { hp: Math.min(c.maxHp, c.hp + event.amount), condition: undefined }),
      }));
    case "item_gained":
      return updateCharacter(state, event.characterId, (c) => ({
        ...c,
        inventory: adjustStack(c.inventory, event.item, event.quantity),
      }));
    case "item_lost":
      return updateCharacter(state, event.characterId, (c) => ({
        ...c,
        inventory: adjustStack(c.inventory, event.item, -event.quantity),
      }));
    case "npc_journey_progress":
      return updateCharacter(state, event.characterId, (c) => ({ ...c, journey: event.journey }));
    case "journey_completed":
    case "moved": {
      const next = updateCharacter(state, event.characterId, (c) => ({ ...c, location: event.to, journey: null }));
      return event.characterId === state.playerCharacterId
        ? withJournal(next, { kind: "place", text: event.to })
        : next;
    }
    case "journal_recorded":
      return withJournal(state, { kind: event.kind, text: event.text });
    case "character_edited":
      return updateCharacter(state, event.characterId, (c) => ({ ...c, ...event.patch }));
    case "clock_advanced":
      return { ...state, clock: state.clock + event.minutes };
    case "combat_changed":
      return { ...state, combat: event.combat };
    case "replies_suggested":
      return { ...state, suggestions: event.replies };
    case "ai_used":
      return { ...state, usage: {
        input: state.usage.input + event.usage.input,
        cached: state.usage.cached + event.usage.cached,
        output: state.usage.output + event.usage.output,
      } };
    case "ai_inspected":
      return state;
    case "npc_remembered":
      return updateCharacter(state, event.characterId, (c) => ({ ...c, memories: [...c.memories, event.note] }));
    case "relationship_changed":
      return updateCharacter(state, event.characterId, (c) => ({
        ...c,
        relationship: Math.min(RELATIONSHIP_MAX, Math.max(RELATIONSHIP_MIN, c.relationship + event.delta)),
      }));
    case "scene_summarized": {
      const { type: _type, ...scene } = event;
      return { ...state, summaries: { ...state.summaries, scenes: [...state.summaries.scenes, scene] } };
    }
    case "chapter_summarized": {
      const { type: _type, ...chapter } = event;
      return { ...state, summaries: { ...state.summaries, chapters: [...state.summaries.chapters, chapter] } };
    }
    case "player_said":
    case "gm_narrated":
    case "npc_spoke":
    case "check_rolled":
      return state;
  }
}

function withJournal(state: CampaignState, entry: JournalEntry): CampaignState {
  if (state.journal.some((old) => old.kind === entry.kind && old.text === entry.text)) return state;
  return { ...state, journal: [...state.journal, entry] };
}

function fromLegacy({ worldName, playerCharacter }: LegacyCampaignStart): CampaignStart {
  return {
    world: { id: null, name: worldName, premise: "", tone: "", contentLimits: "", lethality: "standard", locations: [] },
    playerCharacterId: playerCharacter.id,
    characters: [
      {
        ...playerCharacter,
        role: "player",
        skills: {},
        memories: [],
        relationship: 0,
        profile: { description: "", personality: "", goals: "", secrets: "" },
      },
    ],
  };
}

function adjustStack(inventory: Record<string, number>, item: string, delta: number) {
  const owned = Object.hasOwn(inventory, item) ? inventory[item]! : 0;
  const next = { ...inventory, [item]: owned + delta };
  if ((next[item] ?? 0) <= 0) delete next[item];
  return next;
}

function updateCharacter(
  state: CampaignState,
  id: string,
  fn: (c: Character) => Character,
): CampaignState {
  const current = state.characters[id];
  if (!current) throw new Error(`Unknown character ${id}`);
  return { ...state, characters: { ...state.characters, [id]: fn(current) } };
}
