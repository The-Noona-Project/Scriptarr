/**
 * @file Shared event-domain authorization helpers for Sage live and history routes.
 */
import {hasDomainAccess} from "./auth.mjs";

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Map durable event domains to the admin grant domain that may read them.
 */
export const EVENT_DOMAIN_ACCESS = Object.freeze({
  auth: "users",
  users: "users",
  access: "users",
  overview: "overview",
  library: "library",
  add: "add",
  import: "import",
  calendar: "calendar",
  mediamanagement: "mediamanagement",
  activity: "activity",
  wanted: "wanted",
  requests: "requests",
  discord: "discord",
  ai: "ai",
  settings: "settings",
  database: "database",
  system: "system",
  publicapi: "publicapi",
  follow: "library",
  reader: "library"
});

const KNOWN_EVENT_DOMAINS = Object.freeze(Object.keys(EVENT_DOMAIN_ACCESS));

/**
 * Normalize one or more query/body domain values into a unique list.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export const normalizeRequestedEventDomains = (value) => {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return Array.from(new Set(values.map((entry) => normalizeString(entry)).filter(Boolean)));
};

/**
 * Check if a domain is part of the durable event contract.
 *
 * @param {string} domain
 * @returns {boolean}
 */
export const isKnownEventDomain = (domain) => Object.hasOwn(EVENT_DOMAIN_ACCESS, normalizeString(domain));

/**
 * Check whether a user can read one durable event domain.
 *
 * @param {Record<string, unknown>} user
 * @param {string} domain
 * @returns {boolean}
 */
export const canReadEventDomain = (user, domain) => {
  const normalizedDomain = normalizeString(domain);
  if (!isKnownEventDomain(normalizedDomain)) {
    return false;
  }
  return hasDomainAccess(user, EVENT_DOMAIN_ACCESS[normalizedDomain], "read");
};

/**
 * Resolve the exact event domains a user may read for a requested set.
 *
 * @param {Record<string, unknown>} user
 * @param {unknown} requestedDomains
 * @returns {string[] | null}
 */
export const resolveReadableEventDomains = (user, requestedDomains = []) => {
  const requested = normalizeRequestedEventDomains(requestedDomains);
  if (requested.length) {
    return requested.every((domain) => canReadEventDomain(user, domain)) ? requested : null;
  }
  const allowed = KNOWN_EVENT_DOMAINS.filter((domain) => canReadEventDomain(user, domain));
  return allowed.length ? allowed : null;
};

/**
 * Validate whether a user can read all explicitly requested event domains.
 *
 * @param {Record<string, unknown>} user
 * @param {unknown} requestedDomains
 * @returns {boolean}
 */
export const ensureEventReadAccess = (user, requestedDomains = []) =>
  resolveReadableEventDomains(user, requestedDomains) !== null;

export default {
  EVENT_DOMAIN_ACCESS,
  canReadEventDomain,
  ensureEventReadAccess,
  isKnownEventDomain,
  normalizeRequestedEventDomains,
  resolveReadableEventDomains
};
