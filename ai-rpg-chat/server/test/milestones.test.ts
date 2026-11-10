import { expect, it } from "vitest";
import { openCampaignStore } from "../src/campaign/store.js";
import { testCampaignStart } from "./support/fixtures.js";

it("rewinds to a snapshot without losing the original timeline or leaking its Recall", async () => {
  const store = openCampaignStore(":memory:");
  try {
    const original = store.createCampaign(testCampaignStart());
    store.append(original, [{ type: "gm_narrated", text: "The candle burns." }]);
    const snapshot = store.snapshot(original, "At the candle");
    store.append(original, [{ type: "gm_narrated", text: "The dragon returns." }]);
    const rewound = store.rewind(original, snapshot.id);
    if (!rewound) throw new Error("Expected a branch");
    expect(store.transcript(rewound)).toEqual([{ kind: "gm", text: "The candle burns." }]);
    expect(store.transcript(original)).toHaveLength(2);
    expect(await store.search(rewound, "dragon")).toEqual([]);
    expect(store.timeline(rewound).branches.map((branch) => branch.id)).toContain(original);
  } finally { store.close(); }
});

it("projects journal discoveries and keeps silent edits out of the transcript", () => {
  const store = openCampaignStore(":memory:");
  try {
    const id = store.createCampaign(testCampaignStart());
    const pc = store.state(id).playerCharacterId;
    store.append(id, [
      { type: "journal_recorded", kind: "person", text: "The innkeeper" },
      { type: "moved", characterId: pc, to: "Bridge" },
      { type: "character_edited", characterId: pc, patch: { maxHp: 50, hp: 25 } },
    ]);
    const state = store.state(id);
    expect(state.journal).toContainEqual({ kind: "person", text: "The innkeeper" });
    expect(state.journal).toContainEqual({ kind: "place", text: "Bridge" });
    expect(state.characters[pc]).toMatchObject({ maxHp: 50, hp: 25 });
    expect(store.transcript(id)).toEqual([]);
  } finally { store.close(); }
});
