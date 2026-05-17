/**
 * @file Regression tests for reader page-chunk loading helpers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  hasReaderPageWindow,
  mergeReaderPages,
  resolveWebtoonLoadMoreAction
} from "../apps/reader-next/lib/pageChunks.js";

test("reader page chunks append by index without duplicates or reordering", () => {
  const firstChunk = Array.from({length: 12}, (_value, index) => ({index, label: `Page ${index + 1}`}));
  const secondChunk = Array.from({length: 12}, (_value, offset) => ({index: offset + 12, label: `Page ${offset + 13}`}));
  const merged = mergeReaderPages(firstChunk, [
    secondChunk[2],
    {index: 11, label: "Updated page 12"},
    ...secondChunk
  ]);

  assert.equal(merged.length, 24);
  assert.deepEqual(merged.map((page) => page.index), Array.from({length: 24}, (_value, index) => index));
  assert.equal(merged[11].label, "Updated page 12");
});

test("reader page window detects missing chunk metadata", () => {
  const loaded = Array.from({length: 12}, (_value, index) => ({index}));

  assert.equal(hasReaderPageWindow(loaded, 0, 12, 71), true);
  assert.equal(hasReaderPageWindow(loaded, 12, 12, 71), false);
});

test("webtoon load-more waits while the first chunk is still loading", () => {
  const action = resolveWebtoonLoadMoreAction({
    session: {chapter: {id: "chapter-252"}, nextChapterId: "chapter-253"},
    entry: {loading: true, pageInfo: null, error: ""}
  });

  assert.deepEqual(action, {ready: false, done: false});
});

test("webtoon load-more uses pageInfo nextCursor before chapter navigation", () => {
  const action = resolveWebtoonLoadMoreAction({
    session: {chapter: {id: "chapter-252"}, nextChapterId: "chapter-253"},
    entry: {loading: false, pageInfo: {hasMore: true, nextCursor: "12"}, error: ""}
  });

  assert.deepEqual(action, {ready: true, done: false, cursor: "12", replace: false});
});

test("webtoon load-more retries a failed initial page chunk", () => {
  const action = resolveWebtoonLoadMoreAction({
    session: {chapter: {id: "chapter-252"}, nextChapterId: "chapter-253"},
    entry: {loading: false, pageInfo: null, error: "Could not load these pages."}
  });

  assert.deepEqual(action, {ready: true, done: false, cursor: 0, replace: true});
});
