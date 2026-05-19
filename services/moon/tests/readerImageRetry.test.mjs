/**
 * @file Unit tests for reader image retry helpers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReaderPageStatusUrl,
  resolveReaderImageRetryDelay,
  shouldAutoRetryReaderImage
} from "../apps/reader-next/lib/imageRetry.js";

test("reader image retry helper caps automatic retries", () => {
  assert.equal(shouldAutoRetryReaderImage(1), true);
  assert.equal(shouldAutoRetryReaderImage(3), true);
  assert.equal(shouldAutoRetryReaderImage(4), false);
});

test("reader image retry delay grows with deterministic jitter", () => {
  assert.equal(resolveReaderImageRetryDelay(1, 0), 220);
  assert.equal(resolveReaderImageRetryDelay(2, 0.5), 530);
  assert.equal(resolveReaderImageRetryDelay(3, 1), 1060);
  assert.equal(resolveReaderImageRetryDelay(1, "not-a-number"), 220);
});

test("reader page status URL preserves revision without exposing raw sources", () => {
  assert.equal(
    buildReaderPageStatusUrl("/api/moon/v3/user/reader/title/title-1/chapter/chapter-1/page/9?rev=abc123"),
    "/api/moon/v3/user/reader/title/title-1/chapter/chapter-1/page/9/status?rev=abc123"
  );
});
