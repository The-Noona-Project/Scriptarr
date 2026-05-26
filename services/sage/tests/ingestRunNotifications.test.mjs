/**
 * @file Tests for Portal-facing Raven ingest run notifications.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIngestRunNotifications,
  mergeIngestRunNotificationAck,
  normalizeIngestRunNotificationState
} from "../lib/ingestRunNotifications.mjs";

const ingestJob = (overrides = {}) => ({
  jobId: "ingestrun_1",
  kind: "raven-library-ingest",
  ownerService: "scriptarr-raven",
  status: "running",
  requestedBy: "admin-1",
  payload: {
    libraryTypeSlug: "manga",
    libraryTypeLabel: "Manga",
    titleCount: 8
  },
  result: {
    totalTitles: 8,
    completedTitles: 2,
    failedTitles: 0,
    remainingTitles: 6
  },
  createdAt: "2026-05-23T01:00:00.000Z",
  updatedAt: "2026-05-23T01:05:00.000Z",
  ...overrides
});

test("ingest run notification builder emits crossed milestones once", () => {
  const notifications = buildIngestRunNotifications({
    jobs: [ingestJob({
      result: {
        totalTitles: 8,
        completedTitles: 5,
        failedTitles: 0,
        remainingTitles: 3
      }
    })],
    state: {ackedIds: ["ingest:ingestrun_1:25"]}
  });

  assert.deepEqual(notifications.map((entry) => entry.id), ["ingest:ingestrun_1:50"]);
  assert.equal(notifications[0].discordUserId, "admin-1");
  assert.equal(notifications[0].percent, 62);
  assert.equal(notifications[0].libraryTypeLabel, "Manga");
});

test("ingest run notification builder skips missed milestones after terminal status", () => {
  const notifications = buildIngestRunNotifications({
    jobs: [ingestJob({
      status: "completed",
      finishedAt: "2026-05-23T01:20:00.000Z",
      result: {
        totalTitles: 8,
        completedTitles: 8,
        failedTitles: 0,
        remainingTitles: 0
      }
    })],
    state: {}
  });

  assert.deepEqual(notifications.map((entry) => entry.id), ["ingest:ingestrun_1:terminal"]);
  assert.equal(notifications[0].terminal, true);
  assert.equal(notifications[0].percent, 100);
});

test("ingest run notification builder reports partial failures in final notification", () => {
  const notifications = buildIngestRunNotifications({
    jobs: [ingestJob({
      status: "failed",
      result: {
        totalTitles: 4,
        completedTitles: 3,
        failedTitles: 1,
        remainingTitles: 0
      }
    })],
    state: {}
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].id, "ingest:ingestrun_1:terminal");
  assert.equal(notifications[0].failedTitles, 1);
  assert.match(notifications[0].message, /failed title/);
});

test("ingest run notification builder falls back to owner DM for placeholder requesters", () => {
  const notifications = buildIngestRunNotifications({
    jobs: [
      ingestJob({
        jobId: "ingestrun_owner_missing",
        requestedBy: ""
      }),
      ingestJob({
        jobId: "ingestrun_owner_placeholder",
        requestedBy: "scriptarr-admin"
      })
    ],
    state: {},
    fallbackDiscordUserId: "owner-1"
  });

  assert.deepEqual(notifications.map((entry) => entry.discordUserId), ["owner-1", "owner-1"]);
  assert.deepEqual(notifications.map((entry) => entry.requestedBy), ["owner-1", "owner-1"]);
});

test("ingest run notification ack state is bounded and deduplicated", () => {
  const state = normalizeIngestRunNotificationState({
    ackedIds: Array.from({length: 1002}, (_, index) => `ingest:old:${index}`)
  });
  const next = mergeIngestRunNotificationAck(state, "ingest:ingestrun_1:25", "2026-05-23T02:00:00.000Z");

  assert.equal(next.ackedIds.length, 1000);
  assert.equal(next.ackedIds.at(-1), "ingest:ingestrun_1:25");
  assert.equal(next.updatedAt, "2026-05-23T02:00:00.000Z");
});
