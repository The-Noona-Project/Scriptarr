/** @file Downloadall durable delivery and approval retry contract tests. */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {createDownloadAllBroker, downloadAllRequestIdError} from "../lib/downloadAllBroker.mjs";
import {registerInternalBrokerRoutes} from "../lib/registerInternalBrokerRoutes.mjs";
import {createServiceAuth} from "../lib/serviceAuth.mjs";

const fixture = () => {
  const jobs = new Map(), tasks = new Map();
  jobs.set("run-1", {jobId: "run-1", ownerService: "scriptarr-raven", kind: "raven-bulk-downloadall", status: "paused",
    requestedBy: "owner", payload: {type: "Manhua", nsfw: false, titlegroup: "T", batchesPerApproval: 20, approvalId: "window-1"}, result: {completedTitleTaskCount: 3}});
  tasks.set("run-1", [{taskId: "batch-1", taskKey: "bulk-batch", status: "completed", sortOrder: 0, payload: {type: "Manhua", titlePrefix: "T"}}]);
  const copy = (value) => structuredClone(value);
  const vaultClient = {
    getJob: async (id) => copy(jobs.get(id) || null),
    upsertJob: async (id, value) => { jobs.set(id, copy(value)); return copy(value); },
    listJobs: async (filters) => [...jobs.values()].filter((job) => job.ownerService === filters.ownerService && job.kind === filters.kind).map(copy),
    listJobTasks: async (id) => copy(tasks.get(id) || []),
    getSetting: async () => ({value: []})
  };
  const calls = [];
  const serviceJson = async (_base, path, options) => {
    calls.push({path, options});
    return {ok: true, status: 200, payload: {runId: "run-1", approvalId: "window-1", status: "paused"}};
  };
  const config = {ravenBaseUrl: "http://unused", publicBaseUrl: "https://example.test"};
  const broker = createDownloadAllBroker({vaultClient, config, serviceJson});
  return {broker, vaultClient, jobs, tasks, calls, config, serviceJson};
};
const preparePrompt = async (f) => {
  const notification = (await f.broker.listNotifications()).notifications[0];
  await f.broker.beginDelivery(notification.id, {botIdentity: "noona"});
  await f.broker.recordDelivery(notification.id, {messageId: "message-1", channelId: "channel-1"});
  await f.broker.registerPrompt(notification.id, {messageId: "message-1"});
  return notification;
};

test("paused summary revisions edit one acknowledged delivery without resetting its prompt", async () => {
  const f = fixture(), notification = await preparePrompt(f);
  await f.broker.acknowledge(notification.id);
  const current = f.jobs.get("run-1");
  current.payload.summaryRevision = 1; current.result.completedTitleTaskCount = 13;
  current.result.failedTitleTaskCount = 22; current.result.skippedUnavailableCount = 1;
  const update = (await f.broker.listNotifications()).notifications[0];
  assert.equal(update.refreshOnly, true); assert.equal(update.delivery.messageId, "message-1");
  assert.equal(update.counts.completedTitleTaskCount, 13); assert.equal(update.counts.failedTitleTaskCount, 22);
  assert.equal(update.counts.skippedUnavailableCount, 1); assert.equal(update.approvalId, "window-1");
  const edit = {botIdentity: "noona", messageId: "message-1", channelId: "channel-1", summaryRevision: 1};
  await assert.rejects(f.broker.refreshSummary(notification.id, {...edit, botIdentity: "appa"}), {status: 409});
  await f.broker.refreshSummary(notification.id, edit); await f.broker.refreshSummary(notification.id, edit);
  assert.deepEqual((await f.broker.listNotifications()).notifications, []);
  assert.equal(f.jobs.get("run-1").payload.approvalId, "window-1");
  assert.equal(f.calls.length, 0);
});

test("a newer begin snapshot cannot acknowledge an older sent summary as current", async () => {
  const f = fixture(), listed = (await f.broker.listNotifications()).notifications[0];
  f.jobs.get("run-1").payload.summaryRevision = 1;
  await f.broker.beginDelivery(listed.id, {botIdentity: "noona"});
  await f.broker.recordDelivery(listed.id, {messageId: "message", channelId: "channel", summaryRevision: listed.summaryRevision});
  await f.broker.registerPrompt(listed.id, {messageId: "message"});
  await f.broker.acknowledge(listed.id);
  const update = (await f.broker.listNotifications()).notifications[0];
  assert.equal(update.refreshOnly, true); assert.equal(update.summaryRevision, 1);
  await f.broker.refreshSummary(listed.id, {botIdentity: "noona", messageId: "message", channelId: "channel", summaryRevision: 1});
  await f.broker.acknowledge(listed.id);
  assert.deepEqual((await f.broker.listNotifications()).notifications, []);
});

