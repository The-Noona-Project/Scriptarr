/** @file Logical segmented-page geometry, preload and image-variant authorization regressions. */
import test from "node:test";
import assert from "node:assert/strict";
import {resolveReaderPageImages, readerPageImageKey} from "../apps/reader-next/lib/pageSegments.js";
import {hasReaderPageImages, warmReaderPageImages} from "../apps/reader-next/lib/pageChunks.js";
import {readerImageSelector, readerProbeMatchesSelector, readerResponseMatchesSelector} from "../lib/readerImageIdentity.mjs";
import {validateCoverFallbackPath} from "../lib/coverCache.mjs";

const page = () => ({index: 7, src: "/page/7?rev=webp-one", width: 1200, height: 20000,
  segments: [{index: 0, x: 0, y: 0, width: 1200, height: 16383, src: "/page/7?rev=webp-one&segment=0"},
    {index: 1, x: 0, y: 16383, width: 1200, height: 3617, src: "/page/7?rev=webp-one&segment=1"}]});

test("segmented pages keep their logical index and require complete non-overlapping coverage", () => {
  assert.equal(resolveReaderPageImages(page()).length, 2);
  assert.equal(hasReaderPageImages([page()], [7]), true);
  const gap = page(); gap.segments[1].height -= 1;
  assert.deepEqual(resolveReaderPageImages(gap), []);
  const overlap = page(); overlap.segments[1].y -= 1;
  assert.equal(hasReaderPageImages([overlap], [7]), false);
  const absent = page(); absent.segments[1].src = "";
  assert.equal(hasReaderPageImages([absent], [7]), false);
  const changed = page(); changed.segments[1].src += "-changed";
  assert.notEqual(readerPageImageKey(changed), readerPageImageKey(page()));
  assert.deepEqual(resolveReaderPageImages({index: 1, src: "/legacy.avif"}), [{index: 0, src: "/legacy.avif"}]);
});

test("two-dimensional segmentation validates full page geometry", () => {
  const wide = {index: 0, width: 20000, height: 20000, segments: []};
  for (const y of [0, 10000]) for (const x of [0, 10000]) wide.segments.push({index: wide.segments.length,
    x, y, width: 10000, height: 10000, src: `/tile/${x}/${y}`});
  assert.equal(resolveReaderPageImages(wide).length, 4);
  wide.segments[3].index = 0;
  assert.deepEqual(resolveReaderPageImages(wide), []);
});

test("preload waits for every segment decode and never reports only tile zero ready", async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  class Image {
    set src(value) { this.value = value; if (value) queueMicrotask(() => this.onload?.()); }
    decode() { return this.value.endsWith("segment=1") ? delayed : Promise.resolve(); }
  }
  let finished = false;
  const warming = warmReaderPageImages([page()], [7], {imageFactory: Image}).then((value) => { finished = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  assert.deepEqual(await warming, [{index: 7, ok: true}]);
});

test("one failed segment or incomplete metadata fails logical readiness", async () => {
  class Image {
    set src(value) { this.value = value; if (value) queueMicrotask(() => value.endsWith("segment=1") ? this.onerror?.() : this.onload?.()); }
    decode() { return Promise.resolve(); }
  }
  assert.deepEqual(await warmReaderPageImages([page()], [7], {imageFactory: Image}), [{index: 7, ok: false}]);
  const incomplete = page(); incomplete.segments.pop();
  assert.deepEqual(await warmReaderPageImages([incomplete], [7], {imageFactory: Image}), [{index: 7, ok: false}]);
});

test("variant cache keys distinguish segments and thumbnails; malformed selectors cannot alias tile zero", () => {
  const plain = readerImageSelector({}), tile = readerImageSelector({segment: "1"}), thumb = readerImageSelector({thumbnail: "true"});
  assert.equal(new Set([plain.key, tile.key, thumb.key]).size, 3);
  assert.equal(readerImageSelector({segment: "0"}).key, plain.key);
  for (const value of ["-1", "01", "1x", ["0", "1"], "1.0"]) assert.equal(readerImageSelector({segment: value}), null);
  assert.equal(readerImageSelector({segment: "1", thumbnail: "true"}), null);
  assert.equal(readerProbeMatchesSelector({}, plain), true);
  assert.equal(readerProbeMatchesSelector({segmentIndex: 0, thumbnail: false}, tile), false);
  assert.equal(readerProbeMatchesSelector({segmentIndex: 1, thumbnail: false}, tile), true);
  assert.equal(readerProbeMatchesSelector({segmentIndex: 0, thumbnail: false}, thumb), false);
  assert.equal(readerProbeMatchesSelector({segmentIndex: 0, thumbnail: true}, thumb), true);
  assert.equal(readerResponseMatchesSelector({}, plain), true);
  assert.equal(readerResponseMatchesSelector({}, tile), false);
  assert.equal(readerResponseMatchesSelector({"x-scriptarr-segment-index": "1", "x-scriptarr-thumbnail": "false"}, tile), true);
  assert.equal(readerResponseMatchesSelector({"x-scriptarr-segment-index": "0", "x-scriptarr-thumbnail": "false"}, thumb), false);
});

test("WebP cover fallback is an exact whole-logical-first-page thumbnail", () => {
  const prefix = "/api/moon-v3/user/reader/title/title-one/chapter/chapter-one/page/0?rev=";
  assert.equal(validateCoverFallbackPath("title-one", prefix + "webp-1234567890abcdef&thumbnail=true"), prefix + "webp-1234567890abcdef&thumbnail=true");
  assert.equal(validateCoverFallbackPath("title-one", prefix + "avif-1234567890abcdef"), prefix + "avif-1234567890abcdef");
  for (const suffix of ["webp-1234567890abcdef", "avif-1234567890abcdef&thumbnail=true", "webp-1234567890abcdef&segment=0", "webp-1234567890abcdef&thumbnail=true&segment=1"]) {
    assert.throws(() => validateCoverFallbackPath("title-one", prefix + suffix));
  }
});
