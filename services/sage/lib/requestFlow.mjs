/**
 * Shared request-flow helpers for Moon and Portal request orchestration.
 */

const ACTIVE_REQUEST_STATUSES = new Set(["pending", "unavailable", "queued", "downloading", "failed"]);
const CLOSED_REQUEST_STATUSES = new Set(["denied", "blocked", "expired", "cancelled"]);
const NOTE_EDITABLE_STATUSES = new Set(["pending", "unavailable"]);
const CANCELLABLE_REQUEST_STATUSES = new Set(["pending", "unavailable", "failed"]);
const HIGH_CONFIDENCE_BANDS = new Set(["high", "exact"]);

/**
 * Normalize a trimmed string value.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Normalize a scalar into a string.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export const normalizeScalarString = (value, fallback = "") => {
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

/**
 * Normalize an array-like payload.
 *
 * @param {unknown} value
 * @returns {Array<unknown>}
 */
export const normalizeArray = (value) => Array.isArray(value) ? value : [];

/**
 * Normalize an object-like payload.
 *
 * @param {unknown} value
 * @param {Record<string, unknown> | null} [fallback]
 * @returns {Record<string, unknown> | null}
 */
export const normalizeObject = (value, fallback = null) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : fallback;

/**
 * Normalize a list of warning strings.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export const normalizeWarningList = (value) => normalizeArray(value)
  .map((entry) => normalizeString(entry))
  .filter(Boolean);

/**
 * Normalize the confidence band attached to a concrete download option.
 *
 * @param {unknown} value
 * @returns {"high" | "medium" | "low"}
 */
export const normalizeConfidenceBand = (value) => {
  const normalized = normalizeString(value, "low").toLowerCase();
  if (normalized === "exact") {
    return "high";
  }
  if (["high", "medium", "low"].includes(normalized)) {
    return normalized;
  }
  return "low";
};

/**
 * Normalize a library type slug.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export const normalizeTypeSlug = (value, fallback = "manga") => {
  const normalized = normalizeString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

/**
 * Normalize a Raven download-option payload into the fields Sage relies on for
 * moderation and auto-approval.
 *
 * @param {Record<string, unknown>} [entry]
 * @returns {Record<string, unknown>}
 */
export const normalizeDownloadOption = (entry = {}) => {
  const normalized = normalizeObject(entry, {}) || {};
  return {
    ...normalized,
    providerId: normalizeString(normalized.providerId),
    providerName: normalizeString(normalized.providerName, normalizeString(normalized.providerId)),
    titleName: normalizeString(normalized.titleName || normalized.title, "Untitled"),
    titleUrl: normalizeString(normalized.titleUrl),
    requestType: normalizeString(normalized.requestType || normalized.type, "manga"),
    libraryTypeLabel: normalizeString(normalized.libraryTypeLabel || normalized.requestType || normalized.type, "Manga"),
    libraryTypeSlug: normalizeTypeSlug(normalized.libraryTypeSlug || normalized.requestType || normalized.type),
    coverUrl: normalizeString(normalized.coverUrl),
    matchScore: Number.parseInt(String(normalized.matchScore || 0), 10) || 0,
    confidenceBand: normalizeConfidenceBand(normalized.confidenceBand || normalized.confidence),
    warnings: normalizeWarningList(normalized.warnings),
    tags: normalizeArray(normalized.tags).map((tag) => normalizeString(tag)).filter(Boolean),
    sourceUrl: normalizeString(normalized.sourceUrl || normalized.titleUrl),
    metadataUrl: normalizeString(normalized.metadataUrl)
  };
};

/**
 * Determine whether a concrete download option is safe for automatic approval.
 *
 * @param {Record<string, unknown>} [entry]
 * @returns {boolean}
 */
