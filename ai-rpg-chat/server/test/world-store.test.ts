import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorldStore, WorldNotFound, type WorldStore } from "../src/world/world-store.js";
import { WorldInvalid } from "../src/world/world.js";
import { testWorld } from "./support/fixtures.js";

const { id: _id, ...doc } = testWorld();

let store: WorldStore;
beforeEach(() => {
  store = openWorldStore(":memory:");
});

describe("World store", () => {
  it("saves a World and lists it", () => {
    const saved = store.create(doc);
    expect(store.get(saved.id)).toEqual(saved);
    expect(store.get(saved.id).name).toBe("Eldoria");
    expect(store.list()).toEqual([{ id: saved.id, name: "Eldoria", updatedAt: expect.any(String) }]);
  });

  it("updates replace the whole World; an invalid update changes nothing", () => {
    const saved = store.create(doc);
    store.update(saved.id, { ...doc, name: "Eldoria Reborn" });
    expect(store.get(saved.id).name).toBe("Eldoria Reborn");

    expect(() => store.update(saved.id, { ...doc, characters: [] })).toThrow(WorldInvalid);
    expect(store.get(saved.id).name).toBe("Eldoria Reborn");
  });

  it("removed and unknown Worlds are not found", () => {
    const saved = store.create(doc);
    store.remove(saved.id);
    expect(() => store.get(saved.id)).toThrow(WorldNotFound);
    expect(() => store.update("nope", doc)).toThrow(WorldNotFound);
  });

  it("Worlds survive reopening the database file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "rpg-")), "game.db");
    const first = openWorldStore(file);
    const saved = first.create(doc);
    first.close();
    const reopened = openWorldStore(file);
    expect(reopened.get(saved.id).characters.map((c) => c.name)).toEqual(["Arin", "Bram"]);
    reopened.close();
  });
});
