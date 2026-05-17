/**
 * @file Tests for Sage's Portal release digest notifications.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleaseNotificationDigests,
  mergeReleaseNotificationAck,
  normalizeReleaseNotificationState
} from "../lib/releaseNotifications.mjs";

const completedTask = (index, overrides = {}) => ({
  taskId: `task-${index}`,
  status: "completed",
  titleId: `title-${index}`,
  titleName: `Title ${index}`,
  libraryTypeSlug: "manga",
  message: "Raven download completed.",
  updatedAt: `2026-05-16T00:${String(index).padStart(2, "0")}:00.000Z`,
  ...overrides
});

test("release builder groups completed tasks into one compact digest", () => {
  const tasks = Array.from({length: 12}, (_, index) => completedTask(index + 1));
  const notifications = buildReleaseNotificationDigests({
    config: {publicBaseUrl: "https://pax-kun.com"},
    channelId: "release-channel",
    tasks,
    libraryTitles: [{
      id: "title-12",
      title: "Title 12",
      libraryTypeSlug: "manga",
      chapters: [{
        id: "chapter-12",
        label: "Chapter 12",
        chapterNumber: 12,
        updatedAt: "2026-05-16T00:12:30.000Z"
      }]
    }]
  });

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].id, /^release:digest:/);
  assert.equal(notifications[0].totalCount, 12);
  assert.equal(notifications[0].items.length, 10);
  assert.equal(notifications[0].hiddenCount, 2);
  assert.equal(notifications[0].ackItemIds.length, 10);
  assert.equal(notifications[0].items[0].titleName, "Title 12");
  assert.equal(notifications[0].items[0].chapterLabel, "Chapter 12");
  assert.equal(notifications[0].items.some((item) => /Raven/i.test(String(item.chapterLabel))), false);
});

test("release builder tolerates missing library matches", () => {
  const notifications = buildReleaseNotificationDigests({
    config: {publicBaseUrl: "https://pax-kun.com"},
    channelId: "release-channel",
    tasks: [completedTask(1, {
      titleId: "",
      titleName: "Orphaned Completed Task"
    })],
    libraryTitles: []
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].items[0].titleName, "Orphaned Completed Task");
  assert.equal(notifications[0].items[0].chapterLabel, "Latest chapter");
});

test("silenceBefore hides completed tasks at or before the cursor", () => {
  const notifications = buildReleaseNotificationDigests({
    config: {publicBaseUrl: "https://pax-kun.com"},
    channelId: "release-channel",
    tasks: [
      completedTask(1, {updatedAt: "2026-05-16T00:00:00.000Z"}),
      completedTask(2, {updatedAt: "2026-05-16T00:01:00.000Z"}),
      completedTask(3, {updatedAt: "2026-05-16T00:02:00.000Z"})
    ],
    state: {
      silenceBefore: "2026-05-16T00:01:00.000Z"
    }
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].totalCount, 1);
  assert.equal(notifications[0].items[0].taskId, "task-3");
});

test("digest ack advances state and prevents reposts", () => {
  const now = "2026-05-16T01:00:00.000Z";
  const current = normalizeReleaseNotificationState(["release:old-task"]);
  const nextState = mergeReleaseNotificationAck(current, {
    notificationId: "release:digest:task-2:2",
    ackItemIds: ["release:task-2", "release:task-1"],
    silenceThrough: "2026-05-16T00:02:00.000Z"
  }, now);

  assert.deepEqual(nextState.ackedIds, [
    "release:old-task",
    "release:digest:task-2:2",
    "release:task-2",
    "release:task-1"
  ]);
  assert.equal(nextState.silenceBefore, "2026-05-16T00:02:00.000Z");
  assert.equal(nextState.lastDigestAt, now);

  const notifications = buildReleaseNotificationDigests({
    config: {publicBaseUrl: "https://pax-kun.com"},
    channelId: "release-channel",
    tasks: [
      completedTask(1, {updatedAt: "2026-05-16T00:01:00.000Z"}),
      completedTask(2, {updatedAt: "2026-05-16T00:02:00.000Z"})
    ],
    state: nextState
  });
  assert.deepEqual(notifications, []);
});