export const isHighConfidenceDownloadOption = (entry = {}) => {
  const option = normalizeDownloadOption(entry);
  if (!option.titleUrl) {
    return false;
  }
  if (!HIGH_CONFIDENCE_BANDS.has(option.confidenceBand)) {
    return false;
  }
  return option.warnings.length === 0;
};

/**
 * Select the one concrete download option that is safe to auto-approve.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
export const selectAutoApproveDownload = (value) => {
  const options = normalizeArray(value).map((entry) => normalizeDownloadOption(entry)).filter((entry) => entry.titleUrl);
  if (!options.length) {
    return null;
  }
  const [top, runnerUp] = options;
  if (!isHighConfidenceDownloadOption(top)) {
    return null;
  }
  if (!runnerUp) {
    return top;
  }
  if (isHighConfidenceDownloadOption(runnerUp)) {
    return null;
  }
  const scoreGap = top.matchScore - runnerUp.matchScore;
  return scoreGap >= 15 ? top : null;
};

/**
 * Build a Moon title URL from public base URL and title identity.
 *
 * @param {string} publicBaseUrl
 * @param {Record<string, unknown>} [title]
 * @returns {string}
 */
export const buildMoonTitleUrl = (publicBaseUrl, title = {}) => {
  const baseUrl = normalizeString(publicBaseUrl).replace(/\/+$/g, "");
  const titleId = normalizeScalarString(title.id);
  if (!baseUrl || !titleId) {
    return "";
  }
  const typeSlug = normalizeTypeSlug(title.libraryTypeSlug || title.mediaType || title.requestType || "manga");
  return `${baseUrl}/title/${encodeURIComponent(typeSlug)}/${encodeURIComponent(titleId)}`;
};

/**
 * Normalize a request status value.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export const normalizeRequestStatus = (value, fallback = "pending") => {
  const normalized = normalizeString(value, fallback).toLowerCase();
  return normalized || fallback;
};

/**
 * Resolve the Moon request tab for a status.
 *
 * @param {unknown} value
 * @returns {"active" | "completed" | "closed"}
 */
export const resolveRequestTab = (value) => {
  const status = normalizeRequestStatus(value);
  if (status === "completed") {
    return "completed";
  }
  if (CLOSED_REQUEST_STATUSES.has(status)) {
    return "closed";
  }
  return "active";
};

/**
 * Determine whether a request still allows requester note edits.
 *
 * @param {Record<string, unknown>} [request]
 * @returns {boolean}
 */
export const canEditRequestNotes = (request = {}) =>
  NOTE_EDITABLE_STATUSES.has(normalizeRequestStatus(request.status));

/**
 * Determine whether a request still allows requester cancellation.
 *
 * @param {Record<string, unknown>} [request]
 * @returns {boolean}
 */
export const canCancelRequest = (request = {}) =>
  CANCELLABLE_REQUEST_STATUSES.has(normalizeRequestStatus(request.status));

/**
 * Normalize stored duplicate-waitlist entries.
 *
 * @param {unknown} value
 * @returns {Array<Record<string, string>>}
 */
export const normalizeWaitlistEntries = (value) => {
  const deduped = new Map();
  for (const entry of normalizeArray(value)) {
    const discordUserId = normalizeScalarString(entry?.discordUserId);
    if (!discordUserId) {
      continue;
    }
    deduped.set(discordUserId, {
      discordUserId,
      username: normalizeString(entry?.username, "Reader"),
      avatarUrl: normalizeString(entry?.avatarUrl),
      source: normalizeString(entry?.source, "moon"),
      attachedAt: normalizeString(entry?.attachedAt, new Date().toISOString())
    });
  }
  return Array.from(deduped.values());
};

/**
 * Attach a requester to a duplicate waitlist if they are not already present.
 *
 * @param {Record<string, unknown>} [request]
 * @param {Record<string, unknown>} [user]
 * @returns {{waitlist: Array<Record<string, string>>, added: boolean}}
 */
