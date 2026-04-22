/**
 * @file Unit coverage for Moon home payload personalization.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {buildMoonHomePayload} from "../lib/buildMoonHomePayload.mjs";

const makeTitle = (overrides = {}) => ({
  id: "title-1",
  title: "Dandadan",
  mediaType: "manga",
  libraryTypeLabel: "Manga",
  libraryTypeSlug: "manga",
  status: "active",
  latestChapter: "166",
  coverAccent: "#ff6a3d",
  coverUrl: "https://images.example/dandadan.jpg",
  summary: "Aliens and yokai.",
  chapterCount: 166,
  chaptersDownloaded: 166,
  tags: ["Action", "Supernatural"],
  aliases: [],
  metadataProvider: "mangadex",
  metadataMatchedAt: "2026-04-20T18:00:00.000Z",
  chapters: [{
    id: "chapter-166",
    releaseDate: "2026-04-20"
  }],
  ...overrides
});

test("buildMoonHomePayload puts current reading first and creates recent plus tag shelves", () => {
  const titles = [
    makeTitle({id: "title-1", title: "Dandadan", tags: ["Action", "Supernatural"], libraryTypeSlug: "manga", libraryTypeLabel: "Manga"}),
    makeTitle({id: "title-2", title: "Solo Leveling", tags: ["Action"], libraryTypeSlug: "manhwa", libraryTypeLabel: "Manhwa", metadataMatchedAt: "2026-04-21T08:00:00.000Z"}),
    makeTitle({id: "title-3", title: "Omniscient Reader", tags: ["Action"], libraryTypeSlug: "manhwa", libraryTypeLabel: "Manhwa", metadataMatchedAt: "2026-04-19T08:00:00.000Z"}),
    makeTitle({id: "title-4", title: "Witch Hat Atelier", tags: ["Fantasy"], libraryTypeSlug: "manga", libraryTypeLabel: "Manga", metadataMatchedAt: "2026-04-18T08:00:00.000Z"})
  ];

  const payload = buildMoonHomePayload({
    titles,
    requests: [{
      id: "request-1",
      title: "Dandadan",
      requestedBy: {discordUserId: "user-1"}
    }, {
      id: "request-2",
      title: "Solo Leveling",
      requestedBy: {discordUserId: "user-2"}
    }],
    progress: [{
      titleId: "title-1",
      title: "Dandadan",
      tags: ["Action", "Supernatural"],
      bookmark: {chapterId: "chapter-166"},
      updatedAt: "2026-04-21T09:00:00.000Z"
    }],
    following: [{titleId: "title-3"}],
    discordUserId: "user-1"
  });

  assert.equal(payload.continueReading[0].title, "Dandadan");
  assert.equal(payload.requests.length, 1);
  assert.equal(payload.requests[0].id, "request-1");
  assert.equal(payload.following.length, 1);
  assert.equal(payload.shelves[0].title, "Your Bookshelf");
  assert.equal(payload.shelves[1].title, "Recently added to Manhwa");
  assert.ok(payload.shelves.some((shelf) => shelf.id === "tag:action"));
});

test("buildMoonHomePayload falls back to all matching tag titles when the bookshelf already covers the only match", () => {
  const titles = [
    makeTitle({id: "title-1", title: "Dandadan", tags: ["Action"]})
  ];

  const payload = buildMoonHomePayload({
    titles,
    progress: [{
      titleId: "title-1",
      title: "Dandadan",
      tags: ["Action"],
      bookmark: {chapterId: "chapter-166"}
    }],
    discordUserId: "user-1"
  });

  const actionShelf = payload.shelves.find((shelf) => shelf.id === "tag:action");
  assert.ok(actionShelf);
  assert.equal(actionShelf.items[0].id, "title-1");
});
