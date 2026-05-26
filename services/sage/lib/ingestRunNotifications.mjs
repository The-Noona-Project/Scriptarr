/**
 * @file Portal-facing notifications for durable Raven library ingest runs.
 */

export const INGEST_RUN_NOTIFICATION_ACK_KEY = "portal.ingestRunNotifications";

const MAX_ACKED_INGEST_NOTIFICATIONS = 1000;
const INGEST_RUN_OWNER_SERVICE = "scriptarr-raven";
const INGEST_RUN_KIND = "raven-library-ingest";
const INGEST_RUN_MILESTONES = Object.freeze([25, 50, 75]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);
const PLACEHOLDER_REQUESTERS = new Set([
  "scriptarr-admin",
  "scriptarr-portal",
  "scriptarr-raven",
  "scriptarr-sage",
  "scriptarr-system"
]);

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};
const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
const toCount = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
};
const nowIso = () => new Date().toISOString();

const normalizeLibraryTypeLabel = (value, fallback = "Library") =>
  normalizeString(value, fallback)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const normalizeAckedIds = (value) =>
  normalizeArray(value)
    .map((entry) => normalizeString(entry))
    .filter(Boolean)
    .slice(-MAX_ACKED_INGEST_NOTIFICATIONS);

const resolveRequesterDiscordId = (job = {}, fallbackDiscordUserId = "") => {
  const requestedBy = normalizeString(job.requestedBy);
  if (requestedBy && !PLACEHOLDER_REQUESTERS.has(requestedBy.toLowerCase())) {
    return requestedBy;
  }
  return normalizeString(fallbackDiscordUserId);
};

/**
 * Normalize the Vault setting that stores already-delivered ingest run
 * notification ids.
 *
 * @param {unknown} value
 * @returns {{ackedIds: string[], updatedAt: string}}
 */
export const normalizeIngestRunNotificationState = (value = {}) => {
  const source = normalizeObject(value, {}) || {};
  const legacyArray = normalizeArray(value);
  return {
    ackedIds: normalizeAckedIds(legacyArray.length ? legacyArray : source.ackedIds),
    updatedAt: normalizeString(source.updatedAt)
  };
};

/**
 * Add one delivered ingest notification id to the bounded ack store.
 *
 * @param {unknown} value
 * @param {string} notificationId
 * @param {string} [acknowledgedAt]
 * @returns {{ackedIds: string[], updatedAt: string}}
 */
export const mergeIngestRunNotificationAck = (value = {}, notificationId, acknowledgedAt = nowIso()) => {
  const state = normalizeIngestRunNotificationState(value);
  const normalizedId = normalizeString(notificationId);
  const ackedIds = normalizedId
    ? [...new Set([...state.ackedIds, normalizedId])].slice(-MAX_ACKED_INGEST_NOTIFICATIONS)
    : state.ackedIds;
  return {
    ackedIds,
    updatedAt: normalizeString(acknowledgedAt, nowIso())
  };
};

const resolveIngestRunCounts = (job = {}) => {
  const result = normalizeObject(job.result, {}) || {};
  const payload = normalizeObject(job.payload, {}) || {};
  const totalTitles = toCount(result.totalTitles ?? payload.titleCount ?? job.titleCount, 0);
  const completedTitles = toCount(result.completedTitles ?? result.completed ?? job.completedTitles, 0);
  const failedTitles = toCount(result.failedTitles ?? result.failed ?? job.failedTitles, 0);
  const finishedTitles = Math.min(totalTitles || completedTitles + failedTitles, completedTitles + failedTitles);
  const remainingTitles = toCount(result.remainingTitles ?? job.remainingTitles, Math.max(0, totalTitles - finishedTitles));
  const percent = totalTitles > 0
    ? Math.min(100, Math.floor((finishedTitles / totalTitles) * 100))
    : TERMINAL_STATUSES.has(normalizeString(job.status).toLowerCase()) ? 100 : 0;
  return {
    totalTitles,
    completedTitles,
    failedTitles,
    finishedTitles,
    remainingTitles,
    percent
  };
};

