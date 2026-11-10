# Future plan: migrate SQLite to Postgres

Not scheduled. Do this only if the game becomes multi-user or hosted, or if a single Campaign's history outgrows SQLite search performance.

## Prerequisites (do now, cheap)

- All database access goes through repository interfaces (event log, state projections, search). No SQL outside the repositories.
- Use portable SQL where possible; keep SQLite-specific features (FTS5, sqlite-vec) isolated in the search repository.
- Keep IDs as UUIDs or ULIDs, not auto-increment integers.
- Keep uploaded images (Portraits) on a storage interface, not hardcoded local paths.

## Migration outline

1. Add a Postgres implementation of each repository interface.
2. Map keyword search from FTS5 to Postgres full-text search (`tsvector`).
3. Map semantic search from sqlite-vec to pgvector.
4. Write a one-time exporter that replays the SQLite event log into Postgres.
5. Verify by rebuilding derived state from the log and comparing it with the SQLite state.
6. Add auth and per-user ownership of Worlds and Campaigns (needed once hosted).
7. Switch via config flag; keep SQLite for local mode.
