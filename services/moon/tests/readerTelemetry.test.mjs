/**
 * @file Scriptarr Moon reader telemetry unit tests.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  countDecodedReaderPages,
  recordReaderTelemetry,
  sanitizeReaderTelemetryEvent,
  shouldPersistReaderTelemetryEvent
} from "../apps/reader-next/lib/readerTelemetry.js";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = originalWindow;
  }
  globalThis.fetch = originalFetch;
});

test("reader telemetry sanitizes identifiers and keeps durable-worthy events narrow", () => {
  const event = sanitizeReaderTelemetryEvent({
    type: "page-chunk-fetch",
    titleId: "dan da dan?token=secret",
    chapterId: "chapter/166",
    durationMs: 901.4,
    pageSize: 12,
    cursor: 24,
    reason: "x".repeat(200)
  });

  assert.equal(event.type, "page-chunk-fetch");
  assert.equal(event.titleId, "");
  assert.equal(event.chapterId, "");
  assert.equal(event.durationMs, 901);
  assert.equal(event.reason.length, 120);
  assert.equal(shouldPersistReaderTelemetryEvent(event), true);
  assert.equal(shouldPersistReaderTelemetryEvent({...event, durationMs: 100}), false);
  assert.equal(shouldPersistReaderTelemetryEvent({type: "image-retry", retryCount: 1}), true);
  assert.equal(shouldPersistReaderTelemetryEvent({type: "caught-buffer"}), true);
});

test("reader telemetry writes a fixed local buffer and posts only slow summaries", () => {
  const sent = [];
  globalThis.window = {};
  globalThis.fetch = async (_url, options = {}) => {
    sent.push(JSON.parse(String(options.body || "{}")));
    return {ok: true};
  };

  for (let index = 0; index < 245; index += 1) {
    recordReaderTelemetry({type: "preload-queue", titleId: "title", chapterId: "chapter", queueDepth: index});
  }
  assert.equal(globalThis.window.__scriptarrReaderTelemetry.events.length, 240);
  assert.equal(sent.length, 0);

  recordReaderTelemetry({type: "image-decode", titleId: "title", chapterId: "chapter", pageIndex: 1, durationMs: 350});
  recordReaderTelemetry({type: "image-retry", titleId: "title", chapterId: "chapter", pageIndex: 1, retryCount: 1});

  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((entry) => entry.type), ["image-decode", "image-retry"]);
  assert.equal(sent.every((entry) => Object.hasOwn(entry, "src") === false), true);
});

test("reader telemetry counts decoded pages ahead and behind the active page", () => {
  const counts = countDecodedReaderPages([
    {chapterId: "c1", pageIndex: 1, status: "ready"},
    {chapterId: "c1", pageIndex: 2, status: "ready"},
    {chapterId: "c1", pageIndex: 4, status: "ready"},
    {chapterId: "c2", pageIndex: 5, status: "ready"},
    {chapterId: "c1", pageIndex: 6, status: "error"}
  ], {chapterId: "c1", activeIndex: 2});

  assert.deepEqual(counts, {decodedAhead: 1, decodedBehind: 1, decodedTotal: 3});
});
