/**
 * @file Redacted reader telemetry aggregation for Moon admin diagnostics.
 */

const SLOW_READER_EVENT_TYPES = new Set([
  "session-fetch",
  "page-chunk-fetch",
  "image-stream-fetch",
  "image-decode",
  "page-probe",
  "page-cache-miss"
]);
const RETRY_READER_EVENT_TYPES = new Set(["image-retry", "image-auto-retry"]);
const SENSITIVE_LABEL_PATTERN = /https?:|[/?#\\]|token|secret|session|authorization|password|key/i;
const SENSITIVE_IDENTIFIER_PATTERN = /token|secret|session|authorization|password|key/i;

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

const normalizeInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeDuration = (value) => {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
};

const safeIdentifier = (value, limit = 180) => {
  const normalized = normalizeString(value);
  if (!normalized || normalized.length > limit || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    return "";
  }
  if (SENSITIVE_IDENTIFIER_PATTERN.test(normalized)) {
    return "";
  }
  return normalized;
};

const safeTelemetryType = (value) => normalizeString(value)
  .replace(/[^a-zA-Z0-9._:-]/g, "_")
  .slice(0, 80);

const safeLabel = (value, limit = 120) => {
  const normalized = normalizeString(value);
  if (!normalized || SENSITIVE_LABEL_PATTERN.test(normalized)) {
    return "";
  }
  return normalized.replace(/[^a-zA-Z0-9 ._:-]/g, "_").slice(0, limit);
};

const normalizeIso = (value) => {
  const normalized = normalizeString(value);
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
};

const percentile = (values, percentileRank) => {
  if (!values.length) {
    return 0;
  }
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1));
  return sorted[index];
};

const average = (values) => values.length
  ? Math.round(values.reduce((total, value) => total + value, 0) / values.length)
  : 0;

const summarizeDurations = (events) => {
  const values = events.map((event) => event.durationMs).filter((value) => value > 0);
  return {
    count: events.length,
    avgMs: average(values),
    p95Ms: percentile(values, 95),
    maxMs: values.length ? Math.max(...values) : 0
  };
};

const byCreatedAtDesc = (left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || "");

const typeLabel = (type) => ({
  "session-fetch": "Session fetch",
  "page-chunk-fetch": "Page chunk fetch",
  "image-stream-fetch": "Image stream fetch",
  "image-decode": "Image decode",
  "page-probe": "Page probe",
  "page-cache-miss": "Page cache miss",
  "caught-buffer": "Caught buffer wait",
  "image-auto-retry": "Automatic image retry",
  "image-retry": "Visible image retry"
})[type] || type.replace(/-/g, " ");

const normalizeReaderTelemetryEvent = (event = {}) => {
  const metadata = normalizeObject(event.metadata);
  const titleId = safeIdentifier(metadata.titleId, 120);
  const chapterId = safeIdentifier(metadata.chapterId, 120);
  const targetId = safeIdentifier(event.targetId, 180) || [titleId, chapterId].filter(Boolean).join(":");
  const type = safeTelemetryType(metadata.type);
  const retryCount = Math.max(0, normalizeInteger(metadata.retryCount, 0));
  const durationMs = normalizeDuration(metadata.durationMs || metadata.decodeMs || metadata.imageLoadMs);

  return {
    eventId: safeIdentifier(event.eventId, 80),
    sequence: Math.max(0, normalizeInteger(event.sequence, 0)),
    createdAt: normalizeIso(event.createdAt),
    severity: safeLabel(event.severity, 40) || "info",
    targetId,
    titleId,
    chapterId,
    type,
    typeLabel: typeLabel(type),
    pageIndex: normalizeInteger(metadata.pageIndex, -1),
    activeIndex: normalizeInteger(metadata.activeIndex, -1),
    pageCount: Math.max(0, normalizeInteger(metadata.pageCount, 0)),
    durationMs,
    retryCount,
    decodedAhead: Math.max(0, normalizeInteger(metadata.decodedAhead, 0)),
    decodedBehind: Math.max(0, normalizeInteger(metadata.decodedBehind, 0)),
    decodedTotal: Math.max(0, normalizeInteger(metadata.decodedTotal, 0)),
    queueDepth: Math.max(0, normalizeInteger(metadata.queueDepth, 0)),
    metadataRequestCount: Math.max(0, normalizeInteger(metadata.metadataRequestCount, 0)),
    warmRequestCount: Math.max(0, normalizeInteger(metadata.warmRequestCount, 0)),
    inFlightPageRequests: Math.max(0, normalizeInteger(metadata.inFlightPageRequests, 0)),
    reason: safeLabel(metadata.reason, 120),
    phase: safeLabel(metadata.phase, 80)
  };
};

