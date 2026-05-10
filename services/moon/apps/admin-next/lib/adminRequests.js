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
const requestConflictMessages = Object.freeze({
  REQUEST_REVISION_CONFLICT: "This request changed while you were reviewing it. Moon refreshed the inbox; review the latest snapshot before trying again.",
  REQUEST_WORK_KEY_CONFLICT: "That title is already queued or has an active request."
});

export const normalizeArray = (value) => Array.isArray(value) ? value : [];

export const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

/**
 * Build a stable download option key for saved and candidate Raven sources.
 *
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
export const requestDownloadKey = (entry = {}) =>
  `${normalizeString(entry.providerId, normalizeString(entry.provider))}:${normalizeString(entry.titleUrl, normalizeString(entry.providerSeriesId))}`;

/**
 * Build a stable request row key.
 *
 * @param {Record<string, unknown>} request
 * @returns {string}
 */
export const requestRowKey = (request = {}) => normalizeString(request.id);

/**
 * Keep a request drawer selection only while the request still exists.
 *
 * @param {Array<Record<string, unknown>>} requests
 * @param {string} selectedId
 * @returns {string}
 */
export const resolveExistingRequestSelection = (requests = [], selectedId = "") => {
  const normalizedSelectedId = normalizeString(selectedId);
  if (!normalizedSelectedId) {
    return "";
  }
  return normalizeArray(requests).some((request) => requestRowKey(request) === normalizedSelectedId) ? normalizedSelectedId : "";
};

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
 * Resolve whether a download candidate can be queued by Raven.
 *
 * @param {Record<string, unknown>} entry
 * @returns {boolean}
 */
export const hasConcreteDownloadOption = (entry = {}) =>
  Boolean(normalizeString(entry.titleUrl));

/**
 * Select a single concrete source candidate while preserving an existing
 * selection when it is still present in the result set.
 *
 * @param {Array<Record<string, unknown>>} options
 * @param {Record<string, unknown> | null} [currentDownload]
 * @returns {Record<string, unknown> | null}
 */
export const selectSingleDownloadOption = (options = [], currentDownload = null) => {
  const concreteOptions = normalizeArray(options).filter(hasConcreteDownloadOption);
  const currentKey = requestDownloadKey(currentDownload || {});
  if (currentKey && concreteOptions.some((entry) => requestDownloadKey(entry) === currentKey)) {
    return currentDownload;
  }
  return concreteOptions.length === 1 ? concreteOptions[0] : null;
};

/**
 * Build a request view that reflects the moderator's local resolver draft.
 *
 * @param {Record<string, unknown>} request
 * @param {{selectedMetadata?: Record<string, unknown> | null, selectedDownload?: Record<string, unknown> | null}} [draft]
 * @returns {Record<string, unknown>}
 */
export const withEffectiveRequestSelection = (request = {}, draft = {}) => {
  const details = isObject(request.details) ? request.details : {};
  const selectedMetadata = isObject(draft.selectedMetadata) ? draft.selectedMetadata : details.selectedMetadata;
  const selectedDownload = isObject(draft.selectedDownload) ? draft.selectedDownload : details.selectedDownload;
  return {
    ...request,
    details: {
      ...details,
      selectedMetadata: isObject(selectedMetadata) ? selectedMetadata : null,
      selectedDownload: isObject(selectedDownload) ? selectedDownload : null
    }
  };
};

/**
 * Resolve request action eligibility for the current selection.
 *
 * @param {Record<string, unknown>} request
 * @param {{canWrite?: boolean, canRoot?: boolean}} grants
 * @returns {Record<string, boolean>}
 */
export const requestActionState = (request = {}, {canWrite = false, canRoot = false, selectedMetadata = null, selectedDownload = null} = {}) => {
  const effectiveRequest = withEffectiveRequestSelection(request, {selectedMetadata, selectedDownload});
  const status = normalizeString(effectiveRequest.status).toLowerCase();
  return {
    canRefreshSources: canWrite && Boolean(effectiveRequest.details?.selectedMetadata?.provider),
    canApprove: canWrite && hasConcreteDownload(effectiveRequest) && ["pending", "failed"].includes(status),
    canResolve: canWrite && ["unavailable", "failed"].includes(status),
    canDeny: canWrite && !["completed", "denied", "cancelled", "expired", "blocked"].includes(status),
    canOverride: canRoot
  };
};

/**
 * Build the next moderator action label for the selected request draft.
 *
 * @param {Record<string, unknown>} request
 * @param {Record<string, boolean>} actions
 * @returns {string}
 */
export const requestNextActionLabel = (request = {}, actions = {}) => {
  const status = normalizeString(request.status).toLowerCase();
  if (actions.canApprove) {
    return "Ready to approve and queue";
  }
  if (actions.canResolve && !hasConcreteDownload(request)) {
    return "Pick a source to resolve";
  }
  if (actions.canResolve) {
    return "Ready to resolve and queue";
  }
  if (status === "completed") {
    return "Completed";
  }
  if (closedStatuses.has(status)) {
    return "Closed";
  }
  if (actions.canRefreshSources) {
    return "Refresh sources or choose a match";
  }
  return "Review saved metadata";
};

/**
 * Format request action failures into stable, operator-friendly messages.
 *
 * @param {string} label
 * @param {{status?: number, payload?: Record<string, unknown> | null}} result
 * @returns {string}
 */
export const requestActionMessage = (label, result = {}) => {
  const payload = isObject(result.payload) ? result.payload : {};
  const code = normalizeString(payload.code);
  if (code && requestConflictMessages[code]) {
    if (code === "REQUEST_WORK_KEY_CONFLICT" && normalizeString(payload.requestId)) {
      return `${requestConflictMessages[code]} Matching request: ${payload.requestId}.`;
    }
    return requestConflictMessages[code];
  }
  return normalizeString(payload.error, `Moon could not ${normalizeString(label, "finish").toLowerCase()}.`);
};

/**
 * Select requests eligible for bulk source refresh.
 *
 * @param {Array<Record<string, unknown>>} requests
 * @param {{canWrite?: boolean}} grants
 * @returns {Array<Record<string, unknown>>}
 */
export const bulkRefreshCandidates = (requests = [], {canWrite = false} = {}) =>
  normalizeArray(requests).filter((request) => {
    const status = normalizeString(request.status).toLowerCase();
    return !["completed", ...closedStatuses].includes(status)
      && requestActionState(request, {canWrite}).canRefreshSources;
  });

/**
 * Select requests eligible for bulk denial.
 *
 * @param {Array<Record<string, unknown>>} requests
 * @param {{canWrite?: boolean}} grants
 * @returns {Array<Record<string, unknown>>}
 */
export const bulkDenyCandidates = (requests = [], {canWrite = false} = {}) =>
  normalizeArray(requests).filter((request) => requestActionState(request, {canWrite}).canDeny);

export default {
  bulkDenyCandidates,
  bulkRefreshCandidates,
  buildRequestCounts,
  filterRequests,
  hasConcreteDownload,
  hasConcreteDownloadOption,
  requestActionState,
  requestActionMessage,
  requestCoverUrl,
  requestDownloadKey,
  requestMatchesTab,
  requestNeedsReview,
  requestNextActionLabel,
  requestRowKey,
  resolveExistingRequestSelection,
  selectSingleDownloadOption,
  requestTabs
};
