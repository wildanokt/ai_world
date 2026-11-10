import type { z } from "zod";
import type { AppendableEvent, CampaignState } from "../campaign/events.js";
import type { D20 } from "../rules/checks.js";

/** A proposed change the game refuses; reported back to the model as a tool error. */
export class ToolRejected extends Error {}

export interface ToolContext {
  state: CampaignState;
  d20: D20;
}

export interface ToolOutcome {
  events: AppendableEvent[];
  result: unknown;
}

export interface GameTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run(input: z.infer<S>, ctx: ToolContext): ToolOutcome;
}

export const defineTool = <S extends z.ZodObject>(tool: GameTool<S>) => tool;

export function requireCharacter(state: CampaignState, id: string) {
  const character = Object.hasOwn(state.characters, id) ? state.characters[id] : undefined;
  if (!character) throw new ToolRejected(`No character with id "${id}".`);
  return character;
}

export function skillModifier(skills: Record<string, number>, skill: string | undefined): number | undefined {
  if (!skill) return undefined;
  const wanted = skill.trim().toLowerCase();
  return Object.entries(skills).find(([name]) => name.toLowerCase() === wanted)?.[1];
}
