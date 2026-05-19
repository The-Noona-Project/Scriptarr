"use client";

/**
 * @file Lightweight browser-side telemetry for the dedicated Scriptarr reader.
 */

const BUFFER_MAX_EVENTS = 240;
const TELEMETRY_ENDPOINT = "/api/moon-v3/user/reader/telemetry";
const SLOW_THRESHOLDS_MS = Object.freeze({
  "session-fetch": 1200,
  "page-chunk-fetch": 900,
  "image-stream-fetch": 1500,
  "image-decode": 350,
  "page-probe": 900,
  "caught-buffer": 250
});

const now = () => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
};

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeNumber = (value, fallback = 0) => {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const boundedIdentifier = (value) => normalizeString(value)
  .replace(/[^a-zA-Z0-9._:-]/g, "_")
  .slice(0, 120);
const safeIdentifier = (value) => {
  const normalized = normalizeString(value);
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(normalized)) {
    return "";
  }
  if (/token|secret|session|authorization|password|key/i.test(normalized)) {
    return "";
  }
  return normalized;
};
const safeLabel = (value, limit = 120) => {
  const normalized = normalizeString(value);
  if (/https?:|[/?#\\]|token|secret|session|authorization|password/i.test(normalized)) {
    return "";
  }
  return normalized.replace(/[^a-zA-Z0-9 ._:-]/g, "_").slice(0, limit);
};

const telemetryBuffer = () => {
  if (typeof window === "undefined") {
    return null;
  }
  const existing = window.__scriptarrReaderTelemetry;
  if (existing && Array.isArray(existing.events)) {
    return existing;
  }
  const next = {
    events: [],
    maxEvents: BUFFER_MAX_EVENTS,
    clear() {
      this.events.splice(0, this.events.length);
    },
    snapshot() {
      return this.events.slice();
    }
  };
  window.__scriptarrReaderTelemetry = next;
  return next;
};

/**
 * Read a monotonic clock for reader timing spans.
 *
 * @returns {number}
 */
export const readerTelemetryNow = () => now();

/**
 * Count decoded pages ahead of and behind the active reader page.
 *
 * @param {Iterable<{chapterId?: string, pageIndex?: number, status?: string}>} warmStates
 * @param {{chapterId?: string, activeIndex?: number}} options
 * @returns {{decodedAhead: number, decodedBehind: number, decodedTotal: number}}
 */
export const countDecodedReaderPages = (warmStates, {chapterId = "", activeIndex = 0} = {}) => {
  const normalizedChapterId = normalizeString(chapterId);
  const active = normalizeInteger(activeIndex, 0);
  let decodedAhead = 0;
  let decodedBehind = 0;
  let decodedTotal = 0;
  for (const state of warmStates || []) {
    if (state?.status !== "ready" || normalizeString(state.chapterId) !== normalizedChapterId) {
      continue;
    }
    const pageIndex = normalizeInteger(state.pageIndex, -1);
    if (pageIndex < 0) {
      continue;
    }
    decodedTotal += 1;
    if (pageIndex > active) {
      decodedAhead += 1;
    } else if (pageIndex < active) {
      decodedBehind += 1;
    }
  }
  return {decodedAhead, decodedBehind, decodedTotal};
};

/**
 * Sanitize a reader telemetry event for local and durable capture.
 *
 * @param {Record<string, unknown>} event
 * @returns {Record<string, unknown>}
 */
export const sanitizeReaderTelemetryEvent = (event = {}) => ({
  type: boundedIdentifier(event.type || "reader-event"),
  at: new Date().toISOString(),
  titleId: safeIdentifier(event.titleId),
  chapterId: safeIdentifier(event.chapterId),
  pageIndex: normalizeInteger(event.pageIndex, -1),
  activeIndex: normalizeInteger(event.activeIndex, -1),
  pageCount: normalizeInteger(event.pageCount, 0),
  cursor: Math.max(0, normalizeInteger(event.cursor, 0)),
  pageSize: Math.max(0, normalizeInteger(event.pageSize, 0)),
  layoutMode: safeLabel(event.layoutMode, 80),
  direction: safeLabel(event.direction, 40),
  status: normalizeInteger(event.status, 0),
  ok: event.ok === true,
  durationMs: Math.max(0, Math.round(normalizeNumber(event.durationMs, 0))),
  decodeMs: Math.max(0, Math.round(normalizeNumber(event.decodeMs, 0))),
  imageLoadMs: Math.max(0, Math.round(normalizeNumber(event.imageLoadMs, 0))),
  queueDepth: Math.max(0, normalizeInteger(event.queueDepth, 0)),
  metadataRequestCount: Math.max(0, normalizeInteger(event.metadataRequestCount, 0)),
  warmRequestCount: Math.max(0, normalizeInteger(event.warmRequestCount, 0)),
  inFlightPageRequests: Math.max(0, normalizeInteger(event.inFlightPageRequests, 0)),
  retryCount: Math.max(0, normalizeInteger(event.retryCount, 0)),
  decodedAhead: Math.max(0, normalizeInteger(event.decodedAhead, 0)),
  decodedBehind: Math.max(0, normalizeInteger(event.decodedBehind, 0)),
  decodedTotal: Math.max(0, normalizeInteger(event.decodedTotal, 0)),
  reason: safeLabel(event.reason, 120),
  phase: safeLabel(event.phase, 80)
});

/**
 * Decide whether an event is important enough for durable admin visibility.
 *
 * @param {Record<string, unknown>} event
 * @returns {boolean}
 */
export const shouldPersistReaderTelemetryEvent = (event = {}) => {
  const type = normalizeString(event.type);
  if (type === "image-retry" || type === "image-auto-retry" || type === "caught-buffer") {
    return true;
  }
  if ((type === "page-probe" || type === "page-cache-miss") && event.ok === false) {
    return true;
  }
  if (normalizeInteger(event.retryCount, 0) > 0) {
    return true;
  }
  const threshold = SLOW_THRESHOLDS_MS[type];
  return Number.isFinite(threshold) && normalizeNumber(event.durationMs, 0) >= threshold;
};

const persistReaderTelemetryEvent = (event) => {
  if (typeof window === "undefined" || typeof fetch !== "function") {
    return;
  }
  const body = JSON.stringify(event);
  const fetchOptions = {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body,
    cache: "no-store",
    keepalive: body.length < 60_000
  };
  void fetch(TELEMETRY_ENDPOINT, fetchOptions).catch(() => null);
};

/**
 * Record one sanitized reader metric locally and optionally persist it.
 *
 * @param {Record<string, unknown>} event
 * @returns {Record<string, unknown>}
 */
export const recordReaderTelemetry = (event = {}) => {
  const sanitized = sanitizeReaderTelemetryEvent(event);
  const buffer = telemetryBuffer();
  if (buffer) {
    buffer.events.push(sanitized);
    while (buffer.events.length > (buffer.maxEvents || BUFFER_MAX_EVENTS)) {
      buffer.events.shift();
    }
  }
  if (shouldPersistReaderTelemetryEvent(sanitized)) {
    persistReaderTelemetryEvent(sanitized);
  }
  return sanitized;
};

export default {
  countDecodedReaderPages,
  readerTelemetryNow,
  recordReaderTelemetry,
  sanitizeReaderTelemetryEvent,
  shouldPersistReaderTelemetryEvent
};
