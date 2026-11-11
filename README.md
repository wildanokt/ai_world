# AI RPG Chat

Single-player fantasy RPG played through chat with an AI Game Master. See [the glossary](docs/GLOSSARY.md) and [architecture decisions](docs/adr).

## Run on Windows

1. Use Node.js 24.14+ or Node.js 26. Install Codex CLI and confirm `codex --version` and `codex login status`. If needed, run `codex login`. The server uses `codex.exe` on Windows or the executable set in `CODEX_BIN`.
2. Run `npm ci` from this folder.
3. In separate PowerShell windows, run `npm run dev:server` and `npm run dev:web`.
4. Open [http://127.0.0.1:5173](http://127.0.0.1:5173).

In the running game, open **God Console → Live Campaign → AI settings → Codex login**. **Check status** reads the stored CLI credential status. **Sign in with ChatGPT** or **Sign in again** opens the CLI’s browser sign-in flow.

The Game Master, AI Drafts, summaries and divine narration use Codex CLI with `gpt-6-luna`. Normal play uses the local CLI login. A turn can take several CLI calls when the Game Master needs game tools. Codex returns the narration at the end of the tool loop.

Copy `.env.example` to `.env` only to change settings. Adding `OPENAI_API_KEY` enables semantic Recall. Portrait generation uses GPT Images through the local Codex CLI ChatGPT login. Keyword Recall and Portrait upload work without an API key.

The server and Vite development UI bind to loopback. SQLite, images and saved reasoning settings live under `data/`. The God Console is for the local player and shows World secrets and recent AI prompts.

See the [player guide](docs/PLAY.md) for Campaign setup, travel, and gameplay.

## PostgreSQL and hosted login

Set `DATABASE_URL` or use `PGHOST`, `PGUSER`, and `PGDATABASE` to run the app on PostgreSQL. The app creates its tables on startup. For a migration, stop SQLite writes and set `RPG_IMPORT_SQLITE` to the old `game.db` on the first PostgreSQL run. The import only populates an empty game database and preserves World, Campaign, and timeline IDs. Copy the existing portraits directory separately if you move hosts.

Set `RPG_PUBLIC_ORIGIN` to your HTTPS app URL to require app login. Serve `web/dist` and proxy `/api` on the same hostname, passing the original Origin header and the backend's loopback Host. With the PostgreSQL environment set, run `node --import tsx server/src/auth/set-password.ts EMAIL` from the repo root and supply the password on stdin. Running it again resets the password and revokes previous sessions.

On the hosted app, open **God Console → Live Campaign → AI settings → Codex login**. **Sign in with ChatGPT** opens normal Codex sign-in in your browser. Copy the full `127.0.0.1` address from the last tab, paste it back into the same AI World session, and select **Finish sign-in**. **Use device code** is also available if enabled in your ChatGPT settings. The Codex CLI running on the host saves the session for the API's OS user.

## Verify

Run `npm test`, `npm run typecheck`, and `npm run build --workspace web`. Unit tests use scripted responses and local SQLite. The [original handoff](docs/HANDOFF.md) records the pre-port version.

Set `RPG_TEST_POSTGRES=1` with PostgreSQL connection variables and a test database role that can create schemas to run the PostgreSQL integration test.
