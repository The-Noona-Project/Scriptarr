import assert from "node:assert/strict";
import test from "node:test";
import {
  buildToastFingerprint,
  createToastDedupeState,
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