test("delivery phases survive restart and retain a stable short nonce and tombstone", async () => {
  const f = fixture();
  const notification = (await f.broker.listNotifications()).notifications[0];
  assert.equal(notification.approvalId, "window-1");
  const first = await f.broker.beginDelivery(notification.id, {botIdentity: "noona"});
  assert.ok(first.delivery.nonce.length <= 25);
  assert.equal((await f.broker.beginDelivery(notification.id, {botIdentity: "noona"})).delivery.nonce, first.delivery.nonce);
  await assert.rejects(f.broker.acknowledge(notification.id), {status: 409});
  await f.broker.recordDelivery(notification.id, {messageId: "message-1", channelId: "channel-1"});
  await assert.rejects(f.broker.acknowledge(notification.id), {status: 409});
  await f.broker.registerPrompt(notification.id, {messageId: "message-1"});
  await f.broker.acknowledge(notification.id);
  const restarted = createDownloadAllBroker(f);
  assert.deepEqual((await restarted.listNotifications()).notifications, []);
  f.jobs.get("run-1").payload.approvalId = "window-2";
  assert.equal((await restarted.listNotifications()).notifications[0].approvalId, "window-2");
});

test("old ambiguous sends and bot changes block automatic resend but accept a reconciled receipt", async () => {
  const f = fixture(); let time = Date.now();
  const broker = createDownloadAllBroker({...f, clock: () => time});
  const id = (await broker.listNotifications()).notifications[0].id;
  await broker.beginDelivery(id, {botIdentity: "noona"}); time += 120001;
  assert.equal((await broker.beginDelivery(id, {botIdentity: "noona"})).delivery.phase, "ambiguous");
  await broker.recordDelivery(id, {messageId: "reconciled", channelId: "channel"});
  assert.equal((await broker.beginDelivery(id, {botIdentity: "appa"})).delivery.phase, "sent");
  await assert.rejects(broker.recordDelivery(id, {messageId: "different", channelId: "channel"}), {status: 409});
});

test("durable discovery and title plans do not appear as completed approval batches", async () => {
  const f = fixture();
  f.tasks.get("run-1").push({taskId: "plan-discovery", taskKey: "bulk-discovery-plan", status: "completed", payload: {kind: "bulk-discovery-plan"}},
    {taskId: "plan-title", taskKey: "bulk-title-plan", status: "completed", payload: {kind: "bulk-title-plan"}});
  const notification = (await f.broker.listNotifications()).notifications[0];
  assert.equal(notification.counts.completedBatches, 1);
  assert.equal(notification.counts.remainingBatches, 0);
  assert.equal(notification.batchId, "batch-1");
});

test("notification counts and summary retain every nonzero policy skip separately from completions", async () => {
  const f = fixture();
  Object.assign(f.jobs.get("run-1").result, {completedTitleTaskCount: 0, skippedActiveCount: 2,
    skippedAdultContentCount: 3, skippedNoMetadataCount: 4, skippedAmbiguousMetadataCount: 5, invalidSourceCount: 6});
  const notification = (await f.broker.listNotifications()).notifications[0];
  assert.equal(notification.counts.completedTitleTaskCount, 0); assert.equal(notification.summary.completedTitles, 0);
  for (const [field, alias, expected] of [["skippedActiveCount", "skippedActive", 2], ["skippedAdultContentCount", "skippedAdultContent", 3],
    ["skippedNoMetadataCount", "skippedNoMetadata", 4], ["skippedAmbiguousMetadataCount", "skippedAmbiguousMetadata", 5], ["invalidSourceCount", "invalidSource", 6]]) {
    assert.equal(notification.counts[field], expected); assert.equal(notification.summary[alias], expected);
  }
});

