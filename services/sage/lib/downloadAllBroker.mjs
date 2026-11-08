/** @file Durable Discord downloadall deliveries and approval claims. */
import {createHash, randomUUID} from "node:crypto";

const text = (value) => typeof value === "string" ? value.trim() : "";
const array = (value) => Array.isArray(value) ? value : [];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const DELIVERY_KIND = "portal-downloadall-delivery";
const PROMPT_KIND = "portal-downloadall-prompt";
const ACTION_KIND = "portal-downloadall-action";
const AMBIGUOUS_RETRY_MS = 120000;
const PROMPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const fail = (status, message) => Object.assign(new Error(message), {status});
const checked = (response) => {
  if (!response?.ok) {
    throw fail(response?.status || 503, response?.payload?.error || "Downloadall service unavailable.");
  }
  return response.payload;
};

/** Validate an optional stable request identifier without silently changing it.
 * @param {unknown} value Caller request identifier.
 * @returns {string} A validation error, or an empty string.
 */
export const downloadAllRequestIdError = (value) => value == null || value === ""
  ? ""
  : typeof value !== "string" || !/^[a-zA-Z0-9:._-]{1,200}$/.test(value)
    ? "requestId must contain 1-200 letters, digits, colons, dots, underscores, or hyphens."
    : "";

