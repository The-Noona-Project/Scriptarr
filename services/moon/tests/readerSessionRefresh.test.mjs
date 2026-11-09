/** @file Pure regressions for live reader refreshes, chapter fences and observable logical seeks. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  readerRouteKey,
  readerSessionContentKey,
  planReaderSessionRefresh,
  mergeReaderSessionMetadata,
  mergeReaderSessionBookmarks,
  dropReaderChapterPages,
  clearReaderChapterCaches,
  isReaderSessionCurrent,
  createReaderSeekRequest,
  applyReaderSeekRequest
} from "../apps/reader-next/lib/sessionRefresh.js";
import {
  beginReaderPageRequest,
  completeReaderPageRequest,
  hasReaderPageRequestForChapter,
  invalidateReaderPageRequestsForChapter
} from "../apps/reader-next/lib/pageChunks.js";

/** @param {Record<string, any>} [changes] Overrides. @returns {any} Representative logical reader session. */
const session = (changes = {}) => ({
  title: {id: "title-a", title: "A title"},
  chapter: {id: "chapter-a", pageCount: 39},
  pageRevision: "webp-original",
  pageCount: 39,
  preferences: {layoutMode: "webtoon", pageFit: "width"},
  progress: {bookmark: {pageIndex: 0}},
  bookmarks: [],
  ...changes
});
const route = readerRouteKey({userId: "reader-1", titleId: "title-a", chapterId: "chapter-a"});
/** @param {any} original Original session. @param {any} incoming Incoming session. @param {Record<string, any>} [options] Position overrides. @returns {any} Actual production refresh plan. */
const plan = (original, incoming, options = {}) => planReaderSessionRefresh({
  previous: {routeKey: route, session: original},
  routeKey: route,
  session: incoming,
  activeChapterId: "chapter-a",
  activePageIndex: 38,
  pagedChapterId: "chapter-a",
  pagedPageIndex: 17,
  ...options
});

test("route scope distinguishes authenticated identities and requested aliases without concatenation collisions", () => {
  assert.equal(readerRouteKey({userId: "reader-1", titleId: "title-a", chapterId: "chapter-a"}), route);
  assert.notEqual(readerRouteKey({userId: "reader-2", titleId: "title-a", chapterId: "chapter-a"}), route);
  assert.notEqual(readerRouteKey({userId: "reader-1", titleId: "alias-a", chapterId: "chapter-a"}), route);
  assert.notEqual(readerRouteKey({userId: "a,b", titleId: "c", chapterId: "d"}), readerRouteKey({userId: "a", titleId: "b,c", chapterId: "d"}));
});

test("content identity ignores progress and preferences but includes canonical chapter, revision and logical count", () => {
  const original = session();
  assert.equal(readerSessionContentKey(session({preferences: {layoutMode: "single"}, progress: {bookmark: {pageIndex: 38}}})), readerSessionContentKey(original));
  for (const incoming of [
    session({title: {id: "title-b"}}), session({chapter: {id: "chapter-b"}}),
    session({pageRevision: "webp-replacement"}), session({pageCount: 12})
  ]) assert.notEqual(readerSessionContentKey(incoming), readerSessionContentKey(original));
});

test("repeated SSE progress and preference refreshes retain both logical reading positions", () => {
  let previous = session();
  for (let index = 0; index < 12; index += 1) {
    const incoming = session({
      title: {id: "title-a", title: `Updated metadata ${index}`},
      progress: {bookmark: {pageIndex: index}},
      preferences: {layoutMode: index % 2 ? "single" : "webtoon", pageFit: "height"}
    });
    assert.deepEqual(plan(previous, incoming), {kind: "retain", chapterId: "chapter-a", activePageIndex: 38, pagedPageIndex: 17});
    previous = incoming;
  }
});

test("refresh of the original route does not bounce an active subsequent chapter", () => {
  const original = session();
  assert.deepEqual(plan(original, session({progress: {bookmark: {pageIndex: 2}}}), {
    activeChapterId: "chapter-b", activePageIndex: 21, pagedChapterId: "chapter-b", pagedPageIndex: 20
  }), {kind: "retain", chapterId: "chapter-a", activePageIndex: 21, pagedPageIndex: 20});
});

test("metadata merge replaces only refreshed session and retains loaded pages and unrelated session objects", () => {
  const original = session(), other = session({chapter: {id: "chapter-b"}}), incoming = session({title: {id: "title-a", title: "Updated"}});
  const sessions = new Map([["chapter-a", original], ["chapter-b", other]]);
  const pages = new Map([["chapter-a", [{index: 0}, {index: 38}]], ["chapter-b", [{index: 3}]]]);
  const firstPages = pages.get("chapter-a"), otherPages = pages.get("chapter-b"), merged = mergeReaderSessionMetadata(sessions, incoming);
  assert.equal(merged.get("chapter-a"), incoming);
  assert.equal(merged.get("chapter-b"), other);
  assert.equal(sessions.get("chapter-a"), original);
  assert.equal(pages.get("chapter-a"), firstPages);
  assert.equal(pages.get("chapter-b"), otherPages);
});

