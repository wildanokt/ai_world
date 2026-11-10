import { z } from "zod";
import type { CampaignStart, Character } from "../campaign/events.js";

/** A World or Character Profile the game refuses to save, with a readable reason. */
export class WorldInvalid extends Error {}

const text = (max: number) => z.string().trim().max(max).default("");

const portrait = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional();
const locationName = z.string().trim().min(1).max(120);
const catalog = z.array(z.object({ name: z.string().trim().min(1).max(80), description: text(1000) })).max(100).optional();

export const CharacterProfileSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["player", "npc"]),
  description: text(2000),
  personality: text(2000),
  goals: text(2000),
  secrets: text(2000),
  maxHp: z.number().int().min(1).max(999),
  /** Skill name → d20 modifier. */
  skills: z.record(z.string().trim().min(1).max(40), z.number().int().min(-5).max(10)).default({}),
  /** Empty means the World's starting location. */
  location: text(120),
  portrait,
  routine: z.array(locationName).max(20).optional(),
  inventory: z.record(z.string().trim().min(1).max(80), z.number().int().min(1).max(999)).default({}),
});

export const WorldSchema = z.object({
  name: z.string().trim().min(1).max(80),
  premise: text(4000),
  tone: text(300),
  contentLimits: text(1000),
  lethality: z.enum(["forgiving", "standard", "deadly"]).default("standard"),
  startingLocation: locationName,
  items: catalog,
  quests: catalog,
  locations: z
    .array(z.object({ name: locationName, description: text(1000), links: z.array(locationName).max(30).optional() }))
    .max(100)
    .default([]),
  characters: z.array(CharacterProfileSchema).max(200),
});

export type CharacterProfile = z.output<typeof CharacterProfileSchema>;
/** A World's content, without its id. */
export type WorldDoc = z.output<typeof WorldSchema>;
export type World = WorldDoc & { id: string };

/** Validate a World, including rules that span fields. Throws WorldInvalid. */
export function parseWorld(input: unknown): WorldDoc {
  const { id: _ignored, ...rest } = (input ?? {}) as Record<string, unknown>;
  const parsed = WorldSchema.safeParse(rest);
  if (!parsed.success) throw new WorldInvalid(z.prettifyError(parsed.error));
  const world = parsed.data;

  const players = world.characters.filter((c) => c.role === "player").length;
  if (players !== 1) {
    throw new WorldInvalid(`A World needs exactly one Player Character (found ${players}).`);
  }
  const seen = new Set<string>();
  for (const c of world.characters) {
    if (seen.has(c.id)) throw new WorldInvalid(`Two characters have the same id "${c.id}".`);
    seen.add(c.id);
  }
  return world;
}

export function parseCharacterProfile(input: unknown): CharacterProfile {
  const parsed = CharacterProfileSchema.safeParse(input);
  if (!parsed.success) throw new WorldInvalid(z.prettifyError(parsed.error));
  return parsed.data;
}

/** The first event of a new Campaign: a private copy of the World with everyone at full HP. */
export function campaignStartFrom(world: World): CampaignStart {
  const characters: Character[] = world.characters.map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    hp: p.maxHp,
    maxHp: p.maxHp,
    location: p.location || world.startingLocation,
    inventory: { ...p.inventory },
    skills: { ...p.skills },
    profile: { description: p.description, personality: p.personality, goals: p.goals, secrets: p.secrets },
    memories: [],
    relationship: 0,
    portrait: p.portrait,
    routine: p.routine,
  }));
  return structuredClone({
    world: {
      id: world.id,
      name: world.name,
      premise: world.premise,
      tone: world.tone,
      contentLimits: world.contentLimits,
      lethality: world.lethality,
      locations: world.locations,
      items: world.items,
      quests: world.quests,
    },
    playerCharacterId: characters.find((c) => c.role === "player")!.id,
    characters,
  });
}

/** A readable id from a name that does not clash with any id in `taken`. */
export function uniqueId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "character";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}