const notificationFromJob = (job, tasks, publicBaseUrl) => {
  const plans = tasks.filter((task) => task.payload?.kind === "bulk-title-plan");
  tasks = tasks.filter((task) => task.taskKey === "bulk-batch");
  const status = text(job.status).toLowerCase();
  if (!["paused", "completed", "failed", "cancelled"].includes(status) || !text(job.requestedBy)) return null;
  const completed = tasks.filter((task) => task.status === "completed").sort((a, b) => Number(b.sortOrder || 0) - Number(a.sortOrder || 0));
  const interrupted = status === "paused" && tasks.find((task) => ["paused", "running"].includes(task.status));
  const batch = interrupted || completed[0] || tasks.find((task) => !["completed", "failed", "cancelled"].includes(task.status)) || {};
  const runPayload = job.payload || {};
  const filters = {providerId: runPayload.providerId, type: runPayload.type, nsfw: runPayload.nsfw,
    titlegroup: runPayload.titlegroup, titlePrefix: runPayload.titlegroup, batchesPerApproval: runPayload.batchesPerApproval};
  const result = job.result || {};
  const approvalId = text(runPayload.approvalId);
  const batchId = text(batch.taskId) || status;
  const id = `downloadall:${job.jobId}:${status === "paused" && approvalId ? approvalId : batchId}:${status}`;
  const batchesPerApproval = Number(filters.batchesPerApproval) || 1;
  const currentBatchLabel = text(batch.label) || [batch.payload?.titlePrefix, batch.payload?.type].filter(Boolean).join(" ");
  const counts = {completedBatches: completed.length, remainingBatches: Math.max(0, tasks.length - completed.length)};
  for (const field of ["queuedCount", "appendedCount", "completedTitleTaskCount", "failedTitleTaskCount", "staleTitleTaskCount", "skippedCompletedCount", "skippedCurrentCount",
    "skippedActiveCount", "skippedAdultContentCount", "skippedNoMetadataCount", "skippedAmbiguousMetadataCount", "invalidSourceCount"]) counts[field] = Number(result[field]) || 0;
  const failedIds = new Set(tasks.flatMap((task) => [
    ...array(task.result?.failedTaskIds),
    ...Object.entries(task.result?.observedStatuses || {}).filter(([, state]) => state === "failed").map(([id]) => id)
  ]));
  const planById = new Map(plans.map((task) => [task.taskId, task]));
  const unresolvedIds = new Set([
    ...plans.filter((task) => task.result?.category === "unresolved").map((task) => task.taskId),
    ...tasks.flatMap((task) => array(task.result?.unresolvedPlanIds)).filter((id) => !planById.has(id) || planById.get(id).result?.category === "unresolved")
  ]);
  counts.exhaustedTitleTaskCount = counts.failedTitleTaskCount;
  counts.failedTitleTaskCount = Math.max(counts.failedTitleTaskCount, failedIds.size);
  counts.unresolvedPlanCount = unresolvedIds.size || (!plans.length ? Number(result.failedCount) || 0 : 0);
  const pauseReason = status === "paused" ? [
    counts.unresolvedPlanCount ? `${counts.unresolvedPlanCount} title plan(s) could not be prepared` : "",
    counts.failedTitleTaskCount ? `${counts.failedTitleTaskCount} title task(s) failed` : "",
    counts.staleTitleTaskCount ? `${counts.staleTitleTaskCount} title task(s) stalled` : ""
  ].filter(Boolean).join("; ") : "";
  return {
    id, type: "downloadall", decisionType: status, discordUserId: text(job.requestedBy),
    titleName: "Scriptarr downloadall", status, runId: job.jobId, jobId: job.jobId,
    batchId, approvalId, batchesPerApproval, filters, counts, pauseReason,
    linkUrl: publicBaseUrl ? `${publicBaseUrl.replace(/\/+$/, "")}/admin/activity/queue` : "",
    message: status === "paused"
      ? pauseReason ? `Downloadall paused: ${pauseReason}.` : completed.length ? `Downloadall paused after ${completed.length} batch(es).` : "Downloadall paused before any batch completed."
      : `Downloadall ${status}. ${counts.completedTitleTaskCount} title task(s) completed.`,
    summary: {batchesPerApproval, completedBatches: completed.length, remainingBatches: counts.remainingBatches,
      completedTitles: counts.completedTitleTaskCount, queued: counts.queuedCount, appended: counts.appendedCount,
      skippedCompleted: counts.skippedCompletedCount, skippedCurrent: counts.skippedCurrentCount,
      skippedActive: counts.skippedActiveCount, skippedAdultContent: counts.skippedAdultContentCount,
      skippedNoMetadata: counts.skippedNoMetadataCount, skippedAmbiguousMetadata: counts.skippedAmbiguousMetadataCount,
      invalidSource: counts.invalidSourceCount,
      failedTitles: counts.failedTitleTaskCount, exhaustedTitles: counts.exhaustedTitleTaskCount,
      unresolvedPlans: counts.unresolvedPlanCount, pauseReason, staleTitles: counts.staleTitleTaskCount, currentBatchLabel},
    currentBatch: {taskId: text(batch.taskId), status: text(batch.status), label: currentBatchLabel,
      type: text(batch.payload?.type), titlePrefix: text(batch.payload?.titlePrefix || batch.payload?.titlegroup)},
    completedAt: text(job.finishedAt) || text(job.updatedAt)
  };
};

/** Create a single-Sage serialized, Vault-backed downloadall broker.
 * Raven remains authoritative for durable approval-token consumption; the local
 * locks serialize claims in this Sage process, not across database writers.
 * @param {{vaultClient: object, config: object, serviceJson: Function, clock?: Function}} options Dependencies.
 * @returns {object} Downloadall delivery and action operations.
 */
