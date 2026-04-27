/**
 * @file Tests for Moon admin status page group helpers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {resolveStatusGroupKey, toggleStatusGroupKey} from "../apps/admin-next/lib/statusGroups.js";

test("resolveStatusGroupKey prefers stable group fields before falling back to index", () => {
  assert.equal(resolveStatusGroupKey({id: "moon-id", service: "scriptarr-moon", label: "Moon"}, 2), "moon-id");
  assert.equal(resolveStatusGroupKey({service: "scriptarr-sage", label: "Sage"}, 3), "scriptarr-sage");
  assert.equal(resolveStatusGroupKey({label: "Warden"}, 4), "Warden");
  assert.equal(resolveStatusGroupKey({}, 5), "group-5");
});

test("toggleStatusGroupKey preserves multi-open status accordion state", () => {
  assert.deepEqual(toggleStatusGroupKey([], "Moon"), ["Moon"]);
  assert.deepEqual(toggleStatusGroupKey(["Moon"], "Sage"), ["Moon", "Sage"]);
  assert.deepEqual(toggleStatusGroupKey(["Moon", "Sage"], "Moon"), ["Sage"]);
  assert.deepEqual(toggleStatusGroupKey(["Sage"], ""), ["Sage"]);
});
