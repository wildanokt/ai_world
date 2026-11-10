/**
 * Drafts: the AI turns a few keywords into a World or Character Profile, which the user then
 * reviews and edits in the God Console before saving. The AI fills in one "submit" tool, and the
 * game validates the result like any other input.
 */
import { z } from "zod";
import type { ModelProvider, TurnTool } from "../model/provider.js";
import {
  parseCharacterProfile,
  parseWorld,
  uniqueId,
  type CharacterProfile,
  type WorldDoc,
} from "./world.js";

export class DraftFailed extends Error {}

/** What a Character Draft needs to know about the World, which may be mid-edit and unsaved. */
export type DraftContext = Pick<WorldDoc, "name" | "premise" | "tone" | "startingLocation" | "locations"> & {
  characters: Pick<CharacterProfile, "id" | "name" | "role">[];
};

const prose = (hint: string) => z.string().max(2000).describe(hint);

const DraftCharacterSchema = z.object({
  name: z.string().min(1).max(80),
  description: prose("Appearance and first impression, 1-3 sentences."),
  personality: prose("How they talk and behave."),
  goals: prose("What they want right now."),
  secrets: prose("Something hidden that the Game Master can reveal through play. May be empty."),
  maxHp: z.number().int().min(1).max(200).describe("Ordinary person 8-12, seasoned adventurer 15-25, monster 30+."),
  skills: z
    .array(z.object({ name: z.string().min(1).max(40), modifier: z.number().int().min(-5).max(10) }))
    .max(12)
    .describe("Their notable skills as d20 modifiers, usually +1 to +5."),
  location: z.string().max(120).describe("One of the World's location names, or empty for the starting location."),
  inventory: z.array(z.object({ item: z.string().min(1).max(80), quantity: z.number().int().min(1).max(999) })).max(20),
});
type DraftCharacter = z.output<typeof DraftCharacterSchema>;

const DraftWorldSchema = z.object({
  name: z.string().min(1).max(80),
  premise: prose("The World's lore and current situation, 1-3 short paragraphs."),
  tone: z.string().max(300).describe("A few words, e.g. 'grim, political, low magic'."),
  contentLimits: z.string().max(1000).describe("Content to avoid or keep off-screen. May be empty."),
  lethality: z.enum(["forgiving", "standard", "deadly"]),
  startingLocation: z.string().min(1).max(120).describe("Must be one of the location names."),
  locations: z.array(z.object({
    name: z.string().min(1).max(120),
    description: prose("1-2 sentences."),
    links: z.array(z.string().min(1).max(120)).max(11).optional().describe("Exact names of other locations reachable from here."),
  })).min(1).max(12),
  playerCharacter: DraftCharacterSchema,
  npcs: z.array(DraftCharacterSchema).min(1).max(8),
});

const LANGUAGE = "Write every field in the same language as the keywords.";

export function createDrafter({ model }: { model: ModelProvider }) {
  async function draft<S extends z.ZodObject>(opts: {
    toolName: string;
    schema: S;
    system: string;
    prompt: string;
  }): Promise<z.output<S>> {
    let result: z.output<S> | null = null;
    const submit: TurnTool = {
      name: opts.toolName,
      description: "Submit the finished draft. Call this exactly once with every field filled in.",
      schema: opts.schema,
      execute(input) {
        const parsed = opts.schema.safeParse(input);
        if (!parsed.success) return { content: `Invalid draft:\n${z.prettifyError(parsed.error)}`, isError: true };
        result = parsed.data;
        return { content: "Draft received. Reply with one short sentence; do not repeat the draft.", isError: false };
      },
    };
    await model.runTurn({
      tier: "strong",
      system: opts.system,
      messages: [{ role: "user", text: opts.prompt }],
      tools: [submit],
      maxModelCalls: 4,
    });
    if (!result) throw new DraftFailed("The AI did not produce a Draft. Try again, or change the keywords.");
    return result;
  }

  return {
    async draftWorld(keywords: string): Promise<WorldDoc> {
      const d = await draft({
        toolName: "submit_world_draft",
        schema: DraftWorldSchema,
        system: [
          "You design Worlds for a single-player, chat-based fantasy role-playing game run by an AI Game Master.",
          "From the user's keywords, create an evocative, playable World: a premise with a clear current tension,",
          "a handful of connected locations with links using their exact names, a Player Character with a reason to act, and NPCs with goals that create hooks.",
          LANGUAGE,
          `Submit it with ${"submit_world_draft"}.`,
        ].join(" "),
        prompt: `<keywords>${keywords}</keywords>`,
      });
      const taken = new Set<string>();
      return parseWorld({
        name: d.name,
        premise: d.premise,
        tone: d.tone,
        contentLimits: d.contentLimits,
        lethality: d.lethality,
        startingLocation: d.startingLocation,
        locations: d.locations.map((location) => ({
          ...location,
          links: location.links?.filter((name) => name !== location.name && d.locations.some((candidate) => candidate.name === name)),
        })),
        characters: [
          toProfile(d.playerCharacter, "player", taken),
          ...d.npcs.map((npc) => toProfile(npc, "npc", taken)),
        ],
      });
    },

    async draftCharacter(
      keywords: string,
      { world, role }: { world: DraftContext; role: "player" | "npc" },
    ): Promise<CharacterProfile> {
      const d = await draft({
        toolName: "submit_character_draft",
        schema: DraftCharacterSchema,
        system: [
          `You create ${role === "player" ? "the Player Character" : "NPCs"} for a single-player, chat-based fantasy role-playing game.`,
          "From the user's keywords, create one vivid character who fits the World below and has goals that create story hooks.",
          LANGUAGE,
          "Submit it with submit_character_draft.",
        ].join(" "),
        prompt: [
          `<world name="${world.name}" tone="${world.tone}">`,
          world.premise,
          `Locations: ${world.locations.map((l) => l.name).join(", ") || world.startingLocation}`,
          `Existing characters: ${world.characters.map((c) => `${c.name} (${c.role})`).join(", ") || "none"}`,
          "</world>",
          `<keywords>${keywords}</keywords>`,
        ].join("\n"),
      });
      return toProfile(d, role, new Set(world.characters.map((c) => c.id)));
    },
  };
}

function toProfile(d: DraftCharacter, role: "player" | "npc", taken: Set<string>): CharacterProfile {
  return parseCharacterProfile({
    id: uniqueId(d.name, taken),
    name: d.name,
    role,
    description: d.description,
    personality: d.personality,
    goals: d.goals,
    secrets: d.secrets,
    maxHp: d.maxHp,
    skills: Object.fromEntries(d.skills.map((s) => [s.name, s.modifier])),
    location: d.location,
    inventory: Object.fromEntries(d.inventory.map((i) => [i.item, i.quantity])),
  });
}
