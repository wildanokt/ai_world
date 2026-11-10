import { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import type { Embedder } from "../memory/embedder.js";
import { createSearchIndex, type SearchHit } from "../memory/search-index.js";
import {
  applyEvent,
  type AppendableEvent,
  type CampaignEvent,
  type CampaignStart,
  type CampaignState,
  type TranscriptEntry,
  toTranscriptEntry,
} from "./events.js";

export interface Snapshot { id: string; name: string; seq: number }
export interface Branch { id: string; name: string }
export interface CampaignStore {
  inspect(campaignId: string): unknown[];
  snapshot(campaignId: string, name: string): Snapshot;
  rewind(campaignId: string, snapshotId: string): string | null;
  timeline(campaignId: string): { snapshots: Snapshot[]; branches: Branch[] };
  createCampaign(start: CampaignStart): string;
  append(campaignId: string, events: AppendableEvent[]): void;
  state(campaignId: string): CampaignState;
  transcript(campaignId: string): TranscriptEntry[];
  /** Recall: search the Campaign's full history, best match first. */
  search(campaignId: string, query: string, limit?: number): Promise<SearchHit[]>;
  /** Compute embeddings for history not yet embedded (no-op without an Embedder). */
  embedPending(): Promise<number>;
  close(): void;
}

export interface CampaignStoreOptions {
  /** Enables semantic Recall. Without it, Recall uses keywords only. */
  embedder?: Embedder;
}

/** Append-only event log in SQLite (see docs/adr/0001-sqlite-event-log.md). */
export function openCampaignStore(path: string, { embedder }: CampaignStoreOptions = {}): CampaignStore {
  const db = new DatabaseSync(path, { allowExtension: !!embedder });
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_branches (
      id TEXT PRIMARY KEY, root_id TEXT NOT NULL, name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS timeline_snapshots (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, name TEXT NOT NULL, seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      campaign_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (campaign_id, seq)
    );
  `);
  const insert = db.prepare(
    "INSERT INTO events (campaign_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const selectMaxSeq = db.prepare("SELECT MAX(seq) AS seq FROM events WHERE campaign_id = ?");
  const selectAll = db.prepare("SELECT seq, payload FROM events WHERE campaign_id = ? ORDER BY seq");
  const selectStart = db.prepare("SELECT payload FROM events WHERE campaign_id = ? AND seq = 0");
  const search = createSearchIndex(db, embedder);

  function events(campaignId: string): CampaignEvent[] {
    return selectAll
      .all(campaignId)
      .map((row) => JSON.parse(row.payload as string) as CampaignEvent);
  }

  /** Character id → name, for readable search entries. */
  function names(campaignId: string): Record<string, string> {
    const row = selectStart.get(campaignId);
    if (!row) return {};
    const state = applyEvent(null, JSON.parse(row.payload as string) as CampaignEvent);
    return Object.fromEntries(Object.values(state.characters).map((c) => [c.id, c.name]));
  }

  function inTransaction(fn: () => void) {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  if (search.needsBackfill) {
    const campaigns = db.prepare("SELECT DISTINCT campaign_id FROM events").all().map((r) => String(r.campaign_id));
    inTransaction(() => {
      for (const id of campaigns) {
        const n = names(id);
        for (const row of selectAll.all(id)) search.index(id, Number(row.seq), JSON.parse(row.payload as string), n);
      }
    });
  }

  const branch = db.prepare("SELECT root_id FROM timeline_branches WHERE id = ?");
  const saveBranch = db.prepare("INSERT OR IGNORE INTO timeline_branches VALUES (?, ?, ?)");
  const snapshotById = db.prepare("SELECT seq, name FROM timeline_snapshots WHERE id = ? AND campaign_id = ?");
  const prefix = db.prepare("SELECT * FROM events WHERE campaign_id = ? AND seq <= ? ORDER BY seq");
  const copySnapshots = db.prepare("SELECT name, seq FROM timeline_snapshots WHERE campaign_id = ? AND seq <= ?");
  const saveSnapshot = db.prepare("INSERT INTO timeline_snapshots VALUES (?, ?, ?, ?)");

  return {
    inspect(campaignId) {
      return db.prepare("SELECT payload FROM events WHERE campaign_id = ? AND type = 'ai_inspected' ORDER BY seq DESC LIMIT 5")
        .all(campaignId).map((row) => JSON.parse(String(row.payload)).trace);
    },

    snapshot(campaignId, name) {
      const last = selectMaxSeq.get(campaignId)?.seq;
      if (last == null) throw new Error(`Unknown campaign ${campaignId}`);
      const seq = Number(last);
      const id = ulid();
      saveSnapshot.run(id, campaignId, name, seq);
      return { id, name, seq };
    },

    rewind(campaignId, snapshotId) {
      const snapshot = snapshotById.get(snapshotId, campaignId);
      if (!snapshot) return null;
      const id = ulid();
      const root = String(branch.get(campaignId)?.root_id ?? campaignId);
      const seq = Number(snapshot.seq);
      const n = names(campaignId);
      inTransaction(() => {
        saveBranch.run(campaignId, root, "Original timeline");
        saveBranch.run(id, root, `From ${snapshot.name}`);
        for (const row of prefix.all(campaignId, seq)) {
          insert.run(id, row.seq!, row.type!, row.payload!, row.created_at!);
          search.index(id, Number(row.seq), JSON.parse(String(row.payload)), n);
        }
        for (const row of copySnapshots.all(campaignId, seq)) {
          saveSnapshot.run(ulid(), id, row.name!, row.seq!);
        }
      });
      return id;
    },

    timeline(campaignId) {
      const root = String(branch.get(campaignId)?.root_id ?? campaignId);
      const snapshots = db.prepare("SELECT id, name, seq FROM timeline_snapshots WHERE campaign_id = ? ORDER BY id").all(campaignId);
      const branches = db.prepare("SELECT id, name FROM timeline_branches WHERE root_id = ? AND id <> ? ORDER BY id").all(root, campaignId);
      return {
        snapshots: snapshots.map((row) => ({ id: String(row.id), name: String(row.name), seq: Number(row.seq) })),
        branches: branches.map((row) => ({ id: String(row.id), name: String(row.name) })),
      };
    },

    createCampaign(start) {
      const id = ulid();
      const event: CampaignEvent = { type: "campaign_started", ...start };
      insert.run(id, 0, event.type, JSON.stringify(event), new Date().toISOString());
      return id;
    },

    append(campaignId, newEvents) {
      const last = selectMaxSeq.get(campaignId)?.seq;
      if (last === null || last === undefined) throw new Error(`Unknown campaign ${campaignId}`);
      let seq = Number(last);
      const now = new Date().toISOString();
      const n = names(campaignId);
      inTransaction(() => {
        for (const event of newEvents) {
          insert.run(campaignId, ++seq, event.type, JSON.stringify(event), now);
          search.index(campaignId, seq, event, n);
        }
      });
    },

    state(campaignId) {
      const state = events(campaignId).reduce<CampaignState | null>(applyEvent, null);
      if (!state) throw new Error(`Unknown campaign ${campaignId}`);
      return state;
    },

    transcript(campaignId) {
      return events(campaignId)
        .map(toTranscriptEntry)
        .filter((e): e is TranscriptEntry => e !== null);
    },

    search: (campaignId, query, limit) => search.search(campaignId, query, limit),
    embedPending: () => search.embedPending(),

    close() {
      db.close();
    },
  };
}
