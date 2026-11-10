# Design decisions

This file records the original design. See [README.md](../README.md) for current implementation and configuration.

The outcome of the design interview (grilling) that shaped this game, plus decisions made while building milestones 1–3.
Terms are defined in [GLOSSARY.md](../GLOSSARY.md); the reasoning behind the biggest choices is in [docs/adr/](adr/).
This file records *what* was decided so later work doesn't have to re-ask.

## The game
- Single-player RPG played almost entirely through chat. Fantasy is the default genre; a World can set its own.
- One experience that mixes three things: an AI Game Master, a stateful text adventure, and conversations with many NPCs.
- **Code owns the state; the AI proposes changes through tools** ([ADR 0002](adr/0002-code-authoritative-game-state.md)). The model never edits state directly.
- The Game Master replies in the player's language, whatever the World is written in.
- After each turn the player gets a few suggested quick replies, and can always type freely instead.

## Rules
- Custom d20 rules: roll d20 + modifier against a difficulty. A character's named skill sets the modifier.
- Light, structured combat (milestone 5): the code resolves initiative, attacks, damage and HP; the Game Master narrates the results.
- Death depends on the World's **lethality** setting (forgiving / standard / deadly): forgiving knocks out or captures at 0 HP, standard leaves a character dying until helped, deadly allows real death.
- The World has a location graph and an in-game clock. Characters are always at a location.
- When in-game time jumps, a light **Offscreen Tick** moves goal-driven NPCs along, recorded as events (milestone 5).

## Worlds and characters
- A World is an editable document; a Campaign copies it at the start, so editing a World never changes running Campaigns ([ADR 0003](adr/0003-worlds-are-documents-campaigns-copy-them.md)).
- Each World sets its premise, its **tone**, its **content limits** and its lethality. The Game Master follows the tone and content limits.
- A World has exactly one Player Character and any number of NPCs. The Player Character is made in the same editor as NPCs.
- Character Profiles can be written by hand or generated as an AI **Draft** from keywords. The user reviews a Draft before it is saved.
- The Player Character's stats stay editable at any time, during play too.
- **Portraits** are uploaded or AI-generated with OpenAI Images (milestone 4).

## NPC Memory and long history
- Each NPC keeps its own memory notes and a relationship score toward the Player Character, from -10 to 10, shown as an attitude: hostile, wary, neutral, friendly or devoted.
- Only NPCs in the current scene are given to the Game Master in full (profile, attitude, recent memories). The rest appear in a short roster.
- History must stay checkable long after it happened. Storage is an append-only SQLite event log ([ADR 0001](adr/0001-sqlite-event-log.md)) with FTS5 keyword search and sqlite-vec semantic search. Postgres is planned for later ([docs/future/postgres-migration.md](future/postgres-migration.md)).
- Embeddings use OpenAI `text-embedding-3-small`. Without an OpenAI key, Recall falls back to keyword search only.
- Older turns are condensed into rolling summaries: turns into scenes, scenes into chapters. The Game Master gets the summaries plus only the recent turns, and can **Recall** anything from the full log.

## The God Console
- One pop-up inside the game app, not a separate admin site.
- Its parts:
  - World editor: done.
  - Character editor: done.
  - Item editor and Quest editor: still to build.
  - Snapshots and rewind with Branches: milestone 4.
  - Live god mode: milestone 4.
  - AI inspector, showing recent prompts and tool calls: still to build.
  - AI settings, for models and effort: still to build.
- Live god mode: editing a running Campaign appears in the story as a **God's Blessing**, or a **God's Curse** when the edit is negative. A **silent** toggle applies the edit without narration.
- Rewinding to a Snapshot archives the abandoned timeline as a **Branch** that can be revisited later. Nothing is deleted.

## The player's view
- The chat, plus a character sheet: HP, location, the people here with their attitudes, and inventory.
- A **Journal** (milestone 4) with quests, people met, places visited and past events, limited to what the Player Character has learned.

## AI and configuration
- Claude models with routing: a fast tier (Haiku 5.5) for summaries and simple turns, and a strong tier (Opus 5.5) for Drafts and hard turns. A cost counter shows spending (milestone 5).
- The default engine is the machine's Claude CLI login through the Claude Agent SDK. The Anthropic API is an alternative. See [README.md](../README.md).
- A switch between model providers is planned for later ([docs/future/model-provider-switch.md](future/model-provider-switch.md)).
- Keys live in `.env` and are used only on the server, never sent to the browser.

## How we build
- Game logic is written test-first: a failing vitest, then the code. Unit tests use a scripted fake model, never the real AI.
- Build order:
  1. Core chat loop: done.
  2. World and Character editors in the God Console, with AI Drafts: done.
  3. NPC Memory, Recall and summaries: done.
  4. Portraits, Journal, Snapshots/Branches and live God's Blessing.
  5. Combat, Offscreen Ticks, and cost routing with the cost counter.
- The project stays local: no GitHub remote and no push until the owner says so. Nothing is committed unless the owner asks.