test("bookmark refresh replaces only matching chapter and retains other title and chapter scopes", () => {
  const current = [
    {id: "old", titleId: "title-a", chapterId: "chapter-a", pageIndex: 1},
    {id: "other-chapter", titleId: "title-a", chapterId: "chapter-b", pageIndex: 7},
    {id: "other-title", titleId: "title-b", chapterId: "chapter-a", pageIndex: 4}
  ];
  const fresh = {id: "new", titleId: "title-a", chapterId: "chapter-a", pageIndex: 38};
  assert.deepEqual(mergeReaderSessionBookmarks(current, session({bookmarks: [fresh]})), [current[1], current[2], fresh]);
  assert.equal(current.length, 3);
});

test("bookmark refresh accepts requested and canonical alias scopes and deduplicates stable bookmark IDs", () => {
  const unrelated = {id: "keep", titleId: "title-a", chapterId: "chapter-b", pageIndex: 8};
  const current = [
    {id: "old-alias", titleId: "requested-title", chapterId: "requested-chapter", pageIndex: 0},
    {id: "old-canonical", titleId: "title-a", chapterId: "chapter-a", pageIndex: 1}, unrelated
  ];
  const latest = {id: "bookmark-stable", titleId: "title-a", chapterId: "chapter-a", pageIndex: 23};
  const incoming = session({bookmarks: [
    {id: "bookmark-stable", titleId: "requested-title", chapterId: "requested-chapter", pageIndex: 22}, latest
  ]});
  assert.deepEqual(mergeReaderSessionBookmarks(current, incoming, {titleId: "requested-title", chapterId: "requested-chapter"}), [unrelated, latest]);
});

test("empty scoped bookmark result clears only the refreshed chapter", () => {
  const same = {id: "same", titleId: "title-a", chapterId: "chapter-a"}, other = {id: "other", titleId: "title-a", chapterId: "chapter-b"};
  assert.deepEqual(mergeReaderSessionBookmarks([same, other], session()), [other]);
});

test("changed revision invalidates only its chapter and clamps its active and paged logical indexes", () => {
  assert.deepEqual(plan(session(), session({pageRevision: "webp-new", pageCount: 7})), {
    kind: "invalidate", chapterId: "chapter-a", activePageIndex: 6, pagedPageIndex: 6
  });
});

test("changed logical count invalidates unchanged revision while leaving another active chapter position intact", () => {
  assert.deepEqual(plan(session(), session({pageCount: 3}), {activeChapterId: "chapter-b", activePageIndex: 21}), {
    kind: "invalidate", chapterId: "chapter-a", activePageIndex: 21, pagedPageIndex: 2
  });
  assert.deepEqual(plan(session(), session({pageCount: 3}), {pagedChapterId: "chapter-b", pagedPageIndex: 21}), {
    kind: "invalidate", chapterId: "chapter-a", activePageIndex: 2, pagedPageIndex: 21
  });
});

test("dropping invalidated page windows retains every other chapter and leaves original map intact", () => {
  const changedPages = [{index: 0}], otherPages = [{index: 12}], original = new Map([["chapter-a", changedPages], ["chapter-b", otherPages]]);
  const next = dropReaderChapterPages(original, "chapter-a");
  assert.equal(next.has("chapter-a"), false);
  assert.equal(next.get("chapter-b"), otherPages);
  assert.equal(original.get("chapter-a"), changedPages);
});

test("changed chapter cancels only its cache and warm controllers", () => {
  let abortedChanged = 0, abortedOther = 0;
  const otherSession = session({chapter: {id: "chapter-b"}}), cache = new Map([["chapter-a", session()], ["chapter-b", otherSession]]);
  const otherWarm = {chapterId: "chapter-b", controller: {abort: () => { abortedOther += 1; }}};
  const warm = new Map([
    ["a0", {chapterId: "chapter-a", controller: {abort: () => { abortedChanged += 1; }}}],
    ["a1", {chapterId: "chapter-a", controller: {abort: () => { abortedChanged += 1; }}}], ["b0", otherWarm]
  ]);
  clearReaderChapterCaches({chapterId: "chapter-a", sessionCache: cache, warmState: warm});
  assert.equal(cache.has("chapter-a"), false);
  assert.equal(cache.get("chapter-b"), otherSession);
  assert.equal(abortedChanged, 2);
  assert.equal(abortedOther, 0);
  assert.deepEqual([...warm.keys()], ["b0"]);
  assert.equal(warm.get("b0"), otherWarm);
});

