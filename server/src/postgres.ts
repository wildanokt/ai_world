import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient } from "pg";
import { ulid } from "ulid";
import { applyEvent, toTranscriptEntry, type CampaignEvent, type CampaignState, type TranscriptEntry } from "./campaign/events.js";
import type { CampaignStore } from "./campaign/store.js";
import type { Embedder } from "./memory/embedder.js";
import { rankRecall, searchableText, type SearchHit } from "./memory/search-index.js";
import { parseWorld, type WorldDoc } from "./world/world.js";
import { WorldNotFound, type WorldStore } from "./world/world-store.js";

export type AsyncStore<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
export type RuntimeCampaignStore = CampaignStore | AsyncStore<CampaignStore>;

const schema = `
  CREATE TABLE IF NOT EXISTS timeline_branches (id text PRIMARY KEY, root_id text NOT NULL, name text NOT NULL);
  CREATE TABLE IF NOT EXISTS timeline_snapshots (id text PRIMARY KEY, campaign_id text NOT NULL, name text NOT NULL, seq integer NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    campaign_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, payload text NOT NULL,
    created_at text NOT NULL, PRIMARY KEY (campaign_id, seq)
  );
  CREATE TABLE IF NOT EXISTS worlds (id text PRIMARY KEY, name text NOT NULL, doc text NOT NULL, updated_at text NOT NULL);
  CREATE TABLE IF NOT EXISTS search_docs (
    campaign_id text NOT NULL, seq integer NOT NULL, kind text NOT NULL, text text NOT NULL,
    terms tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
    embedding real[], embedding_model text, PRIMARY KEY (campaign_id, seq)
  );
  CREATE INDEX IF NOT EXISTS search_docs_terms ON search_docs USING gin (terms);
  CREATE TABLE IF NOT EXISTS app_users (email text PRIMARY KEY, password_hash text NOT NULL);
  CREATE TABLE IF NOT EXISTS app_sessions (
    token_hash text PRIMARY KEY, email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS app_sessions_expires ON app_sessions (expires_at);
  CREATE TABLE IF NOT EXISTS app_login_limits (client text PRIMARY KEY, attempts integer NOT NULL, expires_at timestamptz NOT NULL);
`;

export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

function namesFromStart(start?: CampaignEvent) {
  const characters = start ? Object.values(applyEvent(null, start).characters) : [];
  return Object.fromEntries(characters.map(({ id, name }) => [id, name]));
}

async function indexEvent(client: PoolClient, id: string, seq: number, event: CampaignEvent, names: Record<string, string>) {
  const text = searchableText(event, names);
  if (text) await client.query("INSERT INTO search_docs (campaign_id, seq, kind, text) VALUES ($1, $2, $3, $4)", [id, seq, event.type, text]);
}

/** Import the authoritative SQLite tables into an empty destination, with original IDs and event order. */
export async function importSqlite(pool: Pool, path: string) {
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    await transaction(pool, async (client) => {
      await client.query("LOCK TABLE events, worlds, timeline_branches, timeline_snapshots IN EXCLUSIVE MODE");
      const { rows: [existing] } = await client.query("SELECT EXISTS (SELECT 1 FROM events UNION ALL SELECT 1 FROM worlds) AS found");
      if (existing?.found) return;
      const tables = [
        ["worlds", "id text, name text, doc text, updated_at text"],
        ["timeline_branches", "id text, root_id text, name text"],
        ["timeline_snapshots", "id text, campaign_id text, name text, seq integer"],
        ["events", "campaign_id text, seq integer, type text, payload text, created_at text"],
      ] as const;
      for (const [table, columns] of tables) {
        if (!source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
        const rows = source.prepare(`SELECT * FROM ${table}`).iterate();
        let batch = [];
        for (const row of rows) {
          batch.push(row);
          if (batch.length < 250) continue;
          await client.query(`INSERT INTO ${table} SELECT * FROM json_to_recordset($1) AS source(${columns})`, [JSON.stringify(batch)]);
          batch = [];
        }
        if (batch.length) await client.query(`INSERT INTO ${table} SELECT * FROM json_to_recordset($1) AS source(${columns})`, [JSON.stringify(batch)]);
      }
      const { rows } = await client.query<{ campaign_id: string; seq: number; payload: string }>("SELECT campaign_id, seq, payload FROM events ORDER BY campaign_id, seq");
      let names: Record<string, string> = {};
      for (const row of rows) {
        const event = JSON.parse(row.payload) as CampaignEvent;
        if (row.seq === 0) names = namesFromStart(event);
        await indexEvent(client, row.campaign_id, row.seq, event, names);
      }
    });
  } finally { source.close(); }
}

