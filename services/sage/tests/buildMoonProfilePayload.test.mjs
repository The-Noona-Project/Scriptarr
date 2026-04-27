/**
 * @file Scriptarr Sage module: services/sage/tests/buildMoonProfilePayload.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {buildMoonProfilePayload} from "../lib/buildMoonProfilePayload.mjs";

test("buildMoonProfilePayload derives overview and stats from trusted user state", () => {
  const payload = buildMoonProfilePayload({
    userLibrary: {
      bookshelf: [{
        id: "title-1",
        title: "Solo Leveling",
        libraryTypeLabel: "Manhwa",
        libraryTypeSlug: "manhwa",
        latestChapter: "Ch 200",
        updatedAt: "2026-04-24T19:00:00.000Z",
        userState: {
          chapterLabel: "Chapter 199",
          lastActivityAt: "2026-04-24T19:30:00.000Z",
          bookshelf: true
        }
      }],
      startedTitles: [{
        id: "title-1",
        title: "Solo Leveling",
        libraryTypeLabel: "Manhwa",
        libraryTypeSlug: "manhwa",
        updatedAt: "2026-04-24T19:00:00.000Z",
        userState: {
          chapterLabel: "Chapter 199",
          lastActivityAt: "2026-04-24T19:30:00.000Z"
        }
      }],
      completedTitles: [{
        id: "title-2",
        title: "DICE",
        libraryTypeLabel: "Manhwa",
        libraryTypeSlug: "manhwa",
        updatedAt: "2026-04-22T19:00:00.000Z",
        userState: {
          completedAt: "2026-04-23T12:00:00.000Z",
          lastActivityAt: "2026-04-23T12:00:00.000Z"
        }
      }],
      followingTitles: [{
        id: "title-3",
        title: "Tower of God",
        libraryTypeLabel: "Manhwa",
        libraryTypeSlug: "manhwa",
        updatedAt: "2026-04-21T19:00:00.000Z",
        userState: {
          following: true
        }
      }],
      tagPreferences: {
        likedTags: ["Action", "Fantasy"],
        dislikedTags: ["Horror"]
      }
    },
    requests: [{
      id: "request-1",
      title: "Omniscient Reader",
      status: "pending",
      requestType: "manhwa",
      updatedAt: "2026-04-24T18:00:00.000Z"
    }, {
      id: "request-2",
      title: "The Boxer",
      status: "completed",
      requestType: "manhwa",
      updatedAt: "2026-04-20T18:00:00.000Z"
    }]
  });

  assert.equal(payload.stats.bookshelfCount, 1);
  assert.equal(payload.stats.inProgressCount, 1);
  assert.equal(payload.stats.completedCount, 1);
  assert.equal(payload.stats.followingCount, 1);
  assert.equal(payload.stats.requestCounts.active, 1);
  assert.equal(payload.stats.requestCounts.completed, 1);
  assert.equal(payload.stats.likedTagCount, 2);
  assert.equal(payload.stats.dislikedTagCount, 1);
  assert.equal(payload.overview.bookshelfPreview[0].title, "Solo Leveling");
  assert.equal(payload.statsPanels.recentActivity[0].id, "reading:title-1");
});
