/** @file Logical WebP reader tiles, cover thumbnails and strict selector regressions. */
import test from "node:test";
import assert from "node:assert/strict";
import {hasReadyReaderRevision, readerPageRow, readerVariantQuery} from "../lib/readerVariants.mjs";
import {buildLibraryCoverSource} from "../lib/libraryCoverSource.mjs";

const chapter = {id: "chapter-1", available: true, ingestStatus: "ready", ingestRevision: "webp-0123456789abcdef", pageCount: 1, sourcePageCount: 1,
  ingestedPageCount: 1, expectedSegmentCount: 3, ingestedSegmentCount: 3, segmentsReady: true};

test("WebP readiness requires every segment while AVIF revisions retain compatibility", () => {
  assert.equal(hasReadyReaderRevision(chapter), true);
  for (const override of [{segmentsReady: false}, {ingestedSegmentCount: 2}, {pageCount: 3}, {expectedSegmentCount: 0}, {sourcePageCount: 2}]) {
    assert.equal(hasReadyReaderRevision({...chapter, ...override}), false);
  }
  assert.equal(hasReadyReaderRevision({ingestRevision: "webp-0123456789abcdef"}), false);
  assert.equal(hasReadyReaderRevision({ingestRevision: "avif-legacy-checkpoint"}), true);
  assert.equal(hasReadyReaderRevision({ingestRevision: "unsupported"}), false);
});

test("logical reader page keeps source dimensions and gives each ordered tile its exact same-origin selector", () => {
  const page = {index: 0, sourcePageIndex: 0, width: 1000, height: 40000, segments: [
    {index: 0, x: 0, y: 0, width: 1000, height: 16000, src: "file:///private/a"},
    {index: 1, x: 0, y: 16000, width: 1000, height: 16000, src: "file:///private/b"},
    {index: 2, x: 0, y: 32000, width: 1000, height: 8000, src: "file:///private/c"}
  ]};
  const row = readerPageRow(page, {pageBase: "/reader/page", revision: chapter.ingestRevision, fallbackIndex: 0});
  assert.equal(row.height, 40000); assert.equal(row.sourcePageIndex, 0); assert.equal(row.segments.length, 3);
  assert.deepEqual(row.segments.map(s => s.src), [0, 1, 2].map(i => `/reader/page/0?rev=${chapter.ingestRevision}&segment=${i}`));
  assert.equal(page.segments[0].src, "file:///private/a", "Projection must not mutate the stored manifest.");
});

test("reader variants reject malformed or conflicting selectors instead of selecting default bytes", () => {
  assert.equal(readerVariantQuery({rev: chapter.ingestRevision, segment: "2", thumbnail: "false"}), `?rev=${chapter.ingestRevision}&segment=2&thumbnail=false`);
  assert.equal(readerVariantQuery({thumbnail: "true"}), "?thumbnail=true");
  for (const query of [{segment: "-1"}, {segment: "1.2"}, {segment: "01"}, {segment: ["0", "1"]}, {thumbnail: "yes"}, {thumbnail: ["true"]}, {thumbnail: "true", segment: "1"}, {rev: "bad\nrevision"}]) {
    assert.throws(() => readerVariantQuery(query), error => error.status === 400);
  }
});

test("WebP cover fallback requests a whole logical thumbnail and excludes partial tiles", () => {
  const source = buildLibraryCoverSource({id: "title-1", chapters: [{...chapter, id: "partial", chapterNumber: "0", ingestedSegmentCount: 2}, {...chapter, chapterNumber: "1"}]});
  assert.equal(source.fallbackPagePath, `/api/moon-v3/user/reader/title/title-1/chapter/chapter-1/page/0?rev=${chapter.ingestRevision}&thumbnail=true`);
  assert.equal(buildLibraryCoverSource({id: "title-1", chapters: [{...chapter, segmentsReady: false}]}), null);
});
