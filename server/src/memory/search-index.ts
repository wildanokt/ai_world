/**
 * Recall's index over a Campaign's full history: SQLite FTS5 for keywords, plus sqlite-vec for
 * meaning when an Embedder is configured. The two rankings are merged with reciprocal rank fusion.
 * The event log stays the source of truth; this index can always be rebuilt from it.
 */
import type { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import type { CampaignEvent } from "../campaign/events.js";
import type { Embedder } from "./embedder.js";

export interface SearchHit {
  /** Event number in the Campaign's log. */
  seq: number;
  kind: string;
  text: string;
}

const CANDIDATES = 20;
const RRF_K = 60;

/** The searchable text of an event, or null if it is not worth recalling. */
export function searchableText(event: CampaignEvent, names: Record<string, string>): string | null {
  switch (event.type) {
    case "player_said":
    case "gm_narrated":
    case "scene_summarized":
    case "chapter_summarized":
      return event.text;
    case "npc_spoke":
      return `${event.name}: ${event.text}`;
    case "npc_remembered":
      return `${names[event.characterId] ?? event.characterId} remembers: ${event.note}`;
    default:
      return null;
  }
}

export function rankRecall(rankings: number[][], limit: number): number[] {
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

export function createSearchIndex(db: DatabaseSync, embedder?: Embedder) {
  const existed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_docs'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_docs (
      id INTEGER PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      text, content='search_docs', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
    );
  `);
  const insertDoc = db.prepare("INSERT INTO search_docs (campaign_id, seq, kind, text) VALUES (?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO search_fts (rowid, text) VALUES (?, ?)");
  const selectDocs = db.prepare(
    `SELECT id, seq, kind, text FROM search_docs WHERE id IN (SELECT value FROM json_each(?))`,
  );
  const keywordSearch = db.prepare(`
    SELECT d.id FROM search_fts f JOIN search_docs d ON d.id = f.rowid
    WHERE search_fts MATCH ? AND d.campaign_id = ?
    ORDER BY bm25(search_fts) LIMIT ${CANDIDATES}
  `);

  let vectors: { pending: ReturnType<DatabaseSync["prepare"]>; insert: ReturnType<DatabaseSync["prepare"]>; knn: ReturnType<DatabaseSync["prepare"]> } | null = null;
  if (embedder) {
    sqliteVec.load(db);
    const table = `search_vec_${embedder.model.replace(/[^a-z0-9]+/gi, "_")}_${embedder.dimensions}`;
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(campaign_id TEXT PARTITION KEY, embedding FLOAT[${embedder.dimensions}])`,
    );
    vectors = {
      pending: db.prepare(
        `SELECT d.id, d.campaign_id, d.text FROM search_docs d WHERE NOT EXISTS (SELECT 1 FROM ${table} v WHERE v.rowid = d.id) ORDER BY d.id LIMIT 64`,
      ),
      insert: db.prepare(`INSERT INTO ${table} (rowid, campaign_id, embedding) VALUES (?, ?, ?)`),
      knn: db.prepare(
        `SELECT rowid AS id FROM ${table} WHERE embedding MATCH ? AND k = ${CANDIDATES} AND campaign_id = ? ORDER BY distance`,
      ),
    };
  }

  function index(campaignId: string, seq: number, event: CampaignEvent, names: Record<string, string>) {
    const text = searchableText(event, names);
    if (!text) return;
    const { lastInsertRowid } = insertDoc.run(campaignId, seq, event.type, text);
    insertFts.run(lastInsertRowid, text);
  }

  return {
    /** True if the index was just created, so existing history needs indexing. */
    needsBackfill: !existed,
    index,

    async search(campaignId: string, query: string, limit = 5): Promise<SearchHit[]> {
      const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
      if (words.length === 0) return [];
      const rankings: number[][] = [];
      const ftsQuery = words.map((w) => `"${w}"`).join(" OR ");
      rankings.push(keywordSearch.all(ftsQuery, campaignId).map((r) => Number(r.id)));

      if (vectors && embedder) {
        try {
          const [q] = await embedder.embed([query]);
          rankings.push(vectors.knn.all(q!, campaignId).map((r) => Number(r.id)));
        } catch (err) {
          console.warn("Semantic recall unavailable, using keywords only:", (err as Error).message);
        }
      }

      const top = rankRecall(rankings, limit);
      if (top.length === 0) return [];
      const docs = new Map(
        selectDocs.all(JSON.stringify(top)).map((r) => [Number(r.id), { seq: Number(r.seq), kind: String(r.kind), text: String(r.text) }]),
      );
      return top.map((id) => docs.get(id)!).filter(Boolean);
    },

    /** Embed everything not yet embedded. Returns how many entries were embedded. */
    async embedPending(): Promise<number> {
      if (!vectors || !embedder) return 0;
      let total = 0;
      for (;;) {
        const rows = vectors.pending.all();
        if (rows.length === 0) return total;
        const embeddings = await embedder.embed(rows.map((r) => String(r.text)));
        rows.forEach((r, i) => vectors!.insert.run(BigInt(Number(r.id)), String(r.campaign_id), embeddings[i]!));
        total += rows.length;
      }
    },
  };
}
