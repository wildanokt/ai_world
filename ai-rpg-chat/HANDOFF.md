# Historical handoff: ai-rpg-chat before the Codex port

Current run instructions and feature status are in [README.md](README.md). The paths, engine, and milestone status below describe the original handoff.

For: GPT Codex (or any fresh coding agent), continuing until the game is finished.
Project: `D:\Code\Claude\ai-rpg-chat` (Windows 11, Node 26, npm workspaces `server` + `web`).

## If you received this as a zip
`ai-rpg-chat-handoff.zip` contains the full source (this file is `HANDOFF.md` at its root). Excluded on purpose:
`node_modules/` (run `npm install`), `data/` with the SQLite database (recreated and seeded with the Eldoria World on first start),
and `.env` (copy `.env.example` to `.env`; secrets are never shipped). If the original folder `D:\Code\Claude\ai-rpg-chat` is available, work there instead.

## Hard rules from the user (do not break)
- **Do not push to GitHub.** No remote, no repo, no push until the user says otherwise ("gausah dipush ke github dulu").
- **No commits unless the user asks.** The folder is not even a git repo yet; don't `git init` unasked.
- **Never print or paste secrets.** `.env` is git-ignored and server-side only. Don't echo keys or tokens.
- **Test-first for game logic.** Write a failing vitest first, then the code (tests live in `server/test/`).
- Reply in the player's/user's language when they write Indonesian; code and docs stay English.

## Read these first (source of truth; not repeated here)
- `README.md` — run steps, AI engine setup, current status.
- `docs/design-decisions.md` — every decision from the design interview and milestones 1–3 (start here).
- `GLOSSARY.md` — domain vocabulary (World, Campaign, Game Master, NPC Memory, Recall, God Console, God's Blessing/Curse, Draft, Snapshot, Branch, Offscreen Tick, Journal, Portrait…). Use these terms in code and UI.
- `docs/adr/0001-sqlite-event-log.md`, `0002-code-authoritative-game-state.md`, `0003-worlds-are-documents-campaigns-copy-them.md`.
- `docs/future/model-provider-switch.md`, `docs/future/postgres-migration.md` — planned later, not now.
- `.env.example` — every config variable.

## Status
- Milestone 1 (core chat loop) — done.
- Milestone 2 (God Console: World + Character editors, AI Drafts from keywords) — done.
- Milestone 3 (NPC Memory, Recall, rolling scene/chapter summaries) — done. 56 tests pass; `tsc` clean for server and web.
  - Verified live: NPC memory + relationship recorded and used by the GM; real summaries.
  - Not verified live: semantic Recall (no `OPENAI_API_KEY` yet; keyword FTS5 only), the real model choosing to call `recall`, chapter summaries in long play.
- **Remaining:** milestone 4 and milestone 5 (below).

## Architecture in one screen
- Event sourcing: append-only `events` table in `data/game.db` (SQLite via `node:sqlite`). State = reduce of events with `applyEvent` (`server/src/campaign/events.ts`); transcript derived from events; each turn commits atomically (`server/src/campaign/store.ts`).
- Code is authoritative: the model only changes state through tools (`server/src/game-master/tools.ts`, plus `recall` in `game-master.ts`). Tools validate with zod 4 and return errors to the model so it retries.
- Prompt building: `server/src/game-master/context.ts` (system prompt with world, PC, roster, summaries; per-turn `<scene>` + `<current_state>`).
- Model layer: `server/src/model/provider.ts` (`ModelProvider.runTurn`, provider owns the tool loop, tiers `fast`/`strong`).
  - `claude-account.ts` — **default engine**: Claude Agent SDK driving the bundled `claude.exe` with the machine's Claude CLI login (stored in `~/.claude`). In-process MCP tools named `mcp__game__*`. It strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` and an empty `CLAUDE_CODE_OAUTH_TOKEN` from the child env so the stored login is used.
  - `anthropic.ts` — alternative (`AI_ENGINE=anthropic-api`).
  - Models: fast `claude-haiku-5-5`, strong `claude-opus-5-5` (`MODEL_FAST`/`MODEL_STRONG`).
- Memory: `server/src/memory/search-index.ts` (FTS5 `search_fts` + optional sqlite-vec `vec0`, merged with reciprocal rank fusion), `embedder.ts` (OpenAI `text-embedding-3-small`), `summarizer.ts` (runs after each turn in the background).
- Worlds: `server/src/world/` — `world.ts` (schemas, `parseWorld`, `campaignStartFrom`, `uniqueId`), `world-store.ts`, `drafts.ts` (AI Drafts), `default-world.ts` (Eldoria seed).
- Rules: `server/src/rules/` (d20).
- HTTP: `server/src/main.ts` (Hono + SSE). Routes: `/api/worlds` CRUD, `/api/drafts/world|character`, `POST /api/campaigns`, `GET /api/campaigns/:id`, `POST /api/campaigns/:id/turns` (SSE `text`/`done`/`error`).
- Web: `web/src/App.tsx` (chat + character sheet with "People here"), `web/src/GodConsole.tsx` (`<dialog>` pop-up), `web/src/api.ts`, `web/src/styles.css`. React 19 + Vite on port 5173.
- Test helpers: `server/test/support/fixtures.ts` (`testWorld`, `testCampaignStart`), `server/test/support/scripted-model.ts` (fake `ModelProvider` with scripted responses and tool calls). Use the scripted model; never hit the real AI in unit tests.

## How to run / verify
- Install: `npm install` at the repo root.
- Server: `npm run dev:server` (port 8787; first start takes ~15 s; logs "AI engine: claude-account" and "Recall: keywords only…").
- Web: `npm run dev:web` (port 5173, proxies `/api`).
- Tests: `npm test --workspace server`. Typecheck: `npx tsc -p server --noEmit` and `npx tsc -p web --noEmit`.
- Real AI turns take 20–60 s each. If the Claude engine says not logged in, the user runs
  `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe auth login --claudeai` themself.
- Network quirks (corporate): `platform.claude.com` blocked; `api.anthropic.com` and `api.openai.com` reachable. Git Bash `curl` fails HTTPS with a TLS cert error — use Node `fetch` or PowerShell for outbound checks.

## Milestone 4 — Portraits, Journal, Snapshots/Branches, live God's Blessing
Design decisions already made with the user:
1. **Portraits** (per character): upload an image or AI-generate one with OpenAI Images (needs `OPENAI_API_KEY`; show a clear "set OPENAI_API_KEY" message without it). Edited in the God Console Character form; shown in the sheet / People here. Store files server-side (e.g. `data/portraits/`), keep only a reference in the World/character doc. Keys never reach the browser.
2. **Journal** (player-facing): quests, known people, places, notes. Should come from events (e.g. a GM tool like `journal_note` / quest events reduced in `applyEvent`), shown as a panel in the web app. Quest editor belongs to the God Console (Quest editor was in the original God Console scope alongside World/Character/Item editors).
3. **Snapshots / rewind with Branches**: because state is an event log, a Snapshot = a named event seq; rewinding to it archives the abandoned timeline as a Branch that can be revisited later (GLOSSARY definition). Never delete history. UI lives in the God Console. Consider an ADR for the branching model.
4. **Live god mode / God's Blessing**: editing a running campaign's characters/stats in the God Console appends an in-world event; the GM narrates it as a God's Blessing (or a God's Curse when the change is negative). A **silent toggle** applies the edit without narration. Editing the PC's stats must stay possible.
5. Also in God Console scope still missing: **Item editor**, **AI inspector** (view the prompts/tool calls of recent turns) and **AI settings** (models/effort). Fit them in M4 or M5.
6. Suggested quick replies for the player (designed; check whether already implemented in App.tsx before building).

