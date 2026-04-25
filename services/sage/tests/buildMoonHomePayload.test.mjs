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
  userState: {
    bookshelf: false,
    completed: false,
    following: false,
    lastActivityAt: null
  },
  ...overrides
});

test("buildMoonHomePayload prioritizes explicit tag tastes and inferred reading history", () => {
  const titles = [
    makeTitle({
      id: "title-1",
      title: "Dandadan",
      tags: ["Action", "Supernatural"],
      libraryTypeSlug: "manga",
      libraryTypeLabel: "Manga",
      metadataMatchedAt: "2026-04-21T08:00:00.000Z",
      userState: {
        bookshelf: true,
        completed: false,
        following: false,
        lastActivityAt: "2026-04-21T09:00:00.000Z"
      }
    }),
    makeTitle({
      id: "title-2",
      title: "Solo Leveling",
      tags: ["Action"],
      libraryTypeSlug: "manhwa",
      libraryTypeLabel: "Manhwa",
      metadataMatchedAt: "2026-04-20T08:00:00.000Z",
      userState: {
        bookshelf: false,
        completed: false,
        following: true,
        lastActivityAt: "2026-04-20T09:00:00.000Z"
      }
    }),
    makeTitle({
      id: "title-3",
      title: "Witch Hat Atelier",
      tags: ["Fantasy"],
      libraryTypeSlug: "manga",
      libraryTypeLabel: "Manga",
      metadataMatchedAt: "2026-04-19T08:00:00.000Z",
      userState: {
        bookshelf: false,
        completed: true,
        following: false,
        lastActivityAt: "2026-04-19T09:00:00.000Z"
      }
    }),
    makeTitle({
      id: "title-4",
      title: "A Sign of Affection",
      tags: ["Romance"],
      libraryTypeSlug: "manga",
      libraryTypeLabel: "Manga",
      metadataMatchedAt: "2026-04-18T08:00:00.000Z"
    })
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
    bookshelf: [{
      ...titles[0],
      titleId: "title-1",
      chapterLabel: "Chapter 166",
      positionRatio: 0.6,
      updatedAt: "2026-04-21T09:00:00.000Z"
    }],
    following: [{titleId: "title-2"}],
    discordUserId: "user-1",
    tagPreferences: {
      likedTags: ["Fantasy"],
      dislikedTags: ["Romance"]
    }
  });

  assert.equal(payload.continueReading[0].title, "Dandadan");
  assert.equal(payload.requests.length, 1);
  assert.equal(payload.requests[0].id, "request-1");
  assert.equal(payload.following.length, 1);
  assert.deepEqual(payload.tagPreferences, {
    likedTags: ["Fantasy"],
    dislikedTags: ["Romance"]
  });
  assert.equal(payload.shelves[0].title, "Your Bookshelf");
  assert.ok(payload.shelves.some((shelf) => shelf.id === "recent:manhwa"));

  const fantasyShelf = payload.shelves.find((shelf) => shelf.id === "tag:fantasy");
  assert.ok(fantasyShelf);
  assert.equal(fantasyShelf.title, "Because you like Fantasy");
  assert.equal(fantasyShelf.items[0].id, "title-3");

  const actionShelf = payload.shelves.find((shelf) => shelf.id === "tag:action");
  assert.ok(actionShelf);
  assert.equal(actionShelf.title, "Because you read Action");
  assert.equal(actionShelf.items[0].id, "title-2");

  assert.equal(payload.shelves.some((shelf) => shelf.id === "tag:romance"), false);
});

test("buildMoonHomePayload falls back to the bookshelf title when it is the only tag match", () => {
  const title = makeTitle({
    id: "title-1",
    title: "Dandadan",
    tags: ["Action"],
    userState: {
      bookshelf: true,
      completed: false,
      following: false,
      lastActivityAt: "2026-04-21T09:00:00.000Z"
    }
  });

  const payload = buildMoonHomePayload({
    titles: [title],
    bookshelf: [{
      ...title,
      titleId: "title-1",
      chapterLabel: "Chapter 166",
      positionRatio: 0.5,
      updatedAt: "2026-04-21T09:00:00.000Z"
    }]
  });

  const actionShelf = payload.shelves.find((shelf) => shelf.id === "tag:action");
  assert.ok(actionShelf);
  assert.equal(actionShelf.items[0].id, "title-1");
});
