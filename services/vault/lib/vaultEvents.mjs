import {randomUUID} from "node:crypto";

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const cloneJsonValue = (value, fallback = null) => {
  if (value == null) {
    return fallback;
  }
  return JSON.parse(JSON.stringify(value));
};

const normalizeScalarString = (value, fallback = "") => {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || fallback;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized || fallback;
  }
  return fallback;
};

const normalizeStringList = (value) => (Array.isArray(value) ? value : value ? [value] : [])
  .map((entry) => normalizeScalarString(entry))
  .filter(Boolean);

export const DEFAULT_EVENT_RETENTION_DAYS = 180;

/**
 * Normalize a durable Vault event payload into the canonical event shape.
 *
 * @param {Record<string, unknown>} [value]
 * @param {() => string} [nowIso]
 * @returns {{
 *   sequence?: number,
 *   eventId: string,
 *   domain: string,
 *   eventType: string,
 *   severity: string,
 *   actorType: string,
 *   actorId: string,
 *   actorLabel: string,
 *   targetType: string,
 *   targetId: string,
 *   message: string,
 *   metadata: Record<string, unknown>,
 *   createdAt: string
 * }}
 */
export const normalizeVaultEvent = (value = {}, nowIso = () => new Date().toISOString()) => ({
  ...(Number.isFinite(Number(value.sequence)) ? {sequence: Number(value.sequence)} : {}),
  eventId: normalizeString(value.eventId, randomUUID()),
  domain: normalizeString(value.domain, "system"),
  eventType: normalizeString(value.eventType, "updated"),
  severity: normalizeString(value.severity, "info"),
  actorType: normalizeString(value.actorType, "system"),
  actorId: normalizeScalarString(value.actorId),
  actorLabel: normalizeString(value.actorLabel),
  targetType: normalizeString(value.targetType),
  targetId: normalizeScalarString(value.targetId),
  message: normalizeString(value.message, "Scriptarr recorded an event."),
  metadata: value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
    ? cloneJsonValue(value.metadata, {})
    : {},
  createdAt: normalizeString(value.createdAt, nowIso())
});

/**
 * Normalize event list filters.
 *
 * @param {Record<string, unknown>} [value]
 * @returns {{
 *   domains: string[],
 *   eventTypes: string[],
 *   severities: string[],
 *   actorType: string,
 *   actorId: string,
 *   targetType: string,
 *   targetId: string,
 *   query: string,
 *   since: string,
 *   until: string,
 *   afterSequence: number,
 *   limit: number,
 *   newestFirst: boolean
 * }}
 */
export const normalizeEventFilters = (value = {}) => ({
  domains: normalizeStringList(value.domains),
  eventTypes: normalizeStringList(value.eventTypes || value.eventType),
  severities: normalizeStringList(value.severities || value.severity),
  actorType: normalizeScalarString(value.actorType),
  actorId: normalizeScalarString(value.actorId),
  targetType: normalizeScalarString(value.targetType),
  targetId: normalizeScalarString(value.targetId),
  query: normalizeScalarString(value.query || value.q),
  since: normalizeScalarString(value.since),
  until: normalizeScalarString(value.until),
  afterSequence: Math.max(0, Number.parseInt(String(value.afterSequence || value.after || 0), 10) || 0),
  limit: Math.min(500, Math.max(1, Number.parseInt(String(value.limit || 100), 10) || 100)),
  newestFirst: value.newestFirst !== false
});

export default {
  DEFAULT_EVENT_RETENTION_DAYS,
  normalizeEventFilters,
  normalizeVaultEvent
};