const toNotificationBase = (job = {}, counts = {}, options = {}) => {
  const payload = normalizeObject(job.payload, {}) || {};
  const libraryTypeSlug = normalizeString(payload.libraryTypeSlug || payload.type || job.libraryTypeSlug, "library");
  const libraryTypeLabel = normalizeLibraryTypeLabel(payload.libraryTypeLabel || payload.typeLabel, libraryTypeSlug);
  const runId = normalizeString(job.jobId || job.runId || job.id);
  const status = normalizeString(job.status, "running").toLowerCase();
  const requestedBy = resolveRequesterDiscordId(job, options.fallbackDiscordUserId);
  return {
    runId,
    jobId: runId,
    requestedBy,
    discordUserId: requestedBy,
    status,
    libraryTypeSlug,
    libraryTypeLabel,
    totalTitles: counts.totalTitles,
    completedTitles: counts.completedTitles,
    failedTitles: counts.failedTitles,
    remainingTitles: counts.remainingTitles,
    percent: counts.percent,
    createdAt: normalizeString(job.createdAt),
    startedAt: normalizeString(job.startedAt),
    finishedAt: normalizeString(job.finishedAt),
    updatedAt: normalizeString(job.updatedAt),
    linkUrl: "/admin/activity/queue"
  };
};

const buildMilestoneNotification = (job, counts, milestone, options = {}) => {
  const base = toNotificationBase(job, counts, options);
  return {
    ...base,
    id: `ingest:${base.runId}:${milestone}`,
    milestone,
    terminal: false,
    message: `${base.libraryTypeLabel} ingest is ${milestone}% done.`
  };
};

const buildTerminalNotification = (job, counts, options = {}) => {
  const base = toNotificationBase(job, counts, options);
  const failed = base.status === "failed" || counts.failedTitles > 0;
  return {
    ...base,
    id: `ingest:${base.runId}:terminal`,
    milestone: null,
    terminal: true,
    percent: 100,
    message: failed
      ? `${base.libraryTypeLabel} ingest finished with ${counts.failedTitles} failed title(s).`
      : `${base.libraryTypeLabel} ingest completed.`
  };
};

/**
 * Build pending Portal DM notifications from durable Raven ingest jobs.
 *
 * @param {{jobs?: unknown[], state?: unknown, fallbackDiscordUserId?: string}} options
 * @returns {Array<Record<string, unknown>>}
 */
export const buildIngestRunNotifications = ({jobs = [], state = {}, fallbackDiscordUserId = ""} = {}) => {
  const ackedIds = new Set(normalizeIngestRunNotificationState(state).ackedIds);
  const notifications = [];
  for (const job of normalizeArray(jobs)) {
    const normalizedJob = normalizeObject(job, {}) || {};
    const requestedBy = resolveRequesterDiscordId(normalizedJob, fallbackDiscordUserId);
    if (
      normalizeString(normalizedJob.ownerService) !== INGEST_RUN_OWNER_SERVICE
      || normalizeString(normalizedJob.kind) !== INGEST_RUN_KIND
      || !requestedBy
    ) {
      continue;
    }
    const runId = normalizeString(normalizedJob.jobId || normalizedJob.runId || normalizedJob.id);
    if (!runId) {
      continue;
    }

    const status = normalizeString(normalizedJob.status).toLowerCase();
    const counts = resolveIngestRunCounts(normalizedJob);
    const candidates = TERMINAL_STATUSES.has(status)
      ? [buildTerminalNotification(normalizedJob, counts, {fallbackDiscordUserId})]
      : INGEST_RUN_MILESTONES
        .filter((milestone) => counts.percent >= milestone)
        .map((milestone) => buildMilestoneNotification(normalizedJob, counts, milestone, {fallbackDiscordUserId}));

    notifications.push(...candidates.filter((notification) => !ackedIds.has(notification.id)));
  }

  return notifications
    .sort((left, right) => {
      const leftRun = normalizeString(left.runId);
      const rightRun = normalizeString(right.runId);
      if (leftRun !== rightRun) {
        return normalizeString(left.createdAt || left.updatedAt).localeCompare(normalizeString(right.createdAt || right.updatedAt));
      }
      const leftMilestone = left.terminal ? 100 : toCount(left.milestone, 0);
      const rightMilestone = right.terminal ? 100 : toCount(right.milestone, 0);
      return leftMilestone - rightMilestone;
    })
    .slice(0, 50);
};

export default {
  INGEST_RUN_NOTIFICATION_ACK_KEY,
  buildIngestRunNotifications,
  mergeIngestRunNotificationAck,
  normalizeIngestRunNotificationState
};
