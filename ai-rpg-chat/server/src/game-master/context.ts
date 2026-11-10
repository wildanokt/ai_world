import type { CampaignState, Character, Lethality, TranscriptEntry } from "../campaign/events.js";
import type { ConversationMessage } from "../model/provider.js";

const LETHALITY: Record<Lethality, string> = {
  forgiving:
    "forgiving. At 0 HP a character is knocked out or captured, never killed; the story continues with a setback.",
  standard:
    "standard. At 0 HP a character is dying: they die only if the danger continues and nobody helps; foreshadow lethal danger clearly.",
  deadly:
    "deadly. At 0 HP a character dies, the Player Character included. Danger is real, but always telegraph it first.",
};

const MEMORIES_IN_SCENE = 12;

/**
 * The slow-changing part of the Game Master's context: rules, the World, the Player Character,
 * where every NPC is, and summaries of earlier events.
 */
export function systemPrompt(state: CampaignState): string {
  const { world } = state;
  const lines = [
    `You are the Game Master of a single-player fantasy role-playing game set in the World of ${world.name}.`,
    "Narrate vividly but concisely (usually 1-3 short paragraphs), voice NPCs in character, and end on a moment that invites the player to act.",
    "Never decide the player character's actions or feelings for them.",
    "",
    "The game's code owns all state. You never change HP, items or location in prose alone: call the tools, then narrate what actually happened.",
    "When an action's outcome is uncertain, call skill_check and narrate according to the result; trivial actions need no roll.",
    "Use begin_combat and combat_action for fights, following initiative and never choosing the player's actions. Use end_combat when sides disengage.",
    "When time passes in the story use advance_time. Record discoveries and quests with journal_note. Use suggest_replies near the end of each turn.",
    "If a tool refuses a change, accept it and narrate accordingly.",
    "The current state is given inside <current_state> in the player's latest message; trust it over your memory.",
    "Reply in the same language the player writes in.",
    "",
    "NPC Memory: when an NPC witnesses or is told something they would remember, call remember. When the player's",
    "actions change how an NPC feels about them, call adjust_relationship. Let each present NPC's memories and",
    "relationship (given in <scene>) shape how they treat the player.",
    "If the player refers to something from long ago that is not in the conversation or the summaries, call recall.",
    "",
    "<world>",
  ];
  if (world.premise) lines.push(`Premise: ${world.premise}`);
  if (world.tone) lines.push(`Tone: ${world.tone}`);
  if (world.contentLimits) lines.push(`Content limits (always respect): ${world.contentLimits}`);
  lines.push(`Lethality: ${LETHALITY[world.lethality]}`);
  if (world.locations.length) {
    lines.push("Locations:", ...world.locations.map((l) => `- ${l.name}${l.description ? `: ${l.description}` : ""}${l.links?.length ? ` (links: ${l.links.join(", ")})` : ""}`));
  }
  if (world.items?.length) lines.push(`Item catalog: ${JSON.stringify(world.items)}`);
  if (world.quests?.length) lines.push(`Quest catalog for the GM only: ${JSON.stringify(world.quests)}`);
  lines.push("</world>", "");

  const pc = state.characters[state.playerCharacterId];
  if (pc) lines.push("<player_character>", describeCharacter(pc, true), "</player_character>", "");
  lines.push(
    "<roster>",
    "Every NPC and where they are. Full profiles are given in <scene> only for NPCs at the player's location.",
    ...Object.values(state.characters)
      .filter((c) => c.role === "npc")
      .map((c) => `- ${c.name} (id "${c.id}") at ${c.location}${c.hp === 0 ? ", down" : ""}`),
    "</roster>",
    "Secrets are for you alone: reveal them only when the player uncovers them through play.",
  );

  const summaries = storySoFar(state);
  if (summaries) lines.push("", "<summary_of_earlier_events>", summaries, "</summary_of_earlier_events>");
  return lines.join("\n");
}

