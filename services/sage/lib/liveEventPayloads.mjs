/**
 * @file Sanitized live/admin event payload helpers.
 */
import {eventSequence} from "./liveEventHub.mjs";

const SENSITIVE_METADATA_KEY = /(authorization|bearer|cookie|oauth|password|secret|session|token|query|path|url)/i;
const SENSITIVE_METADATA_VALUE = /(bearer\s+[a-z0-9._~+/=-]+|scr_[a-z0-9_]+|https?:\/\/|\/(?:app|data|mnt|downloads|storage)\b|token=|password=|secret=|session=)/i;
const MAX_METADATA_FIELDS = 24;

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const safeMetadataValue = (value) => {
  if (value == null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim();
  if (!normalized || SENSITIVE_METADATA_VALUE.test(normalized)) {
    return "";
  }
  return normalized.slice(0, 240);
};

/**
 * Remove internal-only and sensitive metadata from admin-live event payloads.
 *
 * @param {Record<string, unknown>} [metadata]
 * @returns {Record<string, string | number | boolean>}
 */
export const sanitizeLiveMetadata = (metadata = {}) => {
  const clean = {};
  for (const [key, value] of Object.entries(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {})) {
    if (Object.keys(clean).length >= MAX_METADATA_FIELDS || SENSITIVE_METADATA_KEY.test(key)) {
      continue;
    }
    const sanitized = safeMetadataValue(value);
    if (sanitized !== "") {
      clean[key] = sanitized;
    }
  }
  return clean;
};

/**
 * Build the sanitized admin event DTO used by WS, SSE, and history reads.
 *
 * @param {Record<string, unknown>} [event]
 * @returns {Record<string, unknown>}
 */
export const sanitizeAdminEvent = (event = {}) => ({
  sequence: eventSequence(event),
  eventId: normalizeString(event.eventId),
  domain: normalizeString(event.domain),
  eventType: normalizeString(event.eventType),
  severity: normalizeString(event.severity, "info"),
  actorType: normalizeString(event.actorType),
  actorId: normalizeString(event.actorId),
  actorLabel: normalizeString(event.actorLabel),
  targetType: normalizeString(event.targetType),
  targetId: normalizeString(event.targetId),
  message: normalizeString(event.message),
  metadata: sanitizeLiveMetadata(event.metadata),
  createdAt: normalizeString(event.createdAt)
});

export default {
  sanitizeAdminEvent,
  sanitizeLiveMetadata
};