export const createDownloadAllBroker = ({vaultClient, config, serviceJson, clock = Date.now}) => {
  const now = () => new Date(clock()).toISOString();
  const locks = new Map();
  const serial = async (key, work) => {
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    locks.set(key, current);
    try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
  };
  const deliveryId = (id) => `portal_downloadall_delivery_${hash(id)}`;
  const promptId = (id) => `portal_downloadall_prompt_${hash(id)}`;
  const actionId = (id) => `portal_downloadall_action_${hash(id)}`;
  const save = async (id, kind, payload, result, existing = null) => vaultClient.upsertJob(id, {
    ...(existing || {}), jobId: id, kind, ownerService: "scriptarr-sage",
    label: "Discord downloadall delivery", requestedBy: payload.ownerDiscordUserId || payload.requestedBy || "scriptarr-portal",
    status: result.phase === "acknowledged" || result.phase === "handled" ? "completed" : result.phase === "ambiguous" ? "blocked" : "running",
    payload, result, createdAt: existing?.createdAt || now(), updatedAt: now()
  });
  const readDelivery = (id) => vaultClient.getJob(deliveryId(id));
  const requireDelivery = async (id) => {
    const job = await readDelivery(id);
    if (!job) throw fail(404, "Downloadall delivery not found.");
    return job;
  };
  const buildNotifications = async () => {
    const jobs = await vaultClient.listJobs({ownerService: "scriptarr-raven", kind: "raven-bulk-downloadall"});
    const notifications = [];
    for (const job of array(jobs)) {
      if (!["paused", "completed", "failed", "cancelled"].includes(job.status)) continue;
      const notification = notificationFromJob(job, array(await vaultClient.listJobTasks(job.jobId)), text(config.publicBaseUrl));
      if (notification) notifications.push(notification);
    }
    return notifications;
  };
  const readCurrentNotification = async (id) => {
    const runId = text(id).split(":")[1];
    if (!id.startsWith("downloadall:") || !runId) throw fail(400, "A valid downloadall notification id is required.");
    const run = await vaultClient.getJob(runId);
    const notification = run && notificationFromJob(run, array(await vaultClient.listJobTasks(runId)), text(config.publicBaseUrl));
    if (!notification || notification.id !== id) throw fail(409, "This downloadall notification is no longer current.");
    return notification;
  };
  const callRaven = async (runId, action, body) => {
    try { return await serviceJson(config.ravenBaseUrl, `/v1/downloads/bulk-runs/${encodeURIComponent(runId)}${action ? `/${action}` : ""}`, action ? {method: "POST", body} : {}); }
    catch { return {ok: false, status: 503, payload: {error: "Downloadall service unavailable; retry the same action."}}; }
  };
  const deliverState = (job) => ({...job.result, notificationId: job.payload.notificationId, botIdentity: job.payload.botIdentity});
  return {
    async listNotifications() {
      const legacy = new Set(array((await vaultClient.getSetting("portal.downloadAllNotifications"))?.value));
      const current = await buildNotifications();
      const deliveries = array(await vaultClient.listJobs({ownerService: "scriptarr-sage", kind: DELIVERY_KIND}));
      const candidates = new Map();
      for (const delivery of deliveries) {
        if (["acknowledged", "ambiguous"].includes(delivery.result?.phase)) continue;
        const snapshot = delivery.payload.notification;
        if (snapshot) candidates.set(snapshot.id, snapshot);
      }
      for (const notification of current) candidates.set(notification.id, notification);
      const notifications = [];
      for (const notification of candidates.values()) {
        if (legacy.has(notification.id)) continue;
        const delivery = await readDelivery(notification.id);
        if (["acknowledged", "ambiguous"].includes(delivery?.result?.phase)) continue;
        notifications.push({...notification, delivery: delivery ? deliverState(delivery) : null});
        if (notifications.length === 50) break;
      }
      return {notifications, reconciliationRequired: deliveries.filter((job) => job.result?.phase === "ambiguous").length};
    },
    async beginDelivery(id, body = {}) {
      return serial(deliveryId(id), async () => {
        let job = await readDelivery(id);
        if (!job) {
          const notification = await readCurrentNotification(id);
          const botIdentity = text(body.botIdentity);
          if (!["appa", "noona"].includes(botIdentity)) throw fail(400, "A delivery bot identity is required.");
          job = await save(deliveryId(id), DELIVERY_KIND, {
            notificationId: id, runId: notification.runId, batchId: notification.batchId,
            approvalId: notification.approvalId, status: notification.status,
            ownerDiscordUserId: notification.discordUserId, botIdentity, notification
          }, {phase: "sending", nonce: hash(id).slice(0, 24), sendStartedAt: new Date(clock()).toISOString()});
        }
        let stale = false;
        if (job.result.phase === "sending") {
          try { await readCurrentNotification(id); } catch (error) { if (error.status === 409) stale = true; else throw error; }
        }
        if (job.result.phase === "sending" && (stale || job.payload.botIdentity !== body.botIdentity || !Number.isFinite(Date.parse(job.result.sendStartedAt)) || clock() - Date.parse(job.result.sendStartedAt) >= AMBIGUOUS_RETRY_MS)) {
          job = await save(job.jobId, DELIVERY_KIND, job.payload, {...job.result, phase: "ambiguous", reason: "Delivery outcome needs reconciliation; automatic resend is disabled."}, job);
        }
        return {ok: true, delivery: deliverState(job)};
      });
    },
    async recordDelivery(id, body = {}) {
      return serial(deliveryId(id), async () => {
        const job = await requireDelivery(id);
        const messageId = text(body.messageId), channelId = text(body.channelId);
        if (!messageId || !channelId) throw fail(400, "The accepted Discord message and channel ids are required.");
        if (job.result.messageId && (job.result.messageId !== messageId || job.result.channelId !== channelId)) throw fail(409, "This notification already has a different Discord message.");
        const saved = await save(job.jobId, DELIVERY_KIND, job.payload, {...job.result, phase: job.result.phase === "acknowledged" ? "acknowledged" : "sent", messageId, channelId}, job);
        return {ok: true, delivery: deliverState(saved)};
      });
    },
    async registerPrompt(id, body = {}) {
      return serial(deliveryId(id), async () => {
        const delivery = await requireDelivery(id);
        if (!delivery.result.messageId || delivery.result.messageId !== text(body.messageId)) throw fail(409, "Record the accepted Discord message before its approval prompt.");
        if (!delivery.payload.approvalId) throw fail(409, "This paused notification has no approval window; use the slash command.");
        const payload = {...delivery.payload, messageId: delivery.result.messageId, channelId: delivery.result.channelId};
        const promptJobId = promptId(payload.messageId);
        const existing = await vaultClient.getJob(promptJobId);
        if (existing && ["notificationId", "runId", "batchId", "approvalId", "status", "ownerDiscordUserId", "botIdentity", "messageId", "channelId"]
          .some((key) => existing.payload[key] !== payload[key])) throw fail(409, "This Discord message already identifies a different approval prompt.");
        const prompt = existing || await save(promptJobId, PROMPT_KIND, payload, {phase: "pending"});
        await save(delivery.jobId, DELIVERY_KIND, delivery.payload, {...delivery.result, promptReady: true}, delivery);
        return {ok: true, prompt: {status: prompt.result.phase, approvalId: payload.approvalId}};
      });
    },
    async acknowledge(id) {
      return serial(deliveryId(id), async () => {
        const job = await requireDelivery(id);
        if (!job.result.messageId || (job.payload.status === "paused" && job.payload.approvalId && !job.result.promptReady)) throw fail(409, "The Discord delivery and approval prompt must be recorded before acknowledgement.");
        await save(job.jobId, DELIVERY_KIND, job.payload, {...job.result, phase: "acknowledged"}, job);
        return {ok: true, notificationId: id};
      });
    },
    async actOnRun(runId, action, body = {}) {
      const error = downloadAllRequestIdError(body.requestId);
      if (error) throw fail(400, error);
      const requestId = text(body.requestId) || `portal:legacy:${randomUUID()}`;
      return serial(actionId(requestId), async () => {
        let claim = await vaultClient.getJob(actionId(requestId));
        const identity = {runId, action, requestedBy: text(body.requestedBy) || "scriptarr-portal", requestId};
        if (claim && Object.entries(identity).some(([key, value]) => claim.payload[key] !== value)) throw fail(409, "This requestId already identifies a different downloadall action.");
        if (!claim) {
          const status = checked(await callRaven(runId, ""));
          const approvalId = text(status?.approvalId);
          if (!approvalId) throw fail(409, "This run has no current approval token.");
          claim = await save(actionId(requestId), ACTION_KIND, {...identity, approvalId}, {phase: "claimed"});
        }
        if (claim.result.response) return claim.result.response;
        const response = await callRaven(runId, action, {requestedBy: identity.requestedBy, requestId, approvalId: claim.payload.approvalId});
        if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) await save(claim.jobId, ACTION_KIND, claim.payload, {phase: "handled", response}, claim);
        return response;
      });
    },
    async decide(body = {}) {
      const messageId = text(body.messageId), userId = text(body.userId);
      const action = body.emoji === "✅" ? "continue" : body.emoji === "❌" ? "cancel" : "";
      if (!messageId || !action) throw fail(400, "A message and supported decision reaction are required.");
      return serial(promptId(messageId), async () => {
        let prompt = await vaultClient.getJob(promptId(messageId));
        if (!prompt) throw fail(404, "Downloadall decision prompt not found.");
        if (prompt.payload.ownerDiscordUserId !== userId) throw fail(403, "Only the configured owner can decide this prompt.");
        if (prompt.result.action && prompt.result.action !== action) throw fail(409, "This approval window already has a different decision.");
        if (prompt.result.response) return prompt.result.response;
        const createdAt = Date.parse(prompt.createdAt);
        if (!prompt.result.action && (!Number.isFinite(createdAt) || clock() - createdAt >= PROMPT_TTL_MS)) throw fail(409, "This approval prompt expired; use the slash command.");
        const requestId = text(prompt.result.requestId) || `discord:decision:${hash(`${messageId}:${prompt.payload.approvalId}`)}`;
        if (!prompt.result.action) prompt = await save(prompt.jobId, PROMPT_KIND, prompt.payload, {phase: "claimed", action, requestId}, prompt);
        const response = await callRaven(prompt.payload.runId, action, {requestedBy: userId, approvalId: prompt.payload.approvalId, requestId});
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500 && response.status !== 429) await save(prompt.jobId, PROMPT_KIND, prompt.payload, {...prompt.result, phase: "handled", response}, prompt);
          return response;
        }
        const result = {ok: true, status: 200, payload: {ok: true, status: action, runId: prompt.payload.runId, payload: response.payload,
          message: action === "continue" ? "Continuing the approved downloadall batch window." : "Cancelled the remaining downloadall batches."}};
        await save(prompt.jobId, PROMPT_KIND, prompt.payload, {...prompt.result, phase: "handled", response: result}, prompt);
        return result;
      });
    }
  };
};

/** Register only Portal-authenticated downloadall delivery and decision routes.
 * @param {object} app Express application.
 * @param {{broker: object, wrap: Function}} options Scoped broker and service-auth wrapper.
 * @returns {void} No return value.
 */
export const registerDownloadAllNotificationRoutes = (app, {broker, wrap}) => {
  const route = (method, path, work) => app[method](path, wrap(async (req, res) => {
    try {
      const result = await work(req);
      if (typeof result?.status === "number" && "payload" in result) res.status(result.status).json(result.payload);
      else res.json(result);
    } catch (error) { res.status(error.status || 503).json({error: error.message || "Downloadall operation unavailable."}); }
  }));
  route("get", "/api/internal/portal/notifications/downloadall", () => broker.listNotifications());
  for (const [suffix, operation] of [["begin", "beginDelivery"], ["delivery", "recordDelivery"], ["prompt", "registerPrompt"], ["ack", "acknowledge"]]) {
    route("post", `/api/internal/portal/notifications/downloadall/:notificationId/${suffix}`, (req) => broker[operation](text(req.params.notificationId), req.body || {}));
  }
  route("post", "/api/internal/portal/downloads/bulk-runs/decision", (req) => broker.decide(req.body || {}));
};
