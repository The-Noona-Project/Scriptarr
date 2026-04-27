/**
 * @file Admin request inbox helpers for Moon's Next admin app.
 */

export const requestTabs = Object.freeze([
  {id: "needsReview", label: "Needs review"},
  {id: "active", label: "Active"},
  {id: "failed", label: "Failed"},
  {id: "completed", label: "Completed"},
  {id: "closed", label: "Closed"},
  {id: "all", label: "All"}
]);

const closedStatuses = new Set(["denied", "blocked", "expired", "cancelled"]);

export const normalizeArray = (value) => Array.isArray(value) ? value : [];

export const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

/**
 * Resolve whether a request still needs moderator review.
 *
 * @param {Record<string, unknown>} request
 * @returns {boolean}
 */
export const requestNeedsReview = (request = {}) => {
  const status = normalizeString(request.status).toLowerCase();
  const selectedDownload = isObject(request.details?.selectedDownload) ? request.details.selectedDownload : null;
  return status === "unavailable" || (status === "pending" && !normalizeString(selectedDownload?.titleUrl));
};

/**
 * Build local request counts when Sage has not supplied them yet.
 *
 * @param {Array<Record<string, unknown>>} requests
 * @returns {Record<string, number>}
 */
export const buildRequestCounts = (requests = []) => {
  const rows = normalizeArray(requests);
  const counts = {
    total: rows.length,
    needsReview: 0,
    pending: 0,
    unavailable: 0,
    queued: 0,
    downloading: 0,
    failed: 0,
    active: 0,
    completed: 0,
    closed: 0,
    waitlisted: 0
  };
  for (const request of rows) {
    const status = normalizeString(request.status).toLowerCase();
    if (Object.hasOwn(counts, status)) {
      counts[status] += 1;
    }
    if (requestNeedsReview(request)) {
      counts.needsReview += 1;
    }
    if (closedStatuses.has(status) || request.tab === "closed") {
      counts.closed += 1;
    }
    if (requestMatchesTab(request, "active")) {
      counts.active += 1;
    }
    if (Number.parseInt(String(request.waitlistCount || 0), 10) > 0) {
      counts.waitlisted += 1;
    }
  }
  return counts;
};

/**
 * Test whether a request belongs in an admin inbox tab.
 *
 * @param {Record<string, unknown>} request
 * @param {string} tab
 * @returns {boolean}
 */
export const requestMatchesTab = (request = {}, tab = "needsReview") => {
  const status = normalizeString(request.status).toLowerCase();
  if (tab === "all") {
    return true;
  }
  if (tab === "needsReview") {
    return requestNeedsReview(request);
  }
  if (tab === "active") {
    return !["completed", "failed"].includes(status) && !closedStatuses.has(status);
  }
  if (tab === "failed") {
    return status === "failed";
  }
  if (tab === "completed") {
    return status === "completed";
  }
  if (tab === "closed") {
    return closedStatuses.has(status) || request.tab === "closed";
  }
  return true;
};

/**
 * Build searchable text for request inbox filtering.
 *
 * @param {Record<string, unknown>} request
 * @returns {string}
 */
export const requestSearchText = (request = {}) => {
  const details = isObject(request.details) ? request.details : {};
  const metadata = isObject(details.selectedMetadata) ? details.selectedMetadata : {};
  const download = isObject(details.selectedDownload) ? details.selectedDownload : {};
  const requester = isObject(request.requestedBy) ? request.requestedBy : {};
  return [
    request.title,
    request.status,
    request.requestType,
    request.source,
    request.notes,
    requester.username,
    requester.discordUserId,
    metadata.providerName,
    metadata.provider,
    metadata.title,
    download.providerName,
    download.providerId,
    download.titleName,
    download.titleUrl
  ].map((entry) => normalizeString(entry).toLowerCase()).filter(Boolean).join(" ");
};

/**
 * Filter request rows by tab and query.
 *
 * @param {Array<Record<string, unknown>>} requests
 * @param {{tab?: string, query?: string}} options
 * @returns {Array<Record<string, unknown>>}
 */
export const filterRequests = (requests = [], {tab = "needsReview", query = ""} = {}) => {
  const normalizedQuery = normalizeString(query).toLowerCase();
  return normalizeArray(requests)
    .filter((request) => requestMatchesTab(request, tab))
    .filter((request) => !normalizedQuery || requestSearchText(request).includes(normalizedQuery));
};

/**
 * Resolve the best available cover for a request.
 *
 * @param {Record<string, unknown>} request
 * @returns {string}
 */
export const requestCoverUrl = (request = {}) =>
  normalizeString(request.coverUrl)
  || normalizeString(request.details?.coverUrl)
  || normalizeString(request.details?.selectedDownload?.coverUrl)
  || normalizeString(request.details?.selectedMetadata?.coverUrl);

/**
 * Resolve whether a request currently has a concrete download source.
 *
 * @param {Record<string, unknown>} request
 * @returns {boolean}
 */
export const hasConcreteDownload = (request = {}) =>
  Boolean(normalizeString(request.details?.selectedDownload?.titleUrl));

/**
 * Resolve request action eligibility for the current selection.
 *
 * @param {Record<string, unknown>} request
 * @param {{canWrite?: boolean, canRoot?: boolean}} grants
 * @returns {Record<string, boolean>}
 */
export const requestActionState = (request = {}, {canWrite = false, canRoot = false} = {}) => {
  const status = normalizeString(request.status).toLowerCase();
  return {
    canRefreshSources: canWrite && Boolean(request.details?.selectedMetadata?.provider),
    canApprove: canWrite && hasConcreteDownload(request) && ["pending", "failed"].includes(status),
    canResolve: canWrite && ["unavailable", "failed"].includes(status),
    canDeny: canWrite && !["completed", "denied", "cancelled", "expired", "blocked"].includes(status),
    canOverride: canRoot
  };
};

export default {
  buildRequestCounts,
  filterRequests,
  hasConcreteDownload,
  requestActionState,
  requestCoverUrl,
  requestMatchesTab,
  requestNeedsReview,
  requestTabs
};
