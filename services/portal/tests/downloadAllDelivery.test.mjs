import test from "node:test";
import assert from "node:assert/strict";
import {createDownloadAllDelivery} from "../lib/downloadAllDelivery.mjs";
import {createDownloadAllCommand} from "../lib/discord/commands/downloadAllCommand.mjs";
import {createDirectMessageHandler} from "../lib/discord/directMessageRouter.mjs";
import {formatBulkRunSummary} from "../lib/discord/downloadAllShared.mjs";
import {buildDownloadAllDirectMessagePayload} from "../lib/followNotifier.mjs";

const fixture = () => {
  const notification = {id: "downloadall:run:window:paused", status: "paused", approvalId: "window", runId: "run", discordUserId: "owner"};
  let delivery = {phase: "sending", nonce: "123456789012345678901234"};
  const counts = {send: 0, prompt: 0, ack: 0, receipt: 0, reaction: 0};
  const message = {id: "message", channelId: "channel", react: async () => { counts.reaction++; }};
  const ok = (payload = {}) => ({ok: true, status: 200, payload});
  const sage = {
    listDownloadAllNotifications: async () => ok({notifications: delivery.phase === "acknowledged" ? [] : [notification]}),
    beginDownloadAllDelivery: async () => ok({delivery: structuredClone(delivery)}),
    recordDownloadAllDelivery: async (_id, body) => { counts.receipt++; delivery = {...delivery, ...body, phase: "sent"}; return ok({delivery: structuredClone(delivery)}); },
    recordDownloadAllDecisionPrompt: async () => { counts.prompt++; delivery.promptReady = true; return ok(); },
    acknowledgeDownloadAllNotification: async () => { counts.ack++; delivery.phase = "acknowledged"; return ok(); }
  };
  const discord = {
    sendDirectMessage: async (_user, payload) => { counts.send++; assert.equal(payload.enforceNonce, true); assert.ok(payload.nonce.length <= 25); return message; },
    fetchDirectMessage: async (channelId, messageId) => { assert.equal(channelId, "channel"); assert.equal(messageId, "message"); return message; }
  };
  const create = () => createDownloadAllDelivery({sage, discord, botIdentity: "noona"});
  return {sage, discord, counts, message, create, notification, setDelivery: (value) => { delivery = value; }};
};
const payload = async () => ({content: "paused summary"});

test("a lost initial receipt retains the revision of the message actually sent", async () => {
  const f = fixture(), record = f.sage.recordDownloadAllDelivery, sent = [];
  f.notification.summaryRevision = 3;
  f.sage.recordDownloadAllDelivery = async (id, body) => {
    sent.push(body.summaryRevision);
    if (sent.length === 1) throw new Error("receipt not persisted");
    return record(id, body);
  };
  const delivery = f.create(); await delivery.poll(payload);
  f.notification.summaryRevision = 9; await delivery.poll(payload);
  assert.deepEqual(sent, [3, 3]); assert.equal(f.counts.send, 1);
});

test("summary edit acknowledgement loss retries the original message without sending or registering prompts", async () => {
  const f = fixture(); let edits = 0, receipts = 0;
  f.message.edit = async body => { assert.equal(body.content, "paused summary"); edits++; };
  f.sage.listDownloadAllNotifications = async () => ({ok: true, payload: {notifications: [{...f.notification,
    refreshOnly: true, summaryRevision: 3, delivery: {botIdentity: "noona", messageId: "message", channelId: "channel"}}]}});
  f.sage.recordDownloadAllSummary = async (_id, body) => {
    assert.equal(body.summaryRevision, 3); assert.equal(body.messageId, "message");
    if (++receipts === 1) throw Error("edit receipt lost");
    return {ok: true};
  };
  await f.create().poll(payload); await f.create().poll(payload);
  assert.equal(edits, 2); assert.equal(receipts, 2);
  assert.equal(f.counts.send, 0); assert.equal(f.counts.prompt, 0); assert.equal(f.counts.ack, 0);
});

test("slash and DM summaries distinguish completed title tasks from every policy skip", () => {
  const counts = {completedTitleTaskCount: 0, queuedCount: 0, skippedActiveCount: 2, skippedAdultContentCount: 3,
    skippedNoMetadataCount: 4, skippedAmbiguousMetadataCount: 5, invalidSourceCount: 6};
  const result = {runId: "run", status: "completed", counts};
  const slash = formatBulkRunSummary(result);
  assert.match(slash, /Title tasks completed: 0/);
  for (const [label, count] of [["Already active", 2], ["Adult or unverified content", 3], ["No metadata match", 4], ["Ambiguous metadata", 5], ["Invalid source rows", 6]]) {
    assert.ok(slash.includes(`${label}: ${count}`));
  }
  const dm = buildDownloadAllDirectMessagePayload(result);
  assert.match(dm.content, /0 title task\(s\) completed/);
  const skipped = dm.embeds[0].fields.find(field => field.name === "Skipped").value;
  for (const [label, count] of [["Already active", 2], ["Adult or unverified content", 3], ["No metadata match", 4], ["Ambiguous metadata", 5], ["Invalid source rows", 6]]) {
    assert.ok(skipped.includes(`${label}: **${count}**`));
  }
});

