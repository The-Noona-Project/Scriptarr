import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCalendarMonth,
  calendarFilterOptions,
  filterCalendarEntries,
  normalizeCalendarEntries
} from "../apps/admin-next/lib/adminCalendar.js";

test("admin calendar helpers normalize, filter, and preserve completed markers", () => {
  const entries = normalizeCalendarEntries([{
    id: "chapter:1",
    kind: "chapter_release",
    eventDate: "2026-04-20",
    title: "Dandadan",
    libraryTypeSlug: "manga",
    libraryTypeLabel: "Manga",
    titleStatus: "active",
    chapterLabel: "Chapter 1"
  }, {
    id: "completed:2",
    kind: "title_completed",
    eventDate: "2026-04-21",
    title: "Finished",
    libraryTypeSlug: "manhwa",
    libraryTypeLabel: "Manhwa",
    titleStatus: "completed"
  }]);

  assert.equal(entries.length, 2);
  assert.deepEqual(calendarFilterOptions(entries, "status").map((entry) => entry.id), ["active", "completed"]);
  assert.deepEqual(filterCalendarEntries(entries, {includeCompletedMarkers: false}).map((entry) => entry.id), ["chapter:1"]);
  assert.deepEqual(filterCalendarEntries(entries, {query: "finished", includeCompletedMarkers: true}).map((entry) => entry.id), ["completed:2"]);
});

test("admin calendar month groups events by day", () => {
  const entries = normalizeCalendarEntries([{
    id: "chapter:1",
    eventDate: "2026-04-20T12:00:00.000Z",
    title: "Dandadan"
  }]);
  const days = buildCalendarMonth(new Date("2026-04-01T12:00:00.000Z"), entries);
  const day = days.find((entry) => entry.day === "2026-04-20");

  assert.equal(days.length, 42);
  assert.equal(day.entries[0].id, "chapter:1");
});
