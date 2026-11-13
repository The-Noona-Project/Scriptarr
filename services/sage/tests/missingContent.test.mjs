/** @file Regression coverage for compact Missing Content discovery and scoped chapter hydration. */
import test from "node:test";
import assert from "node:assert/strict";
import {loadMissingContentTitles} from "../lib/missingContent.mjs";

test("compact pages retain fully downloaded partial titles and exact repair chapter identities", async () => {
  const calls = [], healthy = {id: "healthy", chapterCount: 1, chaptersDownloaded: 1, qualityStatus: "clean"};
  const partial = {id: "partial", chapterCount: 2, chaptersDownloaded: 2, partialChapterCount: 1};
  const chapter = {id: "chapter-197", chapterNumber: "197", sourceUrl: "https://weebcentral.com/chapters/ABC", qualityStatus: "possible_missing_page", missingPages: [3], missingPageCount: 1};
  const fetchJson = async path => {
    calls.push(path);
    assert.ok(path.startsWith("/v1/library?"), "No per-title Raven endpoint may trigger a catalogue reload");
    return path.includes("cursor=") ? {titles: [partial], pageInfo: {hasMore: false}}
      : {titles: [healthy], pageInfo: {hasMore: true, nextCursor: "next"}};
  };
  const loaded = [];
  const rows = await loadMissingContentTitles(fetchJson, title => ({...title, chapters: title.chapters || []}), async id => {
    loaded.push(id); return {...partial, chapters: [{id: "clean", qualityStatus: "clean"}, chapter]};
  });
  assert.deepEqual(rows[0].chapters, []);
  assert.deepEqual(rows[1].chapters, [chapter]);
  assert.deepEqual(loaded, ["partial"]);
  assert.equal(calls.length, 2);
});

test("repeated, failed or incomplete pages and foreign details cannot appear successful", async () => {
  for (const fetchJson of [
    async () => ({titles: [], pageInfo: {hasMore: true, nextCursor: "same"}}),
    async () => ({titles: [{id: "repeated"}], pageInfo: {hasMore: true, nextCursor: "same"}}),
    async () => {throw new Error("Broker unavailable");},
    async () => ({}),
    async path => path.includes("?") ? {titles: [{id: "missing", chapterCount: 1, chaptersDownloaded: 0}]} : {id: "foreign", chapters: []}
  ]) await assert.rejects(loadMissingContentTitles(fetchJson, title => title, async () => ({id: "foreign", chapters: []})));
});