test("paused live-shaped status and notification show unresolved plans and unexhausted failed work", () => {
  const rawStatus = {runId: "run", status: "paused", filters: {type: "Manhua", nsfw: false, titlegroup: "T", batchesPerApproval: 20},
    counts: {completedBatches: 0, remainingBatches: 1, failedCount: 34, failedTitleTaskCount: 0, completedTitleTaskCount: 0},
    currentBatch: {status: "paused", label: "T Manhua"},
    batches: [{result: {observedStatuses: {"task-tales": "failed"}, failedTaskIds: [], approvalAttempts: {"task-tales": 2},
      unresolvedPlanIds: Array.from({length: 34}, (_, index) => `plan-${index}`)}}]};
  const notification = {...rawStatus, batches: undefined, counts: {...rawStatus.counts, unresolvedPlanCount: 34, failedTitleTaskCount: 1},
    summary: {failedTitles: 1, unresolvedPlans: 34}};
  for (const value of [rawStatus, notification]) {
    const slash = formatBulkRunSummary(value), dm = buildDownloadAllDirectMessagePayload(value);
    assert.match(slash, /Unresolved title plans: 34/);
    assert.match(slash, /Failed title tasks: 1/);
    assert.match(slash, /Pause reason: 34 title plan\(s\) could not be prepared; 1 title task\(s\) failed/);
    assert.match(dm.content, /paused: 34 title plan\(s\) could not be prepared; 1 title task\(s\) failed/);
    const attention = dm.embeds[0].fields.find(field => field.name === "Needs attention").value;
    assert.match(attention, /Unresolved title plans: \*\*34\*\*/);
    assert.match(attention, /Failed title tasks: \*\*1\*\*/);
    assert.doesNotMatch(attention, /None reported/);
    assert.ok(dm.embeds[0].fields.some(field => field.name === "Paused batch" && field.value === "T Manhua"));
    assert.ok(!dm.embeds[0].fields.some(field => field.name === "Last completed batch"));
  }
});

test("prompt HTTP failures retry the accepted message after process restart", async () => {
  const f = fixture(); const record = f.sage.recordDownloadAllDecisionPrompt; let attempts = 0;
  f.sage.recordDownloadAllDecisionPrompt = async (...args) => ++attempts === 1 ? {ok: false, status: 503} : record(...args);
  await f.create().poll(payload);
  assert.equal(f.counts.send, 1); assert.equal(f.counts.ack, 0);
  await f.create().poll(payload);
  assert.equal(f.counts.send, 1); assert.equal(f.counts.prompt, 1); assert.equal(f.counts.ack, 1); assert.equal(f.counts.reaction, 2);
});

test("ack HTTP failure retries only acknowledgement and never resends", async () => {
  const f = fixture(); const ack = f.sage.acknowledgeDownloadAllNotification; let attempts = 0;
  f.sage.acknowledgeDownloadAllNotification = async (...args) => ++attempts === 1 ? {ok: false, status: 500} : ack(...args);
  await f.create().poll(payload); await f.create().poll(payload);
  assert.equal(attempts, 2); assert.equal(f.counts.send, 1); assert.equal(f.counts.prompt, 1);
});

test("an accepted prompt with a lost response still exposes reactions on retry", async () => {
  const f = fixture(); const record = f.sage.recordDownloadAllDecisionPrompt; let attempts = 0;
  f.sage.recordDownloadAllDecisionPrompt = async (...args) => {
    const response = await record(...args);
    if (++attempts === 1) throw new Error("prompt response lost");
    return response;
  };
  await f.create().poll(payload); await f.create().poll(payload);
  assert.equal(f.counts.send, 1); assert.equal(f.counts.prompt, 1); assert.equal(f.counts.reaction, 2); assert.equal(f.counts.ack, 1);
});

test("a failed receipt retains the known accepted message for retry", async () => {
  const f = fixture(); const record = f.sage.recordDownloadAllDelivery; let attempts = 0;
  f.sage.recordDownloadAllDelivery = async (...args) => ++attempts === 1 ? {ok: false, status: 503} : record(...args);
  const delivery = f.create(); await delivery.poll(payload); await delivery.poll(payload);
  assert.equal(f.counts.send, 1); assert.equal(f.counts.receipt, 1); assert.equal(f.counts.ack, 1);
});

test("lost Discord response retries the same enforced nonce rather than a second physical message", async () => {
  const f = fixture(); const nonces = new Set(); let attempts = 0;
  f.discord.sendDirectMessage = async (_user, body) => {
    assert.equal(body.enforceNonce, true); nonces.add(body.nonce);
    if (++attempts === 1) throw new Error("accepted but response lost");
    return f.message;
  };
  await f.create().poll(payload); await f.create().poll(payload);
  assert.equal(attempts, 2); assert.equal(nonces.size, 1); assert.equal(f.counts.ack, 1);
});

