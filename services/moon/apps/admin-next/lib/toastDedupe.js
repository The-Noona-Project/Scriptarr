/**
 * @file Toast dedupe helpers for Moon admin.
 */

export const EVENT_MESSAGE_DEDUPE_TTL_MS = 60000;
export const EVENT_ID_DEDUPE_TTL_MS = 10 * 60000;
const MAX_DEDUPE_ENTRIES = 400;

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeMessage = (value) => normalizeString(value)
  .replace(/\s+/g, " ")
  .toLowerCase();

const pruneMap = (entries, now, ttlMs) => {
  for (const [key, createdAt] of entries.entries()) {
    if (now - createdAt > ttlMs || entries.size > MAX_DEDUPE_ENTRIES) {
      entries.delete(key);
    }
  }
};

/**
 * Build empty toast dedupe state.
 *
 * @returns {{ids: Map<string, number>, fingerprints: Map<string, number>}}
 */
export const createToastDedupeState = () => ({
  ids: new Map(),
  fingerprints: new Map()
});

/**
 * Build a stable message fingerprint for noisy live-event toasts.
 *
 * @param {{category?: unknown, severity?: unknown, message?: unknown}} input
 * @returns {string}
 */
export const buildToastFingerprint = (input = {}) => [
  normalizeString(input.category, "action").toLowerCase(),
  normalizeString(input.severity, "info").toLowerCase(),
  normalizeMessage(input.message)
].join("|");

/**
 * Return true when a toast should be displayed and record its dedupe keys.
 *
 * @param {{ids: Map<string, number>, fingerprints: Map<string, number>}} state
 * @param {{id?: unknown, eventId?: unknown, category?: unknown, severity?: unknown, message?: unknown}} input
 * @param {{now?: number, eventIdTtlMs?: number, eventMessageTtlMs?: number}} [options]
 * @returns {boolean}
 */
export const shouldShowToast = (state, input = {}, options = {}) => {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const eventIdTtlMs = Number.isFinite(Number(options.eventIdTtlMs)) ? Number(options.eventIdTtlMs) : EVENT_ID_DEDUPE_TTL_MS;
  const eventMessageTtlMs = Number.isFinite(Number(options.eventMessageTtlMs)) ? Number(options.eventMessageTtlMs) : EVENT_MESSAGE_DEDUPE_TTL_MS;

  pruneMap(state.ids, now, eventIdTtlMs);
  pruneMap(state.fingerprints, now, eventMessageTtlMs);

  const dedupeKey = normalizeString(input.eventId || input.id);
  if (dedupeKey) {
    if (state.ids.has(dedupeKey)) {
      return false;
    }
    state.ids.set(dedupeKey, now);
  }

  if (normalizeString(input.category, "action").toLowerCase() === "event") {
    const fingerprint = buildToastFingerprint(input);
    if (fingerprint.endsWith("|")) {
      return true;
    }
    if (state.fingerprints.has(fingerprint)) {
      return false;
    }
    state.fingerprints.set(fingerprint, now);
  }

  return true;
};