test("paused live-shaped run reports unresolved plans and failed work before retry exhaustion", async () => {
  const f = fixture(), unresolved = Array.from({length: 34}, (_, index) => `plan-${index}`);
  Object.assign(f.jobs.get("run-1").result, {completedTitleTaskCount: 0, failedCount: 34, failedTitleTaskCount: 0, queuedCount: 1, skippedNoMetadataCount: 1});
  f.tasks.set("run-1", [{taskId: "batch-t", taskKey: "bulk-batch", status: "paused", label: "T Manhua", payload: {type: "Manhua", titlePrefix: "T"},
    result: {observedStatuses: {"task-tales": "failed"}, failedTaskIds: [], attempts: {"task-tales": 2}, approvalAttempts: {"task-tales": 2}, unresolvedPlanIds: unresolved}},
  ...unresolved.map(taskId => ({taskId, status: "failed", payload: {kind: "bulk-title-plan"}, result: {category: "unresolved"}})),
  {taskId: "plan-tales", status: "queued", payload: {kind: "bulk-title-plan"}, result: {category: "queued"}},
  {taskId: "plan-no-match", status: "completed", payload: {kind: "bulk-title-plan"}, result: {category: "noMetadata"}}]);
  f.vaultClient.listRavenDownloadTasks = async () => assert.fail("Notifications must not load the global download-task list.");
  const notification = (await f.broker.listNotifications()).notifications[0];
  assert.equal(notification.counts.completedBatches, 0);
  assert.equal(notification.counts.remainingBatches, 1);
  assert.equal(notification.counts.unresolvedPlanCount, 34);
  assert.equal(notification.counts.failedTitleTaskCount, 1);
  assert.equal(notification.counts.exhaustedTitleTaskCount, 0);
  assert.equal(notification.summary.unresolvedPlans, 34);
  assert.equal(notification.summary.failedTitles, 1);
  assert.match(notification.pauseReason, /34 title plan\(s\) could not be prepared/);
  assert.match(notification.message, /1 title task\(s\) failed/);
  assert.equal(notification.currentBatch.status, "paused");
  assert.equal(notification.currentBatch.label, "T Manhua");
  assert.deepEqual(f.calls, []);
});

test("resolved plans do not retain stale failure ids and an interrupted batch is identified correctly", async () => {
  const f = fixture();
  Object.assign(f.jobs.get("run-1").result, {failedCount: 1});
  f.tasks.get("run-1").push({taskId: "batch-2", taskKey: "bulk-batch", status: "paused", sortOrder: 1, label: "T Manhua",
    result: {unresolvedPlanIds: ["resolved-plan"]}},
  {taskId: "resolved-plan", payload: {kind: "bulk-title-plan"}, result: {category: "current"}});
  const notification = (await f.broker.listNotifications()).notifications[0];
  assert.equal(notification.counts.unresolvedPlanCount, 0);
  assert.equal(notification.batchId, "batch-2");
  assert.equal(notification.currentBatch.status, "paused");
});

test("updated failure projection never resets an acknowledged old window or its pending prompt", async () => {
  const f = fixture(), notification = await preparePrompt(f);
  await f.broker.acknowledge(notification.id);
  const receipts = [...f.jobs.values()].filter(job => job.ownerService === "scriptarr-sage").map(job => structuredClone(job));
  f.tasks.get("run-1").push({taskId: "unresolved-plan", payload: {kind: "bulk-title-plan"}, result: {category: "unresolved"}});
  f.tasks.get("run-1")[0].result = {observedStatuses: {"task-tales": "failed"}};
  Object.assign(f.jobs.get("run-1").result, {failedCount: 1});
  assert.deepEqual((await createDownloadAllBroker(f).listNotifications()).notifications, []);
  for (const receipt of receipts) assert.deepEqual(f.jobs.get(receipt.jobId), receipt);
  assert.deepEqual(f.calls, []);
});

test("an accepted paused message can finish delivery after the run advances", async () => {
  const f = fixture(); const notification = (await f.broker.listNotifications()).notifications[0];
  await f.broker.beginDelivery(notification.id, {botIdentity: "noona"});
  await f.broker.recordDelivery(notification.id, {messageId: "old-message", channelId: "channel"});
  f.jobs.get("run-1").status = "running";
  assert.equal((await createDownloadAllBroker(f).listNotifications()).notifications[0].id, notification.id);
  await f.broker.registerPrompt(notification.id, {messageId: "old-message"});
  await f.broker.acknowledge(notification.id);
  assert.equal((await f.broker.listNotifications()).notifications.length, 0);
});