test("revision fence rejects late completions but permits another chapter and the new revision request", () => {
  const inFlight = new Set();
  const old = beginReaderPageRequest(inFlight, {epoch: 8, chapterId: "chapter-a", cursor: 0, pageRevision: "webp-original", requestId: 1});
  const nearName = beginReaderPageRequest(inFlight, {epoch: 8, chapterId: "chapter-a-more", cursor: 0, pageRevision: "webp-original", requestId: 2});
  invalidateReaderPageRequestsForChapter(inFlight, {epoch: 8, chapterId: "chapter-a"});
  assert.equal(completeReaderPageRequest(inFlight, old), false);
  assert.equal(hasReaderPageRequestForChapter(inFlight, {epoch: 8, chapterId: "chapter-a"}), false);
  assert.equal(completeReaderPageRequest(inFlight, nearName), true);
  const next = beginReaderPageRequest(inFlight, {epoch: 8, chapterId: "chapter-a", cursor: 0, pageRevision: "webp-new", requestId: 3});
  assert.equal(completeReaderPageRequest(inFlight, next), true);
  assert.equal(completeReaderPageRequest(inFlight, next), false);
});

test("captured old revision or page count cannot publish after current content identity changes", () => {
  const original = session(), current = session({pageRevision: "webp-new"}), versions = new Map([["chapter-a", readerSessionContentKey(current)]]);
  assert.equal(isReaderSessionCurrent(versions, original), false);
  assert.equal(isReaderSessionCurrent(versions, current), true);
  const smaller = session({pageRevision: "webp-new", pageCount: 3});
  versions.set("chapter-a", readerSessionContentKey(smaller));
  assert.equal(isReaderSessionCurrent(versions, current), false);
  assert.equal(isReaderSessionCurrent(versions, smaller), true);
});

test("new route or authenticated identity requires bootstrap instead of retaining prior reader state", () => {
  const original = session();
  for (const nextRoute of [
    readerRouteKey({userId: "reader-2", titleId: "title-a", chapterId: "chapter-a"}),
    readerRouteKey({userId: "reader-1", titleId: "title-a", chapterId: "chapter-b"})
  ]) assert.equal(plan(original, session(), {routeKey: nextRoute}).kind, "bootstrap");
  assert.equal(plan(original, session(), {previous: undefined}).kind, "bootstrap");
  assert.equal(plan(original, session({chapter: {id: "chapter-b"}})).kind, "bootstrap");
});

test("loaded and repeated same-page seeks create separate observable requests and each scrolls", () => {
  const first = createReaderSeekRequest("chapter-a", 17), repeated = createReaderSeekRequest("chapter-a", 17), scrolls = [];
  assert.notEqual(first, repeated);
  assert.deepEqual(first, repeated);
  const context = {activeChapterId: "chapter-a", isPaged: false, findPage: () => ({scrollIntoView: value => scrolls.push(value)})};
  assert.equal(applyReaderSeekRequest(first, context), true);
  assert.equal(applyReaderSeekRequest(repeated, context), true);
  assert.deepEqual(scrolls, [{block: "center", behavior: "smooth"}, {block: "center", behavior: "smooth"}]);
});

test("unloaded seek remains pending until its exact logical page is available", () => {
  const pending = createReaderSeekRequest("chapter-a", 38);let loaded = false, scrolled = 0;
  const context = {activeChapterId: "chapter-a", isPaged: false, findPage: request => {
    assert.equal(request, pending);
    return loaded ? {scrollIntoView: () => { scrolled += 1; }} : null;
  }};
  assert.equal(applyReaderSeekRequest(pending, context), false);
  assert.equal(scrolled, 0);
  loaded = true;
  assert.equal(applyReaderSeekRequest(pending, context), true);
  assert.equal(scrolled, 1);
});

test("seek never looks up or scrolls a different chapter or paged reader", () => {
  const pending = createReaderSeekRequest("chapter-a", 9);
  const findPage = () => { throw new Error("Unrelated DOM lookup must not run"); };
  assert.equal(applyReaderSeekRequest(pending, {activeChapterId: "chapter-b", isPaged: false, findPage}), false);
  assert.equal(applyReaderSeekRequest(pending, {activeChapterId: "chapter-a", isPaged: true, findPage}), false);
  assert.equal(applyReaderSeekRequest(null, {activeChapterId: "chapter-a", isPaged: false, findPage}), false);
});
