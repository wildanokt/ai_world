import { z } from "zod";
import type { AppendableEvent, Character } from "../campaign/events.js";
import { skillCheck } from "../rules/checks.js";
import { defineTool, requireCharacter, skillModifier, ToolRejected } from "./tool-types.js";

const beginCombat = defineTool({
  name: "begin_combat",
  description: "Start structured combat with the player and hostile characters in this scene. Rolls initiative.",
  schema: z.object({ combatants: z.array(z.string()).min(2).max(12) }),
  run({ combatants }, { state, d20 }) {
    if (state.combat) throw new ToolRejected("Combat is already active.");
    const ids = [...new Set(combatants)];
    const player = requireCharacter(state, state.playerCharacterId);
    const participants = ids.map((id) => requireCharacter(state, id));
    if (ids.length < 2 || !ids.includes(player.id) || participants.some((c) => c.hp <= 0 || c.location !== player.location)) {
      throw new ToolRejected("Combat needs the player and at least one active opponent in the same location.");
    }
    const initiative = participants.map((c) => ({ id: c.id, total: d20() + (skillModifier(c.skills, "Initiative") ?? 0) }));
    initiative.sort((a, b) => b.total - a.total || Number(b.id === player.id) - Number(a.id === player.id));
    const combat = { order: initiative.map((entry) => entry.id), turn: 0 };
    return { events: [{ type: "combat_changed", combat }], result: { initiative, next: combat.order[0] } };
  },
});

const combatAction = defineTool({
  name: "combat_action",
  description: "Resolve the current combatant's attack or pass (omit target). Only attack for the player when they choose it. Opponents may attack the player.",
  schema: z.object({ actor: z.string(), target: z.string().optional() }),
  run({ actor, target }, { state, d20 }) {
    const { combat } = state;
    if (!combat || combat.order[combat.turn] !== actor) throw new ToolRejected("That character is not up next.");
    const attacker = requireCharacter(state, actor);
    if (attacker.hp <= 0 && target) throw new ToolRejected("An incapacitated combatant can only pass.");
    const defender = target ? requireCharacter(state, target) : undefined;
    const events: AppendableEvent[] = [];
    let damage = 0;
    let condition: Character["condition"];
    let defeated: string | undefined;
    if (defender) {
      if (!combat.order.includes(defender.id) || defender.role === attacker.role || defender.hp <= 0 || defender.location !== attacker.location) {
        throw new ToolRejected("Choose an active opponent.");
      }
      const modifier = skillModifier(attacker.skills, "Attack") ?? 0;
      const difficulty = 10 + (skillModifier(defender.skills, "Defence") ?? 0);
      const check = skillCheck({ modifier, difficulty }, d20);
      events.push({ type: "check_rolled", ...check, difficulty, characterId: actor, reason: "Attack" });
      if (check.success) {
        damage = Math.ceil(d20() / 4) + (check.critical === "success" ? 5 : 0);
        events.push({ type: "damage_taken", characterId: defender.id, amount: damage });
        if (damage >= defender.hp) {
          defeated = defender.id;
          condition = state.world.lethality === "deadly" ? "dead" : state.world.lethality === "standard" ? "dying" : "down";
        }
      }
    }
    const rotated = [...combat.order.slice(combat.turn + 1), ...combat.order.slice(0, combat.turn + 1)];
    const order = rotated.filter((id) => id !== defeated && requireCharacter(state, id).hp > 0);
    const next = order.length >= 2 && order.includes(state.playerCharacterId) ? { order, turn: 0 } : null;
    events.push({ type: "combat_changed", combat: next });
    return { events, result: { damage, condition, next: next?.order[0] ?? null } };
  },
});

const endCombat = defineTool({
  name: "end_combat",
  description: "End combat when the sides disengage, flee or make peace.",
  schema: z.object({}),
  run(_input, { state }) {
    if (!state.combat) throw new ToolRejected("Combat is not active.");
    return { events: [{ type: "combat_changed", combat: null }], result: { ended: true } };
  },
});

const advanceTime = defineTool({
  name: "advance_time",
  description: "Advance the in-game clock when the player spends time. NPC routines move offscreen after an hour boundary.",
  schema: z.object({ minutes: z.number().int().min(1).max(1440) }),
  run({ minutes }, { state }) {
    if (state.combat) throw new ToolRejected("End combat before advancing time.");
    const events: AppendableEvent[] = [{ type: "clock_advanced", minutes }];
    const hour = Math.floor((state.clock + minutes) / 60);
    if (hour > Math.floor(state.clock / 60)) {
      const player = requireCharacter(state, state.playerCharacterId);
      for (const npc of Object.values(state.characters)) {
        if (npc.role !== "npc" || !npc.routine?.length || npc.hp <= 0 || npc.location === player.location) continue;
        const from = state.world.locations.find((location) => location.name === npc.location);
        const next = npc.routine[(npc.routine.indexOf(npc.location) + 1) % npc.routine.length];
        if (next && next !== npc.location && from?.links?.includes(next)) {
          events.push({ type: "moved", characterId: npc.id, to: next });
        }
      }
    }
    return { events, result: { minutes: state.clock + minutes } };
  },
});

const recordJournal = defineTool({
  name: "journal_note",
  description: "Record a quest update, person met, place discovered, or event learned by the player. Never include undiscovered secrets.",
  schema: z.object({ kind: z.enum(["quest", "person", "place", "note"]), text: z.string().trim().min(1).max(500) }),
  run(input) {
    return { events: [{ type: "journal_recorded", ...input }], result: { recorded: true } };
  },
});

const suggestReplies = defineTool({
  name: "suggest_replies",
  description: "Offer two or three short, distinct actions in the player's language. Call near the end of a turn, alongside any remaining journal updates.",
  schema: z.object({ replies: z.array(z.string().trim().min(1).max(160)).min(2).max(3) }),
  run({ replies }) {
    return { events: [{ type: "replies_suggested", replies }], result: { recorded: true } };
  },
});

export const ADVANCED_TOOLS = [beginCombat, combatAction, endCombat, advanceTime, recordJournal, suggestReplies];
