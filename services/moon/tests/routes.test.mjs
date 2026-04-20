import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLibraryPath,
  buildReaderPath,
  buildTitlePath,
  matchUserRoute
} from "../apps/user/assets/routes.js";

test("route builders normalize type-scoped Moon paths", () => {
  assert.equal(buildLibraryPath("Web Toon"), "/library/web-toon");
  assert.equal(buildTitlePath("Web Toon", "dan-da-dan"), "/title/web-toon/dan-da-dan");
  assert.equal(buildReaderPath("Web Toon", "dan-da-dan", "chapter-1"), "/reader/web-toon/dan-da-dan/chapter-1");
});

test("typed user routes parse canonical Moon library, title, and reader URLs", () => {
  assert.deepEqual(matchUserRoute("/library/webtoon"), {
    id: "library",
    path: "/library/webtoon",
    title: "Library",
    description: "Read the webtoon library.",
    params: {typeSlug: "webtoon"}
  });

  assert.deepEqual(matchUserRoute("/title/webtoon/dan-da-dan"), {
    id: "title",
    path: "/title/webtoon/dan-da-dan",
    title: "Series Detail",
    description: "Read metadata, follow the title, and jump into a chapter.",
    params: {
      typeSlug: "webtoon",
      titleId: "dan-da-dan"
    }
  });

  assert.deepEqual(matchUserRoute("/reader/webtoon/dan-da-dan/chapter-1"), {
    id: "reader",
    path: "/reader/webtoon/dan-da-dan/chapter-1",
    title: "Reader",
    description: "Native Moon reading with bookmarks, progress, and display preferences.",
    params: {
      typeSlug: "webtoon",
      titleId: "dan-da-dan",
      chapterId: "chapter-1"
    }
  });
});

test("legacy title and reader routes remain accepted as backward-compatible shims", () => {
  assert.deepEqual(matchUserRoute("/title/dan-da-dan"), {
    id: "title",
    path: "/title/dan-da-dan",
    title: "Series Detail",
    description: "Read metadata, follow the title, and jump into a chapter.",
    params: {
      titleId: "dan-da-dan",
      typeSlug: ""
    },
    legacy: true
  });

  assert.deepEqual(matchUserRoute("/reader/dan-da-dan/chapter-1"), {
    id: "reader",
    path: "/reader/dan-da-dan/chapter-1",
    title: "Reader",
    description: "Native Moon reading with bookmarks, progress, and display preferences.",
    params: {
      titleId: "dan-da-dan",
      chapterId: "chapter-1",
      typeSlug: ""
    },
    legacy: true
  });
});
