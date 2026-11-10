import { z } from "zod";
import type { CampaignStore } from "../campaign/store.js";
import { applyEvent, type AppendableEvent } from "../campaign/events.js";
import type { D20 } from "../rules/checks.js";
import type { ModelProvider, TurnTool } from "../model/provider.js";
import { GAME_TOOLS, runTool, ToolRejected } from "./tools.js";
import { currentTurnMessage, historyMessages, systemPrompt } from "./context.js";

export interface GameMasterDeps {
  store: CampaignStore;
  model: ModelProvider;
  d20: D20;
}

export interface TurnOptions {
  onText?: (delta: string) => void;
  targetIds?: string[];
}

export interface TurnResult {
  narration: string;
}

const MAX_MODEL_CALLS_PER_TURN = 8;
const RecallInput = z.object({ query: z.string().trim().min(1).max(300) });
const STALLED_NARRATION = "The moment stretches on, and the world seems to wait for your next move.";

function normalizedSpeech(text: string) {
  return text.trim().replace(/\s+/g, " ");
}

function addressedNpc(state: ReturnType<CampaignStore["state"]>, playerText: string) {
  const speech = playerText.replace(/\*\*[\s\S]+?\*\*/g, " ").trimStart().toLowerCase();
  const matches = Object.values(state.characters).filter(({ name, role }) => {
    if (role !== "npc") return false;
    const label = name.toLowerCase();
    return speech.startsWith(label + ",") || speech.startsWith(label + ":") ||
      [" ", ",", ":"].some((separator) => speech.startsWith("@" + label + separator));
  });
  const present = matches.filter((npc) => npc.hp > 0 && npc.location === state.characters[state.playerCharacterId]?.location);
  return present.length === 1 ? present[0] : matches.length === 1 ? matches[0] : undefined;
}