test("concurrent reaction claims execute once and prompt retries preserve handled state", async () => {
  const f = fixture(); const notification = await preparePrompt(f);
  const decision = {messageId: "message-1", userId: "owner", emoji: "✅"};
  await assert.rejects(f.broker.decide({...decision, userId: "other"}), {status: 403});
  const results = await Promise.all([f.broker.decide(decision), f.broker.decide(decision)]);
  assert.deepEqual(results[0], results[1]); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.body.approvalId, "window-1");
  assert.match(f.calls[0].options.body.requestId, /^discord:decision:/);
  const prompt = [...f.jobs.values()].find((job) => job.kind === "portal-downloadall-prompt");
  prompt.payload = Object.fromEntries(Object.entries(prompt.payload).reverse());
  assert.equal((await f.broker.registerPrompt(notification.id, {messageId: "message-1"})).prompt.status, "handled");
  await f.broker.decide(decision); assert.equal(f.calls.length, 1);
  await assert.rejects(f.broker.decide({...decision, emoji: "❌"}), {status: 409});
});

test("failed durable decision claim cannot invoke Raven", async () => {
  const f = fixture(); await preparePrompt(f);
  f.vaultClient.upsertJob = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(f.broker.decide({messageId: "message-1", userId: "owner", emoji: "✅"}), /storage unavailable/);
  assert.equal(f.calls.length, 0);
});

test("expired or invalid unclaimed prompts cannot invoke Raven", async () => {
  const f = fixture(); await preparePrompt(f);
  const expired = createDownloadAllBroker({...f, clock: () => Date.now() + 8 * 86400000});
  const decision = {messageId: "message-1", userId: "owner", emoji: "✅"};
  await assert.rejects(expired.decide(decision), {status: 409});
  [...f.jobs.values()].find((job) => job.kind === "portal-downloadall-prompt").createdAt = "invalid";
  await assert.rejects(f.broker.decide(decision), {status: 409});
  assert.equal(f.calls.length, 0);
});

test("ambiguous reaction responses retry the original token and request after restart", async () => {
  const f = fixture(); await preparePrompt(f); const calls = [];
  const serviceJson = async (_base, _path, options) => {
    calls.push(options.body);
    return calls.length === 1 ? {ok: false, status: 503, payload: {error: "lost response"}} : {ok: true, status: 200, payload: {runId: "run-1"}};
  };
  const decision = {messageId: "message-1", userId: "owner", emoji: "✅"};
  assert.equal((await createDownloadAllBroker({...f, serviceJson}).decide(decision)).status, 503);
  f.jobs.get("run-1").payload.approvalId = "newer-window";
  assert.equal((await createDownloadAllBroker({...f, serviceJson}).decide(decision)).status, 200);
  assert.deepEqual(calls[0], calls[1]);
});

test("manual action retries persist the first token and reject requestId identity changes", async () => {
  const f = fixture(); const calls = []; let statusReads = 0;
  const serviceJson = async (_base, _path, options = {}) => {
    if (!options.method) { statusReads++; return {ok: true, status: 200, payload: {approvalId: `window-${statusReads}`}}; }
    calls.push(options.body);
    return calls.length === 1 ? {ok: false, status: 503, payload: {error: "lost"}} : {ok: true, status: 200, payload: {status: "running"}};
  };
  const body = {requestId: "discord:interaction:123", requestedBy: "owner"};
  assert.equal((await createDownloadAllBroker({...f, serviceJson}).actOnRun("run-1", "continue", body)).status, 503);
  const restarted = createDownloadAllBroker({...f, serviceJson});
  assert.equal((await restarted.actOnRun("run-1", "continue", body)).status, 200);
  await restarted.actOnRun("run-1", "continue", body);
  assert.equal(statusReads, 1); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  await assert.rejects(restarted.actOnRun("run-1", "cancel", body), {status: 409});
  await assert.rejects(restarted.actOnRun("run-1", "continue", {...body, requestedBy: "other"}), {status: 409});
  await assert.rejects(restarted.actOnRun("run-1", "continue", {...body, requestId: {invalid: true}}), {status: 400});
});

