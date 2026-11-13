import test from "node:test";
import assert from "node:assert/strict";
import {readPendingRepair, repairRequest, savePendingRepair, selectableRepairChapters} from "../apps/admin-next/lib/chapterRepair.js";

test("an interrupted repair keeps its key for reordered identical selection", () => {
  const first = repairRequest(null, "title", ["b", "a"], () => "first");
  assert.equal(repairRequest(first, "title", ["a", "b"], () => {throw new Error("new key");}), first);
  assert.deepEqual(first.body, {chapterIds: ["a", "b"], requestId: "chapter-repair:first"});
  assert.notEqual(repairRequest(first, "other", ["a", "b"], () => "second"), first);
  assert.notEqual(repairRequest(first, "title", ["a"], () => "third"), first);
  assert.throws(() => repairRequest(null, "title", []));
  assert.throws(() => repairRequest(null, "title", Array.from({length: 51}, (_, i) => `${i}`)));
});
test("selected repair choices exclude healthy and unbound chapters", () => {
  const healthy = {id: "a", sourceUrl: "https://example.com/chapter/a", available: true, qualityStatus: "clean", missingPageCount: 0};
  const partial = {...healthy, id: "b", missingPageCount: 1};
  const gap = {...healthy, id: "c", available: false};
  assert.deepEqual(selectableRepairChapters([healthy, partial, gap, {...partial, sourceUrl: ""}]), [partial, gap]);
});


test("an unresolved receipt survives remounts and reloads for the same admin and selection", () => {
  const rows = new Map(), storage = {getItem: key => rows.get(key), setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key)};
  const original = repairRequest(null, "title", ["b", "a"], () => "first");
  savePendingRepair(storage, "owner", "title", original);
  const restored = readPendingRepair(storage, "owner", "title");
  assert.deepEqual(repairRequest(restored, "title", ["a", "b"], () => {throw Error("new identity");}), original);
  assert.equal(readPendingRepair(storage, "other-owner", "title"), null);
  assert.equal(readPendingRepair(storage, "owner", "other-title"), null);
  savePendingRepair(storage, "owner", "title", null);
  assert.equal(readPendingRepair(storage, "owner", "title"), null);
  savePendingRepair(storage, "owner", "title", {...original, scope: "tampered"});
  assert.equal(readPendingRepair(storage, "owner", "title"), null);
  assert.equal(readPendingRepair(null, "owner", "title"), null);
  assert.doesNotThrow(() => savePendingRepair(null, "owner", "title", original));
});
