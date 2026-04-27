/**
 * @file Scriptarr Sage module: services/sage/tests/buildAdminQueuePayload.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {buildAdminQueuePayload} from "../lib/buildAdminQueuePayload.mjs";

test("buildAdminQueuePayload groups title tasks into running, queued, and needs-attention sections", () => {
  const now = Date.now();
  const staleIso = new Date(now - (31 * 60 * 1000)).toISOString();
  const freshIso = new Date(now - (2 * 60 * 1000)).toISOString();

  const payload = buildAdminQueuePayload([{
    taskId: "running-1",
    titleName: "Solo Leveling",
    requestType: "manhwa",
    status: "running",
    source: "raven",
    priority: "high",
    percent: 50,
    startedAt: new Date(now - (60 * 60 * 1000)).toISOString(),
    updatedAt: freshIso,
    downloadSpeedBytesPerSecond: 1024
  }, {
    taskId: "queued-1",
    titleName: "Dandadan",
    requestType: "manga",
    status: "queued",
    source: "raven",
    priority: "high",
    sortOrder: 2,
    queuedAt: freshIso,
    updatedAt: freshIso
  }, {
    taskId: "queued-2",
    titleName: "Tower of God",
    requestType: "manhwa",
    status: "queued",
    source: "raven",
    priority: "normal",
    sortOrder: 1,
    queuedAt: freshIso,
    updatedAt: freshIso
  }, {
    taskId: "failed-1",
    titleName: "Bleach",
    requestType: "manga",
    status: "failed",
    source: "raven",
    priority: "normal",
    updatedAt: freshIso
  }, {
    taskId: "stale-1",
    titleName: "Lookism",
    requestType: "manhwa",
    status: "queued",
    source: "raven",
    priority: "low",
    sortOrder: 5,
    queuedAt: staleIso,
    updatedAt: staleIso
  }, {
    taskId: "system-restart-1",
    titleName: "Restart Moon",
    requestType: "job",
    ownerService: "scriptarr-warden",
    source: "broker",
    status: "failed",
    priority: "normal",
    updatedAt: freshIso
  }], {concurrency: 2});

  assert.equal(payload.stats.runningCount, 1);
  assert.equal(payload.stats.queuedCount, 3);
  assert.equal(payload.stats.needsAttentionCount, 2);
  assert.equal(payload.stats.totalSlots, 2);
  assert.equal(payload.stats.retryableAttentionCount, 2);
  assert.equal(payload.running[0].taskId, "running-1");
  assert.equal(payload.running[0].downloadSpeedBytesPerSecond, 1024);
  assert.equal(Number.isFinite(payload.running[0].etaMinutes), true);
  assert.equal(payload.queued[0].taskId, "queued-1");
  assert.equal(payload.queued[0].etaLabel, undefined);
  assert.equal(payload.queued[0].etaMinutes, undefined);
  assert.equal(payload.queued[1].taskId, "queued-2");
  assert.equal(payload.needsAttention.some((task) => task.taskId === "failed-1" && task.retriable === true && task.removable === true), true);
  assert.equal(payload.needsAttention.some((task) => task.taskId === "stale-1" && task.attentionReason === "stale" && task.retriable === true && task.removable === true), true);
  assert.equal(payload.needsAttention.some((task) => task.taskId === "system-restart-1"), false);
});

test("buildAdminQueuePayload keeps running cards in a stable queue order", () => {
  const payload = buildAdminQueuePayload([{
    taskId: "running-recent",
    titleName: "Bouncer",
    requestType: "manga",
    status: "running",
    source: "raven",
    priority: "normal",
    sortOrder: 2,
    queuedAt: "2026-04-25T09:00:00.000Z",
    startedAt: "2026-04-25T09:05:00.000Z",
    updatedAt: "2026-04-25T09:20:00.000Z"
  }, {
    taskId: "running-older",
    titleName: "Bouken ni wa, Buki ga Hitsuyou da!",
    requestType: "manga",
    status: "running",
    source: "raven",
    priority: "normal",
    sortOrder: 1,
    queuedAt: "2026-04-25T08:55:00.000Z",
    startedAt: "2026-04-25T09:01:00.000Z",
    updatedAt: "2026-04-25T09:10:00.000Z"
  }]);

  assert.deepEqual(
    payload.running.map((task) => task.taskId),
    ["running-older", "running-recent"]
  );
});

test("buildAdminQueuePayload marks stale running titles as non-retriable needs-attention cards", () => {
  const staleIso = new Date(Date.now() - (31 * 60 * 1000)).toISOString();

  const payload = buildAdminQueuePayload([{
    taskId: "running-stale",
    titleName: "Claymore",
    requestType: "manga",
    status: "running",
    source: "raven",
    priority: "normal",
    sortOrder: 1,
    queuedAt: staleIso,
    startedAt: staleIso,
    updatedAt: staleIso
  }]);

  assert.equal(payload.needsAttention.length, 1);
  assert.equal(payload.needsAttention[0].attentionReason, "stale");
  assert.equal(payload.needsAttention[0].retriable, false);
  assert.equal(payload.needsAttention[0].removable, false);
  assert.equal(payload.stats.retryableAttentionCount, 0);
});

test("buildAdminQueuePayload excludes stale broker snapshots from live title recovery", () => {
  const payload = buildAdminQueuePayload([{
    taskId: "bulkrun-1-manga-a",
    jobId: "bulkrun-1",
    jobKind: "raven-bulk-downloadall",
    taskKey: "bulk-batch",
    titleName: "a Manga",
    requestType: "raven-bulk-downloadall",
    status: "failed",
    ownerService: "scriptarr-raven",
    source: "broker",
    updatedAt: new Date().toISOString()
  }, {
    taskId: "broker-ghost-title-1",
    titleName: "Dandadan",
    requestType: "manga",
    status: "failed",
    ownerService: "scriptarr-raven",
    source: "broker",
    updatedAt: new Date().toISOString()
  }, {
    taskId: "failed-title-1",
    titleName: "Dandadan",
    requestType: "manga",
    status: "failed",
    ownerService: "scriptarr-raven",
    source: "raven",
    updatedAt: new Date().toISOString()
  }]);

  assert.deepEqual(payload.needsAttention.map((task) => task.taskId), ["failed-title-1"]);
});
