/**
 * @file Cover retention projections and first-readable-page selection regressions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {buildLibraryCoverSource, buildTitleCoverFields} from "../lib/libraryCoverSource.mjs";

const chapter = (number, extra = {}) => ({
  id: `chapter-${number}`,
  chapterNumber: String(number),
  available: true,
  pageCount: 12,
  ingestedPageCount: 12,
  ingestStatus: "ready",
  ingestRevision: "avif-0123456789abcdef",
  ...extra
});

test("coverless compact titles still advertise the lazy cover cache without hydrating chapters", () => {
  const title = {id: "title-1", coverUrl: "", updatedAt: "2026-11-08T06:00:00Z"};
  Object.defineProperty(title, "chapters", {get() { throw new Error("Compact artwork must not inspect chapters."); }});
  const fields = buildTitleCoverFields(title);
  assert.match(fields.coverThumbUrl, /^\/api\/moon\/v3\/user\/covers\/title-1\.webp\?rev=[a-f0-9]{12}$/);
  assert.equal(fields.coverUrl, "");
});

test("cover fallback selects page zero of earliest readable chapter, including decimal chapter numbers", () => {
  const chapters = [chapter(20), chapter(1.2), chapter(1.1), chapter(0, {ingestStatus: "running"})];
  const before = JSON.stringify(chapters);
  const source = buildLibraryCoverSource({id: "title-1", coverUrl: "https://art.example/cover.jpg", chapters});
  assert.equal(source.coverUrl, "https://art.example/cover.jpg");
  assert.equal(source.fallbackPagePath, "/api/moon-v3/user/reader/title/title-1/chapter/chapter-1.1/page/0?rev=avif-0123456789abcdef");
  assert.equal(JSON.stringify(chapters), before, "Cover reads must not reorder catalog state.");
});

test("missing cover uses first available ready page and excludes incomplete or unavailable chapters", () => {
  const source = buildLibraryCoverSource({id: "title-1", chapters: [
    chapter(0, {available: false}), chapter(1, {ingestStatus: "failed"}),
    chapter(2, {ingestedPageCount: 0}), chapter(3, {ingestRevision: "old-webp"}),
    chapter(4, {pageCount: 0}), chapter(5)
  ]});
  assert.equal(source.coverUrl, "");
  assert.match(source.fallbackPagePath, /\/chapter\/chapter-5\/page\/0\?/);
  assert.equal(buildLibraryCoverSource({id: "empty", chapters: []}), null);
  assert.equal(buildLibraryCoverSource({coverUrl: "https://art.example/cover.jpg"}), null);
});

test("remote covers remain available before ingest and revisions change after metadata repair", () => {
  const title = {id: "title-1", coverUrl: "https://art.example/one.jpg", chapters: []};
  assert.equal(buildLibraryCoverSource(title).fallbackPagePath, "");
  assert.notEqual(buildTitleCoverFields(title).coverRevision,
    buildTitleCoverFields({...title, coverUrl: "https://art.example/repaired.jpg"}).coverRevision);
});
