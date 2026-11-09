/** @file Viewport tracking and delayed-layout logical seek regressions. */
import test from "node:test";
import assert from "node:assert/strict";
import {webtoonReadingBand, webtoonSeekWindow, updateWebtoonCandidates, selectWebtoonPage, createWebtoonSeekAnchor,
  alignWebtoonSeekAnchor, cancelsWebtoonSeek} from "../apps/reader-next/lib/webtoonPosition.js";

/** @param {number} index Logical index. @param {number} top Viewport top. @param {number} height Logical rendered height. @returns {any} Measurable page. */
const page = (index, top, height) => ({isConnected: true, dataset: {chapterId: "chapter-a", pageIndex: String(index)},
  getBoundingClientRect: () => ({top, bottom: top + height, height})});

/** @param {{top?:number,height?:number,maxScroll?:number}} [options] Document geometry. @returns {any} Stateful scroll environment for actual production alignment. */
const environment = ({top = 1000, height = 1600, maxScroll = 20000} = {}) => {
  const state = {top, height, scrollY: 0, targetPresent: true, calls: []};
  const target = {getBoundingClientRect: () => ({top: state.top - state.scrollY,
    bottom: state.top - state.scrollY + state.height, height: state.height})};
  const context = {findPage: () => state.targetPresent ? target : null, viewportHeight: 855,
    getScrollY: () => state.scrollY, getMaxScrollY: () => maxScroll,
    scrollBy: value => { state.calls.push(value); state.scrollY = Math.max(0, Math.min(maxScroll, state.scrollY + value.top)); }};
  return {state, context};
};

test("landscape and portrait reading bands use viewport height and remain nonempty", () => {
  assert.deepEqual(webtoonReadingBand(855), {height: 855, top: 171, bottom: 384.75, anchor: 277.875});
  assert.deepEqual(webtoonReadingBand(1920), {height: 1920, top: 384, bottom: 864, anchor: 624});
  assert.ok(webtoonReadingBand(0).bottom > webtoonReadingBand(0).top);
});

test("observer delta retains already intersecting logical pages when another entry changes", () => {
  const a = page(3, -1000, 1200), b = page(35, 200, 1534), incoming = page(38, 820, 1600), candidates = new Set();
  updateWebtoonCandidates(candidates, [{target: a, isIntersecting: true}, {target: b, isIntersecting: true}]);
  updateWebtoonCandidates(candidates, [{target: a, isIntersecting: false}, {target: incoming, isIntersecting: true}]);
  assert.equal(candidates.has(b), true);
  assert.equal(selectWebtoonPage(candidates, 855).pageIndex, 35);
});

test("very tall pages remain selectable without a minimum intersection ratio", () => {
  const tall = page(7, -50000, 100000), next = page(8, 850, 5);
  assert.equal(selectWebtoonPage([tall, next], 855).pageIndex, 7);
  assert.equal(selectWebtoonPage([page(38, 810, 20)], 855).pageIndex, 38);
});

test("selection reads current geometry instead of stale observer entry rectangles", () => {
  let firstTop = 0, secondTop = 1200;
  const first = page(0, 0, 1000), second = page(1, 1200, 1000);
  first.getBoundingClientRect = () => ({top: firstTop, bottom: firstTop + 1000});
  second.getBoundingClientRect = () => ({top: secondTop, bottom: secondTop + 1000});
  const candidates = new Set([first, second]);
  assert.equal(selectWebtoonPage(candidates, 855).pageIndex, 0);
  firstTop = -1100; secondTop = 100;
  assert.equal(selectWebtoonPage(candidates, 855).pageIndex, 1);
});

test("disconnected and offscreen frames cannot replace a visible logical page", () => {
  const removed = page(0, 100, 1600);removed.isConnected = false;
  assert.equal(selectWebtoonPage([removed, page(1, -2000, 1000), page(2, 900, 100)], 855), null);
});