export function createGameMaster(deps: GameMasterDeps) {
  const { store, model, d20 } = deps;

  return {
    async takeTurn(campaignId: string, playerText: string, opts: TurnOptions = {}): Promise<TurnResult> {
      const state = store.state(campaignId);
      const location = state.characters[state.playerCharacterId]?.location;
      const targets = [...new Set(opts.targetIds ?? [])].map((id) => {
        const npc = state.characters[id];
        if (npc?.role !== "npc" || npc.location !== location || npc.hp <= 0) {
          throw new ToolRejected("A selected NPC can no longer answer here. Choose targets again.");
        }
        return { id: npc.id, name: npc.name };
      });
      const addressee = targets.length === 1 ? state.characters[targets[0]!.id] :
        targets.length === 0 ? addressedNpc(state, playerText) : undefined;
      const directSpeech = !!addressee && !/\*\*[\s\S]+?\*\*/.test(playerText);
      const canAnswer = addressee && addressee.hp > 0 &&
        addressee.location === state.characters[state.playerCharacterId]?.location;

      // The whole turn is committed at once, so a failed turn leaves no trace.
      const turnEvents: AppendableEvent[] = [{
        type: "player_said", text: playerText, ...(targets.length ? { targets } : {}),
      }];
      const targetIds = new Set(targets.length ? targets.map(({ id }) => id) : addressee ? [addressee.id] : []);
      const spoken = new Set<string>();
      const dialogue = new Set<string>();
      let turnState = state;
      let unexpected: unknown = null;

      const recall: TurnTool = {
        name: "recall",
        description:
          "Search the whole Campaign history (every past message, NPC memory and summary) for details that are not in " +
          "the recent conversation or the summaries, e.g. a name, a promise or an item from long ago. Read-only.",
        schema: RecallInput,
        async execute(input) {
          const parsed = RecallInput.safeParse(input);
          if (!parsed.success) return { content: "Invalid input: give a short search query.", isError: true };
          const hits = await store.search(campaignId, parsed.data.query, 6);
          if (hits.length === 0) return { content: "Nothing in the history matches that.", isError: false };
          return {
            content: JSON.stringify(
              hits.map((h) => ({ event: h.seq, kind: h.kind, text: h.text.length > 700 ? `${h.text.slice(0, 700)}…` : h.text })),
            ),
            isError: false,
          };
        },
      };

      const tools: TurnTool[] = GAME_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
        execute(input) {
          try {
            const outcome = runTool(tool.name, input, { state: turnState, d20 });
            const line = outcome.events.find((event) => event.type === "npc_spoke");
            if (line) {
              if (targetIds.size && !targetIds.has(line.characterId)) {
                throw new ToolRejected("The player addressed other NPCs. Reply as a selected NPC if present, otherwise as Game Master.");
              }
              const text = normalizedSpeech(line.text);
              const key = JSON.stringify([line.characterId, text]);
              if (spoken.has(key)) return { content: "That line is already delivered. Do not repeat it.", isError: false };
              spoken.add(key);
              dialogue.add(text);
              dialogue.add(normalizedSpeech(line.name + ": " + text));
            }
            const playerJourney = (event: AppendableEvent) =>
              event.type === "journey_completed" && event.characterId === state.playerCharacterId;
            if (outcome.events.some(playerJourney) && turnEvents.some((event) => event.type === "clock_advanced")) {
              throw new ToolRejected("Travel is one action. Ask the player to travel on their next turn.");
            }
            if (tool.name === "advance_time" && turnEvents.some(playerJourney)) {
              throw new ToolRejected("This trip already advanced time. Wait for the player's next action.");
            }
            turnEvents.push(...outcome.events);
            turnState = outcome.events.reduce(applyEvent, turnState);
            return { content: JSON.stringify(outcome.result), isError: false };
          } catch (err) {
            if (err instanceof ToolRejected) return { content: err.message, isError: true };
            unexpected ??= err;
            return { content: "The game hit an internal error applying this change.", isError: true };
          }
        },
      }));
      tools.push(recall);

      // Everything already summarized is replaced by its summary in the system prompt.
      const recent = store.transcript(campaignId).slice(state.summaries.scenes.at(-1)?.to ?? 0);
      const response = await model.runTurn(
        {
          tier: state.combat || playerText.length > 240 ? "strong" : "fast",
          system: systemPrompt(state) + (targets.length
            ? "\nThe player selected these NPC addressees: " + JSON.stringify(targets) +
              ". Use npc_say for replies by the selected NPCs who have something to say. Never substitute an unselected NPC."
            : addressee ? (canAnswer
            ? `\nThe player explicitly addresses NPC ${JSON.stringify(addressee.id)}. Send their dialogue via npc_say.`
            : "\nThe player explicitly addresses an unavailable NPC. Respond as Game Master and do not substitute another speaker.") : ""),
          messages: [...historyMessages(recent), currentTurnMessage(playerText, state)],
          tools,
          maxModelCalls: MAX_MODEL_CALLS_PER_TURN,
        },
        (delta) => {
          if (!(directSpeech && canAnswer) && !dialogue.has(normalizedSpeech(delta))) opts.onText?.(delta);
        },
      );
      if (unexpected) throw unexpected;

      let narration = dialogue.has(normalizedSpeech(response.text)) ? "" : response.text;
      const spoke = turnEvents.some((event) => event.type === "npc_spoke");
      if (!spoke && directSpeech && canAnswer && addressee && narration.trim()) {
        const npc = turnState.characters[addressee.id];
        if (npc && npc.hp > 0 && npc.location === turnState.characters[turnState.playerCharacterId]?.location && !narration.includes("**")) {
          turnEvents.push({ type: "npc_spoke", characterId: npc.id, name: npc.name, text: narration });
          narration = "";
        }
      }
      if (!narration.trim() && !turnEvents.some((event) => event.type === "npc_spoke")) {
        narration = STALLED_NARRATION;
        opts.onText?.(narration);
      }
      if (narration.trim()) turnEvents.push({ type: "gm_narrated", text: narration });
      if (response.usage) turnEvents.push({ type: "ai_used", usage: response.usage });
      if (response.trace) turnEvents.push({ type: "ai_inspected", trace: response.trace });
      if (state.suggestions.length && !turnEvents.some((event) => event.type === "replies_suggested")) {
        turnEvents.push({ type: "replies_suggested", replies: [] });
      }
      store.append(campaignId, turnEvents);
      return { narration };
    },
  };
}
