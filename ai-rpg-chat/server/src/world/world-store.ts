import { DatabaseSync } from "node:sqlite";
import { ulid } from "ulid";
import { parseWorld, type World, type WorldDoc } from "./world.js";

export class WorldNotFound extends Error {}

export interface WorldSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export interface WorldStore {
  list(): WorldSummary[];
  get(id: string): World;
  /** Validates, then saves. Throws WorldInvalid. */
  create(doc: unknown): World;
  update(id: string, doc: unknown): World;
  remove(id: string): void;
  close(): void;
}

/**
 * Worlds are editable templates, so unlike Campaigns they are stored as whole documents,
 * not as an event log. A Campaign copies its World when it starts.
 */
export function openWorldStore(path: string): WorldStore {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      doc TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare("INSERT INTO worlds (id, name, doc, updated_at) VALUES (?, ?, ?, ?)");
  const replace = db.prepare("UPDATE worlds SET name = ?, doc = ?, updated_at = ? WHERE id = ?");
  const selectOne = db.prepare("SELECT doc FROM worlds WHERE id = ?");
  const selectAll = db.prepare("SELECT id, name, updated_at FROM worlds ORDER BY updated_at DESC");
  const deleteOne = db.prepare("DELETE FROM worlds WHERE id = ?");

  const get = (id: string): World => {
    const row = selectOne.get(id);
    if (!row) throw new WorldNotFound(`No World with id "${id}".`);
    return { id, ...(JSON.parse(row.doc as string) as WorldDoc) };
  };

  return {
    list: () =>
      selectAll.all().map((r) => ({ id: r.id as string, name: r.name as string, updatedAt: r.updated_at as string })),
    get,
    create(input) {
      const doc = parseWorld(input);
      const id = ulid();
      insert.run(id, doc.name, JSON.stringify(doc), new Date().toISOString());
      return { id, ...doc };
    },
    update(id, input) {
      get(id);
      const doc = parseWorld(input);
      replace.run(doc.name, JSON.stringify(doc), new Date().toISOString(), id);
      return { id, ...doc };
    },
    remove(id) {
      deleteOne.run(id);
    },
    close() {
      db.close();
    },
  };
}
