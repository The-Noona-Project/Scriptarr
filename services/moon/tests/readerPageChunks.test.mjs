/**
 * @file Regression tests for reader page-chunk loading helpers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  beginReaderPageRequest,
  completeReaderPageRequest,
  hasReaderPageImages,
  hasReaderPageWindow,
  hasReaderPageRequestForChapter,
  mergeReaderPageRequestPages,
  mergeReaderPages,
  resolvePagedReaderWindowIndexes,
  resolveReaderPreloadConfig,
  resolveReaderPreloadPlan,
  resolveWebtoonLoadMoreAction,
  warmReaderPageImages
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

test("reader preload config adapts to constrained devices", () => {
  assert.deepEqual(resolveReaderPreloadConfig({
    effectiveType: "4g",
    viewportWidth: 1440,
    deviceMemory: 16
  }), {aheadCount: 10, previousCushion: 3, profile: "standard"});
  assert.deepEqual(resolveReaderPreloadConfig({
    saveData: true,
    effectiveType: "4g",
    viewportWidth: 1440,
    deviceMemory: 16
  }), {aheadCount: 4, previousCushion: 1, profile: "conservative"});
  assert.deepEqual(resolveReaderPreloadConfig({
    effectiveType: "2g",
    viewportWidth: 1440,
    deviceMemory: 16
  }), {aheadCount: 4, previousCushion: 1, profile: "conservative"});
});

test("paged reader window requires spread image metadata before navigation lands", () => {
  assert.deepEqual(resolvePagedReaderWindowIndexes({
    layoutMode: "manga-double",
    pageIndex: 7,
    pageCount: 10
  }), [6, 7]);
  assert.equal(hasReaderPageImages([
    {index: 6, src: "/page-6.jpg"},
    {index: 7, src: "/page-7.jpg"}
  ], [6, 7]), true);
  assert.equal(hasReaderPageImages([
    {index: 6, src: "/page-6.jpg"},
    {index: 7}
  ], [6, 7]), false);
});

test("reader page request merge keeps appended chunks when initial replace finishes late", () => {
  const pages = mergeReaderPageRequestPages({
    currentPages: [{index: 12}, {index: 13}],
    incomingPages: [{index: 0}, {index: 1}],
    replace: true,
    currentRevision: "rev-1",
    nextRevision: "rev-1"
  });

  assert.deepEqual(pages.map((page) => page.index), [0, 1, 12, 13]);
});

test("reader page request merge drops old revision pages on replacement", () => {
  const pages = mergeReaderPageRequestPages({
    currentPages: [{index: 12}, {index: 13}],
    incomingPages: [{index: 0}, {index: 1}],
    replace: true,
    currentRevision: "rev-1",
    nextRevision: "rev-2"
  });

  assert.deepEqual(pages.map((page) => page.index), [0, 1]);
});

test("reader page request tracker lets concurrent chapter chunks merge independently", () => {
  const inFlight = new Set();
  const first = beginReaderPageRequest(inFlight, {
    epoch: 1,
    chapterId: "chapter-252",
    cursor: 0,
    pageSize: 12,
    pageRevision: "rev-1"
  });
  const second = beginReaderPageRequest(inFlight, {
    epoch: 1,
    chapterId: "chapter-252",
    cursor: 12,
    pageSize: 12,
    pageRevision: "rev-1"
  });

  assert.equal(hasReaderPageRequestForChapter(inFlight, {epoch: 1, chapterId: "chapter-252"}), true);
  assert.equal(completeReaderPageRequest(inFlight, second), true);
  assert.equal(hasReaderPageRequestForChapter(inFlight, {epoch: 1, chapterId: "chapter-252"}), true);
  assert.equal(completeReaderPageRequest(inFlight, first), true);
  assert.equal(hasReaderPageRequestForChapter(inFlight, {epoch: 1, chapterId: "chapter-252"}), false);
});

test("reader page request tracker keeps duplicate prefetch attempts independent", () => {
  const inFlight = new Set();
  const first = beginReaderPageRequest(inFlight, {
    epoch: 1,
    chapterId: "chapter-252",
    cursor: 12,
    pageSize: 12,
    pageRevision: "rev-1",
    requestId: 1
  });
  const second = beginReaderPageRequest(inFlight, {
    epoch: 1,
    chapterId: "chapter-252",
    cursor: 12,
    pageSize: 12,
    pageRevision: "rev-1",
    requestId: 2
  });

  assert.equal(completeReaderPageRequest(inFlight, first), true);
  assert.equal(completeReaderPageRequest(inFlight, second), true);
});

test("reader page request tracker rejects stale tokens after a chapter reset", () => {
  const inFlight = new Set();
  const stale = beginReaderPageRequest(inFlight, {
    epoch: 1,
    chapterId: "chapter-252",
    cursor: 0,
    pageSize: 12,
    pageRevision: "rev-1",
    replace: true
  });

  inFlight.clear();

  assert.equal(completeReaderPageRequest(inFlight, stale), false);
});

test("webtoon preload plans the next three pages plus a previous cushion", () => {
  const loaded = Array.from({length: 12}, (_value, index) => ({index}));
  const plan = resolveReaderPreloadPlan({
    layoutMode: "webtoon",
    activeIndex: 10,
    pageCount: 30,
    loadedPages: loaded,
    chunkSize: 12
  });

  assert.deepEqual(plan.warmIndexes, [9, 11, 12, 13]);
  assert.deepEqual(plan.metadataRequests, [{cursor: 12, pageSize: 12}]);
  assert.equal(plan.prefetchNextChapter, false);
});

test("webtoon preload favors the scroll direction while keeping a small opposite cushion", () => {
  const loaded = Array.from({length: 12}, (_value, index) => ({index}));
  const plan = resolveReaderPreloadPlan({
    layoutMode: "webtoon",
    activeIndex: 10,
    pageCount: 30,
    loadedPages: loaded,
    chunkSize: 12,
    aheadCount: 4,
    previousCushion: 1,
    scrollDirection: "backward"
  });

  assert.deepEqual(plan.warmIndexes, [6, 7, 8, 9, 11]);
  assert.deepEqual(plan.metadataRequests, []);
});

test("paged preload reaches three pages ahead and asks for next chapter prefetch near the end", () => {
  const loaded = Array.from({length: 18}, (_value, index) => ({index}));
  const plan = resolveReaderPreloadPlan({
    layoutMode: "single",
    activeIndex: 17,
    pageCount: 20,
    loadedPages: loaded,
    chunkSize: 12
  });

  assert.deepEqual(plan.warmIndexes, [18, 19]);
  assert.deepEqual(plan.metadataRequests, [{cursor: 18, pageSize: 2}]);
  assert.equal(plan.prefetchNextChapter, true);
});

test("reader image warmer decodes only requested loaded page images", async () => {
  const sources = [];
  class FakeImage {
    set src(value) {
      sources.push(value);
      setTimeout(() => this.onload?.(), 0);
    }

    decode() {
      return Promise.resolve();
    }
  }

  const result = await warmReaderPageImages([
    {index: 1, src: "/page-1.jpg"},
    {index: 2, src: "/page-2.jpg"}
  ], [2, 3], {imageFactory: FakeImage});

  assert.deepEqual(sources, ["/page-2.jpg"]);
  assert.deepEqual(result, [{index: 2, ok: true}]);
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