test("an old ambiguous send is left for reconciliation without sending or acknowledging", async () => {
  const f = fixture(); f.setDelivery({phase: "ambiguous", nonce: "old"});
  await f.create().poll(payload);
  assert.equal(f.counts.send, 0); assert.equal(f.counts.ack, 0);
});

test("stopping during Discord send still records the accepted identity", async () => {
  const f = fixture(); let active = true;
  f.discord.sendDirectMessage = async () => { active = false; return f.message; };
  await f.create().poll(payload, () => active);
  assert.equal(f.counts.receipt, 1);
});

test("slash run and action propagate stable original interaction identifiers", async () => {
  const forwarded = [], actions = [];
  const command = createDownloadAllCommand({getSettings: () => ({superuserId: "owner"}), sage: {
    createBulkRun: async (body) => { forwarded.push(body); return {ok: true, payload: {runId: "run", status: "running"}}; },
    continueBulkRun: async (id, body) => { actions.push({id, body}); return {ok: true, payload: {runId: id, status: "running"}}; }
  }});
  let action = "run";
  const interaction = {id: "original-interaction", user: {id: "owner"}, deferred: true,
    options: {getSubcommand: () => action, getString: (name) => ({type: "Manhua", titlegroup: "t", runid: "run"})[name], getBoolean: () => false, getInteger: () => 20},
    deferReply: async () => {}, editReply: async () => {}};
  await command.execute(interaction); await command.execute(interaction);
  assert.deepEqual(forwarded[0], forwarded[1]);
  assert.deepEqual(forwarded[0], {providerId: "weebcentral", type: "Manhua", nsfw: false, titlePrefix: "t", groupsize: 20, batchesPerApproval: 20, requestedBy: "owner", requestId: "discord:interaction:original-interaction"});
  action = "continue"; await command.execute(interaction);
  assert.equal(actions[0].body.requestId, "discord:interaction:original-interaction");
});

test("summary edits select the original sender after split mode becomes available", async () => {
  let refreshed;
  const message = {edit: async () => {}};
  const noona = {fetchDirectMessage: async (channel, id) => { assert.equal(channel, "channel"); assert.equal(id, "message"); return message; }};
  const delivery = createDownloadAllDelivery({botIdentity: "appa", discord: {fetchDirectMessage: async () => assert.fail("Appa cannot edit Noona's message")},
    discordForIdentity: (identity) => identity === "noona" ? noona : null, sage: {
      listDownloadAllNotifications: async () => ({ok: true, payload: {notifications: [{id: "notification", refreshOnly: true, summaryRevision: 2,
        delivery: {botIdentity: "noona", messageId: "message", channelId: "channel"}}]}}),
      recordDownloadAllSummary: async (_id, body) => { refreshed = body; return {ok: true}; }
    }});
  await delivery.poll(async () => ({content: "updated"}));
  assert.equal(refreshed.botIdentity, "noona"); assert.equal(refreshed.summaryRevision, 2);
});

test("legacy DM creation uses the original message identifier", async () => {
  const bodies = [];
  const handler = createDirectMessageHandler({getSettings: () => ({superuserId: "owner"}), sage: {
    createBulkRun: async (body) => { bodies.push(body); return {ok: true, payload: {runId: "run"}}; }
  }});
  await handler({id: "original-message", content: "downloadall type:Manhua nsfw:False titlegroup:t groupsize:20", author: {id: "owner"}, reply: async () => ({})});
  assert.equal(bodies[0].requestId, "discord:message:original-message");
  assert.equal(bodies[0].nsfw, false);
});


test("chapter-specific pause problems remain bounded and cannot create Discord mentions", () => {
  const notification = {status: "paused", failedTitleTaskCount: 1, problems: Array.from({length: 50}, () => ({
    titleName: "@everyone" + "T".repeat(200), chapterNumber: "197", message: "Chapter 197: " + "source unavailable ".repeat(50)
  }))};
  const payload = buildDownloadAllDirectMessagePayload(notification);
  const attention = payload.embeds[0].fields.find(field => field.name === "Needs attention");
  assert.ok(attention.value.includes("Chapter 197")); assert.ok(attention.value.length <= 1024);
  assert.ok(!attention.value.includes("@everyone"));
  for (const field of payload.embeds[0].fields) assert.ok(field.value.length <= 1024);
});

test("slash status renders chapter problems from the durable run summary", () => {
  const output = formatBulkRunSummary({status: "paused", summary: {completionProblems: [{titleName: "Warrior", chapterNumber: "197", message: "Chapter 197: source chapter has no usable archive."}]}});
  assert.match(output, /Warrior: Chapter 197: source chapter has no usable archive/);
});


test("slash status cannot exceed Discord's content limit with long messages and chapter diagnostics", () => {
  const output = formatBulkRunSummary({status: "paused", runId: "bulkrun_" + "a".repeat(64), message: "source details ".repeat(1000), summary: {completionProblems: Array.from({length: 50}, () => ({titleName: "T".repeat(100), message: "missing ".repeat(100)}))}});
  assert.ok(output.length <= 2000); assert.match(output, /bulkrun_/); assert.match(output, /admin queue/);
});
