import assert from "node:assert/strict";
import test from "node:test";

import {buildAdminCalendarPayload} from "../lib/adminCalendar.mjs";

test("admin calendar includes completed title markers with dated chapters", () => {
  const payload = buildAdminCalendarPayload([{
    id: "title-1",
    title: "Finished Story",
    status: "completed",
    libraryTypeSlug: "manga",
    chapters: [{
      id: "chapter-1",
      label: "Chapter 1",
      chapterNumber: "1",
      releaseDate: "2026-04-20",
      available: true
    }]
  }]);

  assert.equal(payload.counts.chapterEntries, 1);
  assert.equal(payload.counts.completedMarkers, 1);
  assert.deepEqual(payload.entries.map((entry) => entry.kind), ["chapter_release", "title_completed"]);
  assert.equal(payload.entries[1].readerUrl, "/reader/manga/title-1/chapter-1");
});

test("admin calendar uses completion fallback dates and counts undated completed titles", () => {
  const payload = buildAdminCalendarPayload([{
    id: "fallback",
    title: "Fallback Complete",
    status: "completed",
    updatedAt: "2026-04-22T10:00:00.000Z",
    chapters: [{
      id: "chapter-1",
      label: "Chapter 1",
      updatedAt: "2026-04-21T10:00:00.000Z",
      available: true
    }]
  }, {
    id: "undated",
    title: "Undated Complete",
    status: "completed",
    chapters: []
  }]);

  const marker = payload.entries.find((entry) => entry.titleId === "fallback");
  assert.equal(marker.kind, "title_completed");
  assert.equal(marker.eventDate, "2026-04-21T10:00:00.000Z");
  assert.equal(payload.counts.undatedCompletedCount, 1);
});
