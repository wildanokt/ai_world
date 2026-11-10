import { z } from "zod";
import { RELATIONSHIP_MAX, RELATIONSHIP_MIN, type CampaignState } from "../campaign/events.js";
import { skillCheck } from "../rules/checks.js";

import { ToolRejected, defineTool, requireCharacter, skillModifier, type ToolContext, type ToolOutcome, type GameTool } from "./tool-types.js";
import { ADVANCED_TOOLS } from "./advanced-tools.js";
export { ToolRejected } from "./tool-types.js";

const skillCheckTool = defineTool({
  name: "skill_check",
  description:
    "Roll a d20 skill check for a character when the outcome of an action is uncertain. " +
    "Name the skill being used: if the character has that skill, the game uses their own modifier; " +
    "otherwise you choose the modifier (-5..+10). Difficulty: 5 trivial, 10 easy, 15 medium, 20 hard, 25 very hard. " +
    "Natural 20 always succeeds, natural 1 always fails. Narrate according to the result.",
  schema: z.object({
    characterId: z.string(),
    reason: z.string().describe("What is being attempted, e.g. 'Persuade the guard'"),
    skill: z.string().optional().describe("The skill used, e.g. 'Stealth'"),
    modifier: z.number().int().min(-5).max(10).optional().describe("Used only if the character lacks the skill"),
    difficulty: z.number().int().min(1).max(40),
  }),
  run(input, ctx) {
    const c = requireCharacter(ctx.state, input.characterId);
    const modifier = skillModifier(c.skills, input.skill) ?? input.modifier ?? 0;
    const check = skillCheck({ modifier, difficulty: input.difficulty }, ctx.d20);
    return {
      events: [{ type: "check_rolled", characterId: input.characterId, reason: input.reason, difficulty: input.difficulty, ...check }],
      result: { ...check, modifier },
    };
  },
});

const amountInput = z.object({ characterId: z.string(), amount: z.number().int().min(1).max(999) });
const itemInput = z.object({
  characterId: z.string(),
  item: z.string().min(1),
  quantity: z.number().int().min(1).max(999),
});

const applyDamageTool = defineTool({
  name: "apply_damage",
  description: "Reduce a character's HP. HP never goes below 0.",
  schema: amountInput,
  run(input, ctx) {
    const c = requireCharacter(ctx.state, input.characterId);
    if (ctx.state.combat?.order.includes(c.id)) throw new ToolRejected("Use combat_action to resolve combat damage.");
    if (c.condition === "dead") throw new ToolRejected("This character is already dead.");
    const hp = Math.max(0, c.hp - input.amount);
    const condition = hp > 0 ? null : c.condition === "dying" ? "dead" : c.condition ?? ({
      forgiving: "down", standard: "dying", deadly: "dead",
    } as const)[ctx.state.world.lethality];
    return { events: [{ type: "damage_taken", ...input }], result: { hp, maxHp: c.maxHp, down: hp === 0, condition } };
  },
});

const healTool = defineTool({
  name: "heal",
  description: "Restore a character's HP, up to their max HP.",
  schema: amountInput,
  run(input, ctx) {
    const c = requireCharacter(ctx.state, input.characterId);
    if (c.condition === "dead") throw new ToolRejected("This character cannot be healed.");
    return { events: [{ type: "healed", ...input }], result: { hp: Math.min(c.maxHp, c.hp + input.amount), maxHp: c.maxHp } };
  },
});

const giveItemTool = defineTool({
  name: "give_item",
  description: "Add items to a character's inventory (found, bought, received).",
  schema: itemInput,
  run(input, ctx) {
    const c = requireCharacter(ctx.state, input.characterId);
    const owned = Object.hasOwn(c.inventory, input.item) ? c.inventory[input.item]! : 0;
    const quantity = owned + input.quantity;
    return { events: [{ type: "item_gained", ...input }], result: { item: input.item, quantity } };
  },
});

const takeItemTool = defineTool({
  name: "take_item",
  description: "Remove items from a character's inventory (used, sold, lost). Fails if they don't have enough.",
  schema: itemInput,
  run(input, ctx) {
    const c = requireCharacter(ctx.state, input.characterId);
    const owned = Object.hasOwn(c.inventory, input.item) ? c.inventory[input.item]! : 0;
    if (owned < input.quantity) {
      throw new ToolRejected(`${c.name} has ${owned} × "${input.item}", cannot remove ${input.quantity}.`);
    }
    return { events: [{ type: "item_lost", ...input }], result: { item: input.item, quantity: owned - input.quantity } };
  },
});

const moveCharacterTool = defineTool({
  name: "move_character",
  description: "Move a character to a named location.",
  schema: z.object({ characterId: z.string(), to: z.string().min(1) }),
  run(input, ctx) {
    requireCharacter(ctx.state, input.characterId);
    return { events: [{ type: "moved", ...input }], result: { location: input.to } };
  },
});

function requireNpc(state: CampaignState, id: string) {
  const c = requireCharacter(state, id);
  if (c.role !== "npc") throw new ToolRejected("Only NPCs keep memories and relationships, not the Player Character.");
  return c;
}

const rememberTool = defineTool({
  name: "remember",
  description:
    "Record something an NPC witnessed or was told that they should remember later: promises, insults, help, " +
    "secrets shared, the player's lies. One short sentence in third person. Skip small talk.",
  schema: z.object({ characterId: z.string(), note: z.string().trim().min(1).max(300) }),
  run(input, ctx) {
    const c = requireNpc(ctx.state, input.characterId);
    return { events: [{ type: "npc_remembered", ...input }], result: { remembered: true, memories: c.memories.length + 1 } };
  },
});

const adjustRelationshipTool = defineTool({
  name: "adjust_relationship",
  description:
    "Change how an NPC feels about the Player Character after something that matters to them. " +
    `The score runs from ${RELATIONSHIP_MIN} (hostile) to +${RELATIONSHIP_MAX} (devoted); 0 is neutral. Use small steps.`,
  schema: z.object({
    characterId: z.string(),
    delta: z.number().int().min(-3).max(3).refine((n) => n !== 0, "delta cannot be 0"),
    reason: z.string().trim().min(1).max(200),
  }),
  run(input, ctx) {
    const c = requireNpc(ctx.state, input.characterId);
    const relationship = Math.min(RELATIONSHIP_MAX, Math.max(RELATIONSHIP_MIN, c.relationship + input.delta));
    return { events: [{ type: "relationship_changed", ...input }], result: { relationship } };
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const GAME_TOOLS: GameTool<any>[] = [
  ...ADVANCED_TOOLS,
  skillCheckTool,
  applyDamageTool,
  healTool,
  giveItemTool,
  takeItemTool,
  moveCharacterTool,
  rememberTool,
  adjustRelationshipTool,
];

/** Validate and run one tool call. Throws ToolRejected for anything the game refuses. */
export function runTool(name: string, rawInput: unknown, ctx: ToolContext): ToolOutcome {
  const tool = GAME_TOOLS.find((t) => t.name === name);
  if (!tool) throw new ToolRejected(`Unknown tool "${name}".`);
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) throw new ToolRejected(`Invalid input: ${z.prettifyError(parsed.error)}`);
  return tool.run(parsed.data, ctx);
}