export async function openPostgres(connectionString?: string, embedder?: Embedder) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  pool.on("error", (error) => console.error("Idle PostgreSQL connection failed:", error.message));
  await pool.query(schema);
  const embeddingModel = embedder && `${embedder.model}:${embedder.dimensions}`;
  let pendingEmbedding: Promise<number> | undefined;

  async function events(id: string) {
    const { rows } = await pool.query<{ payload: string }>("SELECT payload FROM events WHERE campaign_id = $1 ORDER BY seq", [id]);
    return rows.map(({ payload }) => JSON.parse(payload) as CampaignEvent);
  }
  async function names(client: PoolClient, id: string) {
    const { rows: [row] } = await client.query<{ payload: string }>("SELECT payload FROM events WHERE campaign_id = $1 AND seq = 0", [id]);
    return namesFromStart(row && JSON.parse(row.payload));
  }
  async function embedPending() {
    if (!embedder) return 0;
    let count = 0;
    for (;;) {
      const { rows } = await pool.query<{ campaign_id: string; seq: number; text: string }>(
        "SELECT campaign_id, seq, text FROM search_docs WHERE embedding_model IS DISTINCT FROM $1 ORDER BY campaign_id, seq LIMIT 64", [embeddingModel]);
      if (!rows.length) return count;
      const embeddings = await embedder.embed(rows.map(({ text }) => text));
      await transaction(pool, async (client) => {
        for (const [i, row] of rows.entries()) {
          await client.query("UPDATE search_docs SET embedding = $3, embedding_model = $4 WHERE campaign_id = $1 AND seq = $2",
            [row.campaign_id, row.seq, [...embeddings[i]!], embeddingModel]);
        }
      });
      count += rows.length;
    }
  }

  const store: AsyncStore<CampaignStore> = {
    async inspect(id) {
      const { rows } = await pool.query<{ payload: string }>(
        "SELECT payload FROM events WHERE campaign_id = $1 AND type = 'ai_inspected' ORDER BY seq DESC LIMIT 5", [id]);
      return rows.map(({ payload }) => JSON.parse(payload).trace);
    },
    async snapshot(campaignId, name) {
      const id = ulid();
      const { rows: [snapshot] } = await pool.query<{ id: string; name: string; seq: number }>(
        "INSERT INTO timeline_snapshots SELECT $1, $2, $3, max(seq) FROM events WHERE campaign_id = $2 HAVING count(*) > 0 RETURNING id, name, seq",
        [id, campaignId, name]);
      if (!snapshot) throw new Error(`Unknown campaign ${campaignId}`);
      return snapshot;
    },
    async rewind(campaignId, snapshotId) {
      return transaction(pool, async (client) => {
        const { rows: [snapshot] } = await client.query<{ seq: number; name: string }>(
          "SELECT seq, name FROM timeline_snapshots WHERE id = $1 AND campaign_id = $2", [snapshotId, campaignId]);
        if (!snapshot) return null;
        const id = ulid();
        await client.query("INSERT INTO timeline_branches VALUES ($1, $1, 'Original timeline') ON CONFLICT DO NOTHING", [campaignId]);
        await client.query("INSERT INTO timeline_branches SELECT $1, root_id, $2 FROM timeline_branches WHERE id = $3", [id, `From ${snapshot.name}`, campaignId]);
        await client.query("INSERT INTO events SELECT $1, seq, type, payload, created_at FROM events WHERE campaign_id = $2 AND seq <= $3", [id, campaignId, snapshot.seq]);
        await client.query("INSERT INTO search_docs (campaign_id, seq, kind, text, embedding, embedding_model) SELECT $1, seq, kind, text, embedding, embedding_model FROM search_docs WHERE campaign_id = $2 AND seq <= $3", [id, campaignId, snapshot.seq]);
        const { rows: snapshots } = await client.query<{ seq: number; name: string }>(
          "SELECT seq, name FROM timeline_snapshots WHERE campaign_id = $1 AND seq <= $2", [campaignId, snapshot.seq]);
        for (const row of snapshots) await client.query("INSERT INTO timeline_snapshots VALUES ($1, $2, $3, $4)", [ulid(), id, row.name, row.seq]);
        return id;
      });
    },
    async timeline(id) {
      const [snapshots, branches] = await Promise.all([
        pool.query<{ id: string; name: string; seq: number }>("SELECT id, name, seq FROM timeline_snapshots WHERE campaign_id = $1 ORDER BY id", [id]),
        pool.query<{ id: string; name: string }>("SELECT id, name FROM timeline_branches WHERE id <> $1 AND root_id = coalesce((SELECT root_id FROM timeline_branches WHERE id = $1), $1) ORDER BY id", [id]),
      ]);
      return { snapshots: snapshots.rows, branches: branches.rows };
    },
    async createCampaign(start) {
      const id = ulid();
      await pool.query("INSERT INTO events VALUES ($1, 0, 'campaign_started', $2, $3)", [id, JSON.stringify({ ...start, type: "campaign_started" }), new Date().toISOString()]);
      return id;
    },
    async append(id, additions) {
      await transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [id]);
        const { rows: [last] } = await client.query<{ seq: number | null }>("SELECT max(seq) AS seq FROM events WHERE campaign_id = $1", [id]);
        if (last?.seq == null) throw new Error(`Unknown campaign ${id}`);
        let seq = last.seq;
        const characters = await names(client, id);
        const now = new Date().toISOString();
        for (const event of additions) {
          await client.query("INSERT INTO events VALUES ($1, $2, $3, $4, $5)", [id, ++seq, event.type, JSON.stringify(event), now]);
          await indexEvent(client, id, seq, event, characters);
        }
      });
    },
    async state(id) {
      const state = (await events(id)).reduce<CampaignState | null>(applyEvent, null);
      if (!state) throw new Error(`Unknown campaign ${id}`);
      return state;
    },
    async transcript(id) {
      return (await events(id)).map(toTranscriptEntry).filter((entry): entry is TranscriptEntry => entry !== null);
    },
    async search(id, query, limit = 5) {
      const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
      if (!words.length) return [];
      const keyword = await pool.query<SearchHit>(`
        SELECT seq, kind, text FROM search_docs, to_tsquery('simple', $2) AS q
        WHERE campaign_id = $1 AND terms @@ q ORDER BY ts_rank_cd(terms, q) DESC, seq DESC LIMIT 20
      `, [id, words.join(" | ")]);
      let semantic: SearchHit[] = [];
      if (embedder) {
        try {
          const [vector] = await embedder.embed([query]);
          const { rows } = await pool.query<SearchHit>(`
            SELECT seq, kind, text FROM search_docs
            WHERE campaign_id = $1 AND embedding_model = $2 AND embedding IS NOT NULL
            ORDER BY (SELECT sum(a::float8 * b) / nullif(sqrt(sum(a::float8 * a) * sum(b::float8 * b)), 0)
              FROM unnest(embedding, $3::real[]) AS value(a, b)) DESC NULLS LAST, seq DESC LIMIT 20
          `, [id, embeddingModel, [...vector!]]);
          semantic = rows;
        } catch (error) { console.warn("Semantic recall unavailable, using keywords only:", error); }
      }
      const docs = new Map([...keyword.rows, ...semantic].map((hit) => [hit.seq, hit]));
      return rankRecall([keyword.rows, semantic].map((rows) => rows.map(({ seq }) => seq)), limit).map((seq) => docs.get(seq)!);
    },
    embedPending: () => pendingEmbedding ??= embedPending().finally(() => { pendingEmbedding = undefined; }),
    close: () => pool.end(),
  };

  const worlds: AsyncStore<WorldStore> = {
    async list() {
      return (await pool.query<{ id: string; name: string; updatedAt: string }>(
        'SELECT id, name, updated_at AS "updatedAt" FROM worlds ORDER BY updated_at DESC')).rows;
    },
    async get(id) {
      const { rows: [row] } = await pool.query<{ doc: string }>("SELECT doc FROM worlds WHERE id = $1", [id]);
      if (!row) throw new WorldNotFound(`No World with id "${id}".`);
      return { id, ...JSON.parse(row.doc) as WorldDoc };
    },
    async create(input) {
      const doc = parseWorld(input);
      const id = ulid();
      await pool.query("INSERT INTO worlds VALUES ($1, $2, $3, $4)", [id, doc.name, JSON.stringify(doc), new Date().toISOString()]);
      return { id, ...doc };
    },
    async update(id, input) {
      const doc = parseWorld(input);
      const { rowCount } = await pool.query("UPDATE worlds SET name = $2, doc = $3, updated_at = $4 WHERE id = $1",
        [id, doc.name, JSON.stringify(doc), new Date().toISOString()]);
      if (!rowCount) throw new WorldNotFound(`No World with id "${id}".`);
      return { id, ...doc };
    },
    async remove(id) { await pool.query("DELETE FROM worlds WHERE id = $1", [id]); },
    close: () => pool.end(),
  };
  return { pool, store, worlds };
}
