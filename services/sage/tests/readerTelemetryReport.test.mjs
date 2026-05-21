/**
 * @file Unit tests for redacted reader telemetry report aggregation.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {buildReaderTelemetryReport} from "../lib/readerTelemetryReport.mjs";

const event = (metadata, overrides = {}) => ({
  eventId: `event-${metadata.type}-${metadata.pageIndex ?? 0}`,
  eventType: "reader-performance-slow",
  domain: "reader",
  severity: "warning",
  targetType: "reader-session",
  targetId: "dan-da-dan:dandadan-c166",
  createdAt: "2026-05-18T10:00:00.000Z",
  metadata,
  ...overrides
});

test("reader telemetry report groups waits, slow events, and retry spikes without raw URL leakage", () => {
  const report = buildReaderTelemetryReport([
    event({
      type: "caught-buffer",
      titleId: "dan-da-dan",
      chapterId: "dandadan-c166",
      pageIndex: 2,
      activeIndex: 1,
      durationMs: 460,
      decodedAhead: 0,
      queueDepth: 1,
      reason: "seek_metadata_missing",
      src: "https://reader.invalid/secret-page.jpg"
    }),
    event({
      type: "page-chunk-fetch",
      titleId: "dan-da-dan",
      chapterId: "dandadan-c166",
      pageIndex: 2,
      durationMs: 1250,
      rawPath: "/api/moon-v3/user/reader/title/dan-da-dan/chapter/dandadan-c166/pages?token=secret"
    }),
    event({
      type: "image-decode",
      titleId: "dan-da-dan",
      chapterId: "dandadan-c166",
      pageIndex: 2,
      durationMs: 710
    }),
    event({
      type: "image-auto-retry",
      titleId: "dan-da-dan",
      chapterId: "dandadan-c166",
      pageIndex: 2,
      retryCount: 2,
      reason: "load_error"
    }),
    event({
      type: "image-retry",
      titleId: "dan-da-dan",
      chapterId: "dandadan-c166",
      pageIndex: 2,
      retryCount: 1,
      reason: "visible_retry"
    })
  ], {
    since: "2026-05-18T00:00:00.000Z",
    generatedAt: "2026-05-18T11:00:00.000Z"
  });

  assert.equal(report.summary.caughtBufferWaits, 1);
  assert.equal(report.summary.slowEvents, 2);
  assert.equal(report.summary.retryAttempts, 3);
  assert.equal(report.caughtBuffer.topTargets[0].targetId, "dan-da-dan:dandadan-c166");
  assert.equal(report.slowEvents.byType.some((entry) => entry.type === "page-chunk-fetch"), true);
  assert.equal(report.slowEvents.byType.some((entry) => entry.type === "image-decode"), true);
  assert.equal(report.retries.spikes[0].retryAttempts, 3);
  assert.equal(report.recommendations.some((entry) => entry.id === "retry-spike"), true);
  assert.equal(JSON.stringify(report).includes("reader.invalid"), false);
  assert.equal(JSON.stringify(report).includes("token=secret"), false);
});