test("active cancellation always captures a token and retains a stale-window conflict receipt", async () => {
  const f = fixture(); const calls = [];
  const serviceJson = async (_base, _path, options = {}) => {
    if (!options.method) return {ok: true, status: 200, payload: {approvalId: "active-token", status: "running"}};
    calls.push(options.body); return {ok: false, status: 409, payload: {error: "stale window"}};
  };
  const broker = createDownloadAllBroker({...f, serviceJson});
  const body = {requestId: "discord:interaction:cancel", requestedBy: "owner"};
  assert.equal((await broker.actOnRun("run-1", "cancel", body)).status, 409);
  assert.equal((await broker.actOnRun("run-1", "cancel", body)).status, 409);
  assert.deepEqual(calls, [{...body, approvalId: "active-token"}]);
});

test("more than 500 acknowledged notifications cannot evict old delivery tombstones", async () => {
  const f = fixture(); f.jobs.clear(); f.tasks.clear();
  for (let index = 0; index < 501; index++) {
    const runId = `run-${index}`;
    f.jobs.set(runId, {jobId: runId, ownerService: "scriptarr-raven", kind: "raven-bulk-downloadall", status: "completed", requestedBy: "owner", payload: {}, result: {}});
    const id = `downloadall:${runId}:completed:completed`;
    await f.broker.beginDelivery(id, {botIdentity: "noona"});
    await f.broker.recordDelivery(id, {messageId: `message-${index}`, channelId: "channel"});
    await f.broker.acknowledge(id);
  }
  assert.equal((await createDownloadAllBroker(f).listNotifications()).notifications.length, 0);
  assert.equal([...f.jobs.values()].filter((job) => job.kind === "portal-downloadall-delivery").length, 501);
});

test("stable request identifier validation is bounded and exact", () => {
  assert.equal(downloadAllRequestIdError("discord:interaction:123"), "");
  assert.equal(downloadAllRequestIdError(undefined), "");
  for (const value of [" padded", "a".repeat(201), {}, "bad/key"]) assert.notEqual(downloadAllRequestIdError(value), "");
});

test("authenticated create route forwards exact Manhua false t 20 and requestId", async () => {
  const f = fixture(); const calls = [];
  const app = express(); app.use(express.json());
  const config = {...f.config, serviceTokens: {"scriptarr-portal": "test-portal"}};
  registerInternalBrokerRoutes(app, {config, vaultClient: f.vaultClient,
    requireService: createServiceAuth(config), readRequestWorkflowSettings: async () => ({}),
    serviceJson: async (base, path, options) => { calls.push({base, path, options}); return {ok: true, status: 200, payload: {runId: "same-run"}}; }});
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/internal/portal/downloads/bulk-runs`;
  const body = {providerId: "weebcentral", type: "Manhua", nsfw: false, titlePrefix: "t", batchesPerApproval: 20, requestedBy: "owner", requestId: "discord:interaction:123"};
  try {
    assert.equal((await fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)})).status, 401);
    const headers = {"Content-Type": "application/json", Authorization: "Bearer test-portal"};
    assert.equal((await fetch(url, {method: "POST", headers, body: JSON.stringify(body)})).status, 200);
    assert.deepEqual(calls[0].options.body, {...body, titlegroup: "t", groupsize: 20});
    assert.equal((await fetch(url, {method: "POST", headers, body: JSON.stringify({...body, requestId: "bad/key"})})).status, 400);
    assert.equal(calls.length, 1);
    const notificationsUrl = url.replace("/downloads/bulk-runs", "/notifications/downloadall");
    const notification = (await (await fetch(notificationsUrl, {headers})).json()).notifications[0];
    const phase = (name, data = {}) => fetch(`${notificationsUrl}/${encodeURIComponent(notification.id)}/${name}`,
      {method: "POST", headers, body: JSON.stringify(data)});
    assert.equal((await phase("begin", {botIdentity: "noona"})).status, 200);
    assert.equal((await phase("delivery", {messageId: "message-http", channelId: "channel-http"})).status, 200);
    assert.equal((await phase("prompt", {messageId: "message-http"})).status, 200);
    assert.equal((await phase("ack")).status, 200);
    const decision = await fetch(`${url}/decision`, {method: "POST", headers, body: JSON.stringify({messageId: "message-http", userId: "owner", emoji: "✅"})});
    assert.equal(decision.status, 200); assert.equal(calls.length, 2);
    assert.equal(calls[1].options.body.approvalId, "window-1");
    assert.match(calls[1].options.body.requestId, /^discord:decision:/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