test("unloaded seek waits for its target and aligns instantly before two stable frames", () => {
  // Reloading a saved last-page bookmark requests only its bounded target window, not the whole chapter.
  assert.deepEqual(webtoonSeekWindow({pageIndex: 38, pageCount: 39}), {pageIndex: 38, cursor: 35, pageSize: 4});
  assert.deepEqual(webtoonSeekWindow({pageIndex: 0, pageCount: 39}), {pageIndex: 0, cursor: 0, pageSize: 18});
  assert.deepEqual(webtoonSeekWindow({pageIndex: 1000, pageCount: 39}), {pageIndex: 38, cursor: 35, pageSize: 4});
  const {state, context} = environment(), anchor = createWebtoonSeekAnchor({chapterId: "chapter-a", pageIndex: 38});
  state.targetPresent = false;
  assert.deepEqual(alignWebtoonSeekAnchor(anchor, context), {found: false, settled: false});
  assert.equal(state.calls.length, 0);
  state.targetPresent = true;
  assert.equal(alignWebtoonSeekAnchor(anchor, context).settled, false);
  assert.equal(alignWebtoonSeekAnchor(anchor, context).settled, true);
  assert.equal(state.top - state.scrollY, 171);
  assert.ok(state.calls.every(value => value.behavior === "instant"));
});

test("seek does not consume while another chapter metadata window can still insert pages", () => {
  const {context} = environment(), anchor = createWebtoonSeekAnchor({chapterId: "chapter-a", pageIndex: 38});
  for (let index = 0; index < 5; index += 1) assert.equal(alignWebtoonSeekAnchor(anchor, {...context, metadataLoading: true}).settled, false);
  assert.equal(alignWebtoonSeekAnchor(anchor, context).settled, false);
  assert.equal(alignWebtoonSeekAnchor(anchor, context).settled, true);
});

test("passive anchor preserves a settled logical target after delayed prefix insertion resumes", () => {
  const {state, context} = environment(), request = {chapterId: "chapter-a", pageIndex: 38}, anchor = createWebtoonSeekAnchor(request);
  alignWebtoonSeekAnchor(anchor, context);
  assert.equal(alignWebtoonSeekAnchor(anchor, context).settled, true);
  const before = state.scrollY;
  // The automatic load-more gap arrives AFTER preparing completed, not during its two-frame check.
  state.top += 6200;
  alignWebtoonSeekAnchor(anchor, context);
  assert.equal(state.scrollY, before + 6200);
  assert.equal(state.top - state.scrollY, 171);
  assert.equal(anchor.request, request);
});

test("late image geometry changes reset stabilization without losing the logical request", () => {
  const {state, context} = environment({height: 80}), anchor = createWebtoonSeekAnchor({chapterId: "chapter-a", pageIndex: 3});
  assert.equal(alignWebtoonSeekAnchor(anchor, context).settled, false);
  state.height = 1600;
  assert.equal(alignWebtoonSeekAnchor(anchor, context).settled, false);
  assert.equal(alignWebtoonSeekAnchor(anchor, context).settled, true);
  assert.equal(state.top - state.scrollY, 171);
});

test("first and short last pages settle at real document scroll boundaries", () => {
  for (const options of [{top: 0, height: 1600, maxScroll: 1000}, {top: 1000, height: 20, maxScroll: 300}]) {
    const {context} = environment(options), anchor = createWebtoonSeekAnchor({chapterId: "chapter-a", pageIndex: 0});
    alignWebtoonSeekAnchor(anchor, context);
    assert.equal(alignWebtoonSeekAnchor(anchor, context).settled, true);
  }
});

test("repeated loaded seeks get independent stabilization state", () => {
  const request = {chapterId: "chapter-a", pageIndex: 38}, first = createWebtoonSeekAnchor(request), second = createWebtoonSeekAnchor({...request});
  const {context} = environment();
  alignWebtoonSeekAnchor(first, context);alignWebtoonSeekAnchor(first, context);
  assert.equal(first.stableFrames, 2);
  assert.equal(second.stableFrames, 0);
  assert.notEqual(first, second);
});

test("real navigation cancels automatic anchoring before movement while ordinary typing does not", () => {
  for (const type of ["wheel", "touchstart", "pointerdown"]) assert.equal(cancelsWebtoonSeek({type}), true);
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " ", "Escape"]) assert.equal(cancelsWebtoonSeek({type: "keydown", key}), true);
  assert.equal(cancelsWebtoonSeek({type: "keydown", key: "a"}), false);
  assert.equal(cancelsWebtoonSeek({type: "scroll"}), false);
});
