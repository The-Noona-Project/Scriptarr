/**
 * @file Build the live Moon admin queue payload from normalized Raven tasks.
 */

const STALE_THRESHOLD_MS = 30 * 60 * 1000;
const MIN_ACTIVE_ETA_PROGRESS = 1;
const MAX_ACTIVE_ETA_PROGRESS = 99;
const MIN_ACTIVE_ETA_ELAPSED_MS = 30 * 1000;
const MAX_ACTIVE_ETA_MS = 7 * 24 * 60 * 60 * 1000;

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const parseTimestamp = (value) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return 0;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizePriorityWeight = (value) => {
  const normalized = normalizeString(value).toLowerCase();
  return normalized === "high" ? 10 : normalized === "low" ? 90 : 50;
};

const toNumber = (value, fallback = 0) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isRavenTitleTask = (task = {}) => {
  const source = normalizeString(task.source).toLowerCase();
  const jobKind = normalizeString(task.jobKind || task.kind).toLowerCase();
  const taskKey = normalizeString(task.taskKey).toLowerCase();
  const requestType = normalizeString(task.requestType || task.libraryTypeLabel || task.libraryTypeSlug).toLowerCase();
  return Boolean(normalizeString(task.titleName))
    && requestType !== "job"
    && taskKey !== "bulk-batch"
    && jobKind !== "raven-bulk-downloadall"
    && source === "raven";
};

const normalizeTask = (task = {}) => ({
  ...task,
  downloadSpeedBytesPerSecond: Math.max(0, toNumber(
    task.downloadSpeedBytesPerSecond ?? task.details?.downloadSpeedBytesPerSecond,
    0
  )),
  startedAt: normalizeString(task.startedAt || task.details?.startedAt),
  sortOrder: toNumber(task.sortOrder ?? task.details?.sortOrder, Number.MAX_SAFE_INTEGER)
});

const sortRunningTasks = (tasks = []) => [...normalizeArray(tasks)].sort((left, right) => {
  const priorityDelta = normalizePriorityWeight(left.priority) - normalizePriorityWeight(right.priority);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const orderDelta = Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
  if (orderDelta !== 0) {
    return orderDelta;
  }

  const startedDelta = parseTimestamp(left.startedAt || left.queuedAt) - parseTimestamp(right.startedAt || right.queuedAt);
  if (startedDelta !== 0) {
    return startedDelta;
  }

  return normalizeString(left.taskId).localeCompare(normalizeString(right.taskId));
});

const sortQueuedTasks = (tasks = []) => [...normalizeArray(tasks)].sort((left, right) => {
  const priorityDelta = normalizePriorityWeight(left.priority) - normalizePriorityWeight(right.priority);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const orderDelta = Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
  if (orderDelta !== 0) {
    return orderDelta;
  }

  return parseTimestamp(left.queuedAt) - parseTimestamp(right.queuedAt);
});

const sortNewestFirst = (tasks = []) => [...normalizeArray(tasks)].sort((left, right) =>
  parseTimestamp(right.updatedAt || right.queuedAt) - parseTimestamp(left.updatedAt || left.queuedAt)
);

const isStaleActiveTask = (task) => {
  const status = normalizeString(task.status);
  if (!["queued", "running"].includes(status)) {
    return false;
  }
  return Date.now() - parseTimestamp(task.updatedAt || task.queuedAt) >= STALE_THRESHOLD_MS;
};

const isRetriableAttentionTask = (task) => {
  const status = normalizeString(task.status).toLowerCase();
  if (status === "failed") {
    return true;
  }
  return normalizeString(task.attentionReason) === "stale" && status === "queued";
};

const isIngestTask = (task = {}) =>
  normalizeString(task.providerId).toLowerCase() === "raven-ingest"
  || normalizeString(task.details?.kind).toLowerCase() === "library-ingest"
  || normalizeString(task.details?.recoveryAction).toLowerCase() === "retry-ingest";

const estimateActiveEtaMinutes = (task = {}) => {
  const now = Date.now();
  const progress = Math.max(0, Math.min(100, toNumber(task.percent, 0)));
  const startedAt = parseTimestamp(task.startedAt);
  if (
    progress < MIN_ACTIVE_ETA_PROGRESS
    || progress > MAX_ACTIVE_ETA_PROGRESS
    || !startedAt
    || startedAt > now
  ) {
    return null;
  }

  const elapsedMs = now - startedAt;
  if (elapsedMs < MIN_ACTIVE_ETA_ELAPSED_MS) {
    return null;
  }

  const estimatedTotalMs = elapsedMs / (progress / 100);
  const remainingMs = estimatedTotalMs - elapsedMs;
  if (!Number.isFinite(remainingMs) || remainingMs < 0 || remainingMs > MAX_ACTIVE_ETA_MS) {
    return null;
  }

  return Math.max(1, Math.ceil(remainingMs / 60000));
};

const addRunningEtas = (running = []) => normalizeArray(running).map((task) => ({
  ...task,
  etaMinutes: estimateActiveEtaMinutes(task)
}));

/**
 * Build Moon admin queue sections and stats.
 *
 * @param {Array<Record<string, any>>} tasks
 * @param {{concurrency?: number}} [options]
 * @returns {{
 *   stats: {
 *     runningCount: number,
 *     queuedCount: number,
 *     needsAttentionCount: number,
 *     activeSlots: number,
 *     totalSlots: number
 *   },
 *   running: Array<Record<string, any>>,
 *   queued: Array<Record<string, any>>,
 *   needsAttention: Array<Record<string, any>>
 * }}
 */
export const buildAdminQueuePayload = (tasks = [], {concurrency = 2} = {}) => {
  const normalizedTasks = normalizeArray(tasks).map((task) => normalizeTask(task)).filter(isRavenTitleTask);
  const running = addRunningEtas(sortRunningTasks(normalizedTasks.filter((task) => normalizeString(task.status) === "running")));
  const queued = sortQueuedTasks(normalizedTasks.filter((task) => normalizeString(task.status) === "queued"));
  const staleActiveTasks = normalizedTasks.filter((task) => isStaleActiveTask(task));
  const failedTasks = normalizedTasks.filter((task) => normalizeString(task.status) === "failed");
  const needsAttention = sortNewestFirst([
    ...failedTasks.map((task) => ({...task, attentionReason: "failed", retriable: true, removable: !isIngestTask(task)})),
    ...staleActiveTasks
      .filter((task) => !failedTasks.some((failedTask) => normalizeString(failedTask.taskId) === normalizeString(task.taskId)))
      .map((task) => ({
        ...task,
        attentionReason: "stale",
        retriable: normalizeString(task.status).toLowerCase() === "queued",
        removable: normalizeString(task.status).toLowerCase() === "queued"
      }))
  ]);
  const retryableAttentionCount = needsAttention.filter((task) => isRetriableAttentionTask(task)).length;

  return {
    stats: {
      runningCount: running.length,
      queuedCount: queued.length,
      needsAttentionCount: needsAttention.length,
      activeSlots: running.length,
      totalSlots: concurrency,
      retryableAttentionCount
    },
    running,
    queued,
    needsAttention
  };
};

export default {
  buildAdminQueuePayload
};
