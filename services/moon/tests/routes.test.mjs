import test from "node:test";
import assert from "node:assert/strict";

import {buildAdminLibraryTitlePath, matchAdminRoute} from "../apps/admin/assets/routes.js";
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

test("admin routes include the dedicated Discord settings page", () => {
  assert.deepEqual(matchAdminRoute("/admin/discord"), {
    id: "discord",
    path: "/admin/discord",
    title: "Discord",
    description: "Guild workflow settings, slash-command access, onboarding, and Portal runtime status.",
    navLabel: "Discord",
    group: "System"
  });
});

test("admin routes include the public API page", () => {
  assert.deepEqual(matchAdminRoute("/admin/system/api"), {
    id: "system-api",
    path: "/admin/system/api",
    title: "API",
    description: "Public Moon API access, admin automation key, and Swagger docs.",
    navLabel: "API",
    group: "System"
  });
});

test("admin routes build and parse canonical library detail URLs", () => {
  assert.equal(buildAdminLibraryTitlePath("Manhwa", "solo-leveling"), "/admin/library/manhwa/solo-leveling");
  assert.deepEqual(matchAdminRoute("/admin/library/manhwa/solo-leveling"), {
    id: "library-title",
    path: "/admin/library/manhwa/solo-leveling",
    title: "Series Detail",
    description: "Inspect title health, chapter releases, metadata state, and Raven file coverage.",
    navLabel: "Library",
    group: "Manage",
    params: {
      typeSlug: "manhwa",
      titleId: "solo-leveling"
    }
  });
});
