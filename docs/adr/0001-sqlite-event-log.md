# Append-only event log in SQLite

Campaign history is stored as an append-only event log in SQLite, with current state derived from it. Old history is searched with FTS5 (keyword) and sqlite-vec (semantic). We chose this over Postgres + pgvector because the game is single-player and local, so one portable file is simpler. It also gives Snapshots, rewind, branching, and the AI inspector for free.

Status: accepted

## Consequences

- The log is never deleted or rewritten. Rewind archives the later events as a Branch.
- Storage access must stay behind a repository interface so a Postgres migration is possible later. See [the Postgres migration plan](../future/postgres-migration.md); it is not scheduled.