const groupKeyFor = (event) => [
  event.targetId || "unknown",
  event.pageIndex >= 0 ? `page-${event.pageIndex}` : "chapter"
].join("|");

const emptyGroup = (event) => ({
  targetId: event.targetId,
  titleId: event.titleId,
  chapterId: event.chapterId,
  pageIndex: event.pageIndex,
  count: 0,
  retryAttempts: 0,
  maxDurationMs: 0,
  p95DurationMs: 0,
  avgDurationMs: 0,
  decodedAheadMin: event.decodedAhead,
  queueDepthMax: event.queueDepth,
  eventTypes: new Set(),
  reasons: new Set(),
  lastAt: event.createdAt
});

const toGroupSummary = (group, events) => {
  const durations = events.map((event) => event.durationMs).filter((value) => value > 0);
  return {
    targetId: group.targetId,
    titleId: group.titleId,
    chapterId: group.chapterId,
    pageIndex: group.pageIndex,
    count: group.count,
    retryAttempts: group.retryAttempts,
    avgDurationMs: average(durations),
    p95DurationMs: percentile(durations, 95),
    maxDurationMs: durations.length ? Math.max(...durations) : 0,
    decodedAheadMin: group.decodedAheadMin,
    queueDepthMax: group.queueDepthMax,
    eventTypes: Array.from(group.eventTypes).sort(),
    reasons: Array.from(group.reasons).sort().slice(0, 4),
    lastAt: group.lastAt
  };
};

const groupReaderEvents = (events, limit = 8) => {
  const grouped = new Map();
  const groupedEvents = new Map();
  for (const event of events) {
    const key = groupKeyFor(event);
    if (!grouped.has(key)) {
      grouped.set(key, emptyGroup(event));
      groupedEvents.set(key, []);
    }
    const group = grouped.get(key);
    const currentEvents = groupedEvents.get(key);
    currentEvents.push(event);
    group.count += 1;
    group.retryAttempts += RETRY_READER_EVENT_TYPES.has(event.type)
      ? Math.max(1, event.retryCount || 0)
      : event.retryCount;
    group.maxDurationMs = Math.max(group.maxDurationMs, event.durationMs);
    group.decodedAheadMin = Math.min(group.decodedAheadMin, event.decodedAhead);
    group.queueDepthMax = Math.max(group.queueDepthMax, event.queueDepth);
    if (event.type) {
      group.eventTypes.add(event.type);
    }
    if (event.reason) {
      group.reasons.add(event.reason);
    }
    if (!group.lastAt || Date.parse(event.createdAt || "") > Date.parse(group.lastAt || "")) {
      group.lastAt = event.createdAt;
    }
  }
  return Array.from(grouped.entries())
    .map(([key, group]) => toGroupSummary(group, groupedEvents.get(key) || []))
    .sort((left, right) =>
      (right.retryAttempts + right.count + right.maxDurationMs) - (left.retryAttempts + left.count + left.maxDurationMs)
    )
    .slice(0, limit);
};

const groupByType = (events) => {
  const grouped = new Map();
  for (const event of events) {
    const key = event.type || "unknown";
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(event);
  }
  return Array.from(grouped.entries())
    .map(([type, typeEvents]) => ({
      type,
      label: typeLabel(type),
      ...summarizeDurations(typeEvents)
    }))
    .sort((left, right) => right.count - left.count || right.maxMs - left.maxMs);
};

const recommendation = (id, severity, title, action) => ({id, severity, title, action});

