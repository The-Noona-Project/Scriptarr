import assert from "node:assert/strict";
import test from "node:test";
import {
  buildToastFingerprint,
  createToastDedupeState,
  serializeToastDedupeState,
  shouldShowToast
} from "../apps/admin-next/lib/toastDedupe.js";

test("toast dedupe suppresses repeated live event ids", () => {
  const state = createToastDedupeState();
  assert.equal(shouldShowToast(state, {
    eventId: "event-1",
    category: "event",
    severity: "info",
    message: "raven created the Download Secret Lady task."
  }, {now: 1000}), true);
  assert.equal(shouldShowToast(state, {
    eventId: "event-1",
    category: "event",
    severity: "info",
    message: "raven created the Download Secret Lady task."
  }, {now: 2000}), false);
});

test("toast dedupe suppresses repeated live event messages inside the window", () => {
  const state = createToastDedupeState();
  const event = {
    category: "event",
    severity: "success",
    message: "raven created the Download Second Life Ranker task."
  };

  assert.equal(shouldShowToast(state, {...event, eventId: "event-1"}, {now: 1000}), true);
  assert.equal(shouldShowToast(state, {...event, eventId: "event-2"}, {now: 2000}), false);
  assert.equal(shouldShowToast(state, {...event, eventId: "event-3"}, {
    now: 62000,
    eventMessageTtlMs: 60000
  }), true);
});

test("toast dedupe keeps different live event statuses visible", () => {
  const state = createToastDedupeState();

  assert.equal(shouldShowToast(state, {
    category: "event",
    severity: "success",
    message: "raven cataloged Secret Lady in the library."
  }, {now: 1000}), true);
  assert.equal(shouldShowToast(state, {
    category: "event",
    severity: "warning",
    message: "raven moved the Secret Lady task to failed."
  }, {now: 2000}), true);
});

test("toast fingerprints normalize whitespace and case", () => {
  assert.equal(
    buildToastFingerprint({category: "event", severity: "info", message: " Raven   Created Task "}),
    "event|info|raven created task"
  );
});

test("toast dedupe can be serialized and hydrated across refreshes", () => {
  const state = createToastDedupeState();
  assert.equal(shouldShowToast(state, {
    eventId: "event-refresh-1",
    category: "event",
    severity: "info",
    message: "raven created a task."
  }, {now: 1000}), true);

  const snapshot = serializeToastDedupeState(state, {now: 2000});
  const hydrated = createToastDedupeState(snapshot);
  assert.equal(shouldShowToast(hydrated, {
    eventId: "event-refresh-1",
    category: "event",
    severity: "info",
    message: "raven created a task."
  }, {now: 3000}), false);
});

test("toast dedupe serialization prunes expired event ids", () => {
  const state = createToastDedupeState({
    ids: [["expired", 1000], ["fresh", 5000]],
    fingerprints: []
  });

  const snapshot = serializeToastDedupeState(state, {
    now: 7000,
    eventIdTtlMs: 2500
  });
  assert.deepEqual(snapshot.ids, [["fresh", 5000]]);
});