export const attachRequestWaitlistEntry = (request = {}, user = {}) => {
  const currentWaitlist = normalizeWaitlistEntries(request?.details?.waitlist);
  const discordUserId = normalizeScalarString(user.discordUserId || user.requestedBy);
  const requesterDiscordId = normalizeScalarString(request?.requestedBy);
  if (!discordUserId) {
    return {
      waitlist: currentWaitlist,
      added: false
    };
  }
  if (requesterDiscordId && requesterDiscordId === discordUserId) {
    return {
      waitlist: currentWaitlist,
      added: false
    };
  }

  const nextEntry = {
    discordUserId,
    username: normalizeString(user.username, "Reader"),
    avatarUrl: normalizeString(user.avatarUrl),
    source: normalizeString(user.source, "moon"),
    attachedAt: new Date().toISOString()
  };
  const exists = currentWaitlist.some((entry) => entry.discordUserId === discordUserId);
  if (exists) {
    return {
      waitlist: currentWaitlist,
      added: false
    };
  }

  return {
    waitlist: [...currentWaitlist, nextEntry],
    added: true
  };
};

/**
 * Create a Vault-ready request payload from intake metadata and download picks.
 *
 * @param {Record<string, unknown>} [body]
 * @param {string} [requestedBy]
 * @returns {Record<string, unknown>}
 */
export const createIntakeBackedRequestPayload = (body = {}, requestedBy) => {
  const selectedMetadata = normalizeObject(body.selectedMetadata);
  const selectedDownload = normalizeObject(body.selectedDownload);
  return {
    source: normalizeString(body.source, "discord"),
    title: normalizeString(body.title || selectedMetadata?.title, "Untitled request"),
    requestType: normalizeString(
      body.requestType || selectedDownload?.requestType || selectedMetadata?.type || "manga",
      "manga"
    ),
    notes: normalizeString(body.notes),
    requestedBy,
    status: selectedDownload?.titleUrl ? "pending" : "unavailable",
    details: {
      query: normalizeString(body.query),
      selectedMetadata,
      selectedDownload,
      availability: selectedDownload?.titleUrl ? "available" : "unavailable",
      sourceFoundOptions: normalizeArray(body.sourceFoundOptions)
    }
  };
};

/**
 * Build the duplicate-library response payload.
 *
 * @param {{matchingTitle?: Record<string, unknown>, publicBaseUrl?: string}} options
 * @returns {Record<string, unknown>}
 */
export const buildLibraryDuplicatePayload = ({matchingTitle, publicBaseUrl}) => ({
  error: "That title is already in the Scriptarr library.",
  code: "REQUEST_ALREADY_IN_LIBRARY",
  libraryTitle: matchingTitle ? {
    id: normalizeScalarString(matchingTitle.id),
    title: normalizeString(matchingTitle.title, "Untitled"),
    mediaType: normalizeString(matchingTitle.mediaType, "manga"),
    libraryTypeSlug: normalizeTypeSlug(matchingTitle.libraryTypeSlug || matchingTitle.mediaType),
    linkUrl: buildMoonTitleUrl(publicBaseUrl, matchingTitle)
  } : null
});

/**
 * Build the duplicate-active-request response payload.
 *
 * @param {{matchingRequest?: Record<string, unknown>, publicBaseUrl?: string}} options
 * @returns {Record<string, unknown>}
 */
export const buildActiveRequestDuplicatePayload = ({matchingRequest, publicBaseUrl}) => ({
  error: "That title is already queued or has an active request.",
  code: "REQUEST_ALREADY_QUEUED",
  requestId: normalizeScalarString(matchingRequest?.id),
  linkUrl: `${normalizeString(publicBaseUrl).replace(/\/+$/g, "")}/myrequests`,
  title: normalizeString(matchingRequest?.title)
});

/**
 * Determine whether a request status still participates in active duplicate locking.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export const isActiveRequestStatus = (value) => ACTIVE_REQUEST_STATUSES.has(normalizeRequestStatus(value));