const buildRecommendations = ({caughtBufferEvents, slowEvents, retryEvents, retrySpikes}) => {
  const recommendations = [];
  if (caughtBufferEvents.length) {
    recommendations.push(recommendation(
      "caught-buffer",
      "warning",
      "Caught-buffer waits",
      "Inspect the top target's decoded-ahead and queue-depth values before changing preload distance."
    ));
  }
  if (slowEvents.some((event) => event.type === "page-chunk-fetch" || event.type === "session-fetch")) {
    recommendations.push(recommendation(
      "slow-metadata",
      "warning",
      "Slow reader metadata",
      "Compare Moon route time with Sage/Raven page-chunk time for the listed target and page."
    ));
  }
  if (slowEvents.some((event) => event.type === "image-stream-fetch" || event.type === "image-decode")) {
    recommendations.push(recommendation(
      "slow-image",
      "warning",
      "Slow image load or decode",
      "Check the listed page's cache/probe result and image dimensions before widening preload behavior."
    ));
  }
  if (retrySpikes.length || retryEvents.length >= 3) {
    recommendations.push(recommendation(
      "retry-spike",
      "warning",
      "Retry spike",
      "Inspect the top target/page for transient stream failures or damaged source-image quality state."
    ));
  }
  if (!recommendations.length) {
    recommendations.push(recommendation(
      "quiet",
      "info",
      "No reader hotspots",
      "No persisted caught-buffer, slow, or retry clusters were found in this window."
    ));
  }
  return recommendations;
};

/**
 * Build a browser-safe reader telemetry report from redacted durable events.
 *
 * @param {Array<Record<string, unknown>>} events durable Vault events.
 * @param {{since?: string, until?: string, limit?: number, generatedAt?: string}} [options]
 * @returns {Record<string, unknown>}
 */
export const buildReaderTelemetryReport = (events = [], options = {}) => {
  const normalizedEvents = (Array.isArray(events) ? events : [])
    .filter((event) => normalizeString(event?.eventType) === "reader-performance-slow")
    .map(normalizeReaderTelemetryEvent)
    .filter((event) => event.type)
    .sort(byCreatedAtDesc);
  const caughtBufferEvents = normalizedEvents.filter((event) => event.type === "caught-buffer");
  const slowEvents = normalizedEvents.filter((event) => SLOW_READER_EVENT_TYPES.has(event.type));
  const retryEvents = normalizedEvents.filter((event) => RETRY_READER_EVENT_TYPES.has(event.type) || event.retryCount > 0);
  const retryTopTargets = groupReaderEvents(retryEvents, 8);
  const retrySpikes = retryTopTargets.filter((group) => group.retryAttempts >= 3 || group.count >= 3);

  return {
    generatedAt: normalizeIso(options.generatedAt) || new Date().toISOString(),
    source: "vault-reader-events",
    window: {
      since: normalizeIso(options.since),
      until: normalizeIso(options.until),
      limit: Math.max(1, normalizeInteger(options.limit, 500)),
      eventCount: normalizedEvents.length
    },
    summary: {
      eventCount: normalizedEvents.length,
      caughtBufferWaits: caughtBufferEvents.length,
      slowEvents: slowEvents.length,
      retryEvents: retryEvents.length,
      retryAttempts: retryEvents.reduce((total, event) => total + Math.max(1, event.retryCount || 0), 0),
      problemTargets: new Set(normalizedEvents.map((event) => event.targetId).filter(Boolean)).size
    },
    caughtBuffer: {
      ...summarizeDurations(caughtBufferEvents),
      topTargets: groupReaderEvents(caughtBufferEvents, 8)
    },
    slowEvents: {
      ...summarizeDurations(slowEvents),
      byType: groupByType(slowEvents),
      topTargets: groupReaderEvents(slowEvents, 8)
    },
    retries: {
      events: retryEvents.length,
      attempts: retryEvents.reduce((total, event) => total + Math.max(1, event.retryCount || 0), 0),
      spikeThreshold: {events: 3, attempts: 3},
      spikes: retrySpikes,
      topTargets: retryTopTargets
    },
    recent: normalizedEvents.slice(0, 12),
    recommendations: buildRecommendations({caughtBufferEvents, slowEvents, retryEvents, retrySpikes})
  };
};

export default {
  buildReaderTelemetryReport
};