## Milestone 5 — Combat, Offscreen Ticks, cost routing
1. **Combat**: structured light combat with custom d20 rules (initiative, attack vs defence, damage, HP). Death follows the World's `lethality` setting (see the `LETHALITY` map in `context.ts`). Code resolves rolls; the model narrates.
2. **Offscreen Tick**: light simulation — when the in-game clock advances, NPCs elsewhere move/act a little (cheap fast-tier call or rules-only). Location graph + in-game clock exist in the World doc; the clock may need adding to state.
3. **Cost routing + counter**: route simple turns to the fast tier and hard ones to strong; track token usage/cost per campaign and show a cost counter in the UI.
- After M5: update README status, GLOSSARY entries, and ADRs for any new decisions; final full test + typecheck + a short real-AI play-through.

## Suggested skills
Codex has no Claude Code Skill tool; treat these as workflows to imitate. If a Claude agent picks this up, call them by name:
- `tdd` — red-green-refactor for every game-logic change (required by the user).
- `domain-modeling` — when adding terms to `GLOSSARY.md` or writing ADRs (Snapshots/Branches, Journal, combat).
- `codebase-design` — deciding module seams (e.g. a `journal/` or `combat/` module).
- `run` — launching the server + web to see a change working.
- `claude-api` — before touching `server/src/model/*` (model ids, Agent SDK, caching).
- `impeccable` — UI polish for the Journal, Portraits and God Console panels.
- `code-review` / `security-review` — before telling the user a milestone is done (uploads and keys need care).

## Wrap-up expectations
At each milestone end: all tests pass, both typechecks clean, a short live check, README status updated, then ask the user before the next milestone. Still no commits/pushes unless asked.
