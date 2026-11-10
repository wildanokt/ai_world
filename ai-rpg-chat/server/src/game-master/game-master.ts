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
}

export interface TurnResult {
  narration: string;
}

const MAX_MODEL_CALLS_PER_TURN = 8;
const RecallInput = z.object({ query: z.string().trim().min(1).max(300) });
const STALLED_NARRATION = "The moment stretches on, and the world seems to wait for your next move.";

export function createGameMaster(deps: GameMasterDeps) {
  const { store, model, d20 } = deps;

  return {
    async takeTurn(campaignId: string, playerText: string, opts: TurnOptions = {}): Promise<TurnResult> {
      const state = store.state(campaignId);

      // The whole turn is committed at once, so a failed turn leaves no trace.
      const turnEvents: AppendableEvent[] = [{ type: "player_said", text: playerText }];
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
          system: systemPrompt(state),
          messages: [...historyMessages(recent), currentTurnMessage(playerText, state)],
          tools,
          maxModelCalls: MAX_MODEL_CALLS_PER_TURN,
        },
        opts.onText,
      );
      if (unexpected) throw unexpected;

      let narration = response.text;
      if (narration.trim() === "") {
        narration = STALLED_NARRATION;
        opts.onText?.(narration);
      }
      turnEvents.push({ type: "gm_narrated", text: narration });
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
