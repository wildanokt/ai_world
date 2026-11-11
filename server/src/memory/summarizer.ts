/**
 * Rolling summaries: older turns are condensed into scene summaries, and scenes into chapters,
 * so every Game Master turn stays small. Nothing is deleted; Recall still searches the full log.
 */
import type { RuntimeCampaignStore } from "../postgres.js";
import { transcriptText } from "../game-master/context.js";
import type { ModelProvider } from "../model/provider.js";

export interface SummarizerOptions {
  store: RuntimeCampaignStore;
  model: ModelProvider;
  /** Summarize once this many transcript entries are unsummarized. */
  sceneEvery?: number;
  /** Entries left verbatim after summarizing, so the Game Master keeps the recent flow. */
  keepRecent?: number;
  /** Combine scenes into a chapter once this many scenes are not yet in a chapter. */
  chapterEvery?: number;
}

const SYSTEM = [
  "You summarize part of a role-playing game's story for the Game Master's memory.",
  "Keep what matters later: names, places, items gained or lost, promises, debts, secrets learned, relationships,",
  "and unresolved threads. Drop moment-to-moment description. Write plain prose in the past tense, under 200 words,",
  "in the same language as the story. Summarize only what the given part says; never guess what happened",
  "outside it. Reply with the summary text only, with no heading or preamble.",
].join(" ");

export function createSummarizer({ store, model, sceneEvery = 30, keepRecent = 10, chapterEvery = 6 }: SummarizerOptions) {
  const running = new Set<string>();

  async function summarize(prompt: string) {
    const response = await model.runTurn({
      tier: "fast",
      system: SYSTEM,
      messages: [{ role: "user", text: prompt }],
      tools: [],
      maxModelCalls: 1,
    });
    return { text: response.text.trim(), usage: response.usage };
  }

  async function step(campaignId: string) {
    const { summaries } = await store.state(campaignId);
    const transcript = await store.transcript(campaignId);

    const covered = summaries.scenes.at(-1)?.to ?? 0;
    if (transcript.length - covered >= sceneEvery) {
      // Cut only where a new turn begins, so no player message is separated from its outcome.
      let to = transcript.length - keepRecent;
      while (to > covered && transcript[to]?.kind !== "player") to--;
      if (to <= covered) return;
      const { text, usage } = await summarize(`<story_part>\n${transcriptText(transcript.slice(covered, to))}\n</story_part>`);
      if (text) await store.append(campaignId, [{ type: "scene_summarized", from: covered, to, text }]);
      if (usage) await store.append(campaignId, [{ type: "ai_used", usage }]);
    }

    const { scenes, chapters } = (await store.state(campaignId)).summaries;
    const chaptered = chapters.at(-1)?.toScene ?? 0;
    if (scenes.length - chaptered >= chapterEvery) {
      const part = scenes.slice(chaptered).map((s) => s.text).join("\n\n");
      const { text, usage } = await summarize(`<scene_summaries>\n${part}\n</scene_summaries>\nCombine these into one chapter summary.`);
      if (text) await store.append(campaignId, [{ type: "chapter_summarized", fromScene: chaptered, toScene: scenes.length, text }]);
      if (usage) await store.append(campaignId, [{ type: "ai_used", usage }]);
    }
  }

  return {
    /** Summarize if enough history has piled up. Safe to call after every turn. */
    async maybeSummarize(campaignId: string): Promise<void> {
      if (running.has(campaignId)) return;
      running.add(campaignId);
      try {
        await step(campaignId);
      } finally {
        running.delete(campaignId);
      }
    },
  };
}