/** Chapter summaries, then the scene summaries no chapter covers yet. */
function storySoFar({ summaries }: CampaignState): string {
  const chaptered = summaries.chapters.at(-1)?.toScene ?? 0;
  return [
    ...summaries.chapters.map((c, i) => `Chapter ${i + 1}: ${c.text}`),
    ...summaries.scenes.slice(chaptered).map((s) => `Then: ${s.text}`),
  ].join("\n\n");
}

export function attitude(score: number): string {
  if (score <= -6) return "hostile";
  if (score <= -2) return "wary";
  if (score < 2) return "neutral";
  if (score < 6) return "friendly";
  return "devoted";
}

/** NPCs at the Player Character's location, with full profile and NPC Memory. */
function describeScene(state: CampaignState): string {
  const pc = state.characters[state.playerCharacterId];
  const present = Object.values(state.characters).filter((c) => c.role === "npc" && c.location === pc?.location);
  if (present.length === 0) return "No NPCs from the roster are here.";
  return present
    .map((c) => {
      const memories = c.memories.slice(-MEMORIES_IN_SCENE);
      return [
        describeCharacter(c, false),
        `Relationship to the Player Character: ${c.relationship >= 0 ? "+" : ""}${c.relationship} (${attitude(c.relationship)})`,
        memories.length ? `Remembers:\n${memories.map((m) => `- ${m}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function describeCharacter(c: Character, isPlayer: boolean): string {
  const skills = Object.entries(c.skills)
    .map(([name, mod]) => `${name} ${mod >= 0 ? "+" : ""}${mod}`)
    .join(", ");
  const parts = [
    `## ${c.name} (id "${c.id}", ${isPlayer ? "Player Character" : "NPC"})`,
    c.profile.description && `Description: ${c.profile.description}`,
    c.profile.personality && `Personality: ${c.profile.personality}`,
    c.profile.goals && `Goals: ${c.profile.goals}`,
    c.profile.secrets && `Secrets: ${c.profile.secrets}`,
    skills && `Skills: ${skills}`,
  ];
  return parts.filter(Boolean).join("\n");
}

const describeRoll = (r: Extract<TranscriptEntry, { kind: "roll" }>) =>
  `[Roll — ${r.reason}: d20 ${r.roll} → ${r.total} vs ${r.difficulty}, ${
    r.critical ? `critical ${r.critical}` : r.success ? "success" : "failure"
  }]`;

/** Transcript entries as plain lines, for summarizing. */
export function transcriptText(entries: TranscriptEntry[]): string {
  return entries
    .map((e) => (e.kind === "player" ? `Player: ${e.text}` : e.kind === "gm" ? `Game Master: ${e.text}` : describeRoll(e)))
    .join("\n\n");
}

/** Earlier turns as model messages. Rolls are folded into the player turn they belong to. */
export function historyMessages(transcript: TranscriptEntry[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const entry of transcript) {
    const last = messages.at(-1);
    if (entry.kind === "gm") {
      if (last?.role === "assistant") last.text += `\n\n${entry.text}`;
      else messages.push({ role: "assistant", text: entry.text });
      continue;
    }
    const text = entry.kind === "player" ? entry.text : describeRoll(entry);
    if (last?.role === "user") last.text += `\n${text}`;
    else messages.push({ role: "user", text });
  }
  return messages;
}

/** The player's message plus what changes turn to turn: who is here, HP, locations, inventories. */
export function currentTurnMessage(playerText: string, state: CampaignState): ConversationMessage {
  const live = {
    playerCharacterId: state.playerCharacterId,
    clockMinutes: state.clock,
    combat: state.combat,
    journal: state.journal.slice(-20),
    characters: Object.values(state.characters).map(({ id, name, hp, maxHp, location, inventory, condition }) => ({
      id,
      name,
      hp,
      maxHp,
      location,
      inventory,
      condition,
    })),
  };
  return {
    role: "user",
    text: `${playerText}\n\n<scene>\n${describeScene(state)}\n</scene>\n\n<current_state>${JSON.stringify(live)}</current_state>`,
  };
}
