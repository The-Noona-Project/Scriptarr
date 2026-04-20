/**
 * @file Shared request-selection guard helpers for Sage intake and queue
 * orchestration paths.
 */

const activeRequestStatuses = new Set(["pending", "unavailable", "queued", "downloading"]);
const activeTaskStatuses = new Set(["queued", "running"]);

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
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

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;

const normalizeTypeSlug = (value, fallback = "manga") => {
  const normalized = normalizeString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

const normalizeTitleMatchKey = (value) => normalizeString(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const metadataIdentity = (value = {}) => {
  const metadata = normalizeObject(value.selectedMetadata ?? value.metadata ?? value, {}) || {};
  return {
    provider: normalizeString(metadata.provider).toLowerCase(),
    providerSeriesId: normalizeScalarString(metadata.providerSeriesId)
  };
};

const hasMatchingMetadataIdentity = (left, right) => {
  const leftIdentity = metadataIdentity(left);
  const rightIdentity = metadataIdentity(right);
  return Boolean(
    leftIdentity.provider
    && leftIdentity.providerSeriesId
    && leftIdentity.provider === rightIdentity.provider
    && leftIdentity.providerSeriesId === rightIdentity.providerSeriesId
  );
};

/**
 * Normalize a metadata-first intake entry into the shared request-selection
 * shape used by Sage guard rails.
 *
 * @param {Record<string, unknown>} [entry={}]
 * @returns {{
 *   query: string,
 *   canonicalTitle: string,
 *   requestType: string,
 *   libraryTypeSlug: string,
 *   availability: string,
 *   coverUrl: string,
 *   selectedMetadata: Record<string, unknown>,
 *   selectedDownload: Record<string, unknown> | null
 * }}
 */
export const buildIntakeSelection = (entry = {}) => {
  const metadata = normalizeObject(entry.selectedMetadata ?? entry.metadata, {}) || {};
  const download = normalizeObject(entry.selectedDownload ?? entry.download);
  const requestType = normalizeString(
    entry.requestType || download?.requestType || metadata.type || entry.type || "manga",
    "manga"
  );
  const libraryTypeSlug = normalizeTypeSlug(
    entry.libraryTypeSlug || download?.libraryTypeSlug || metadata.typeSlug || requestType
  );
  const canonicalTitle = normalizeString(
    entry.canonicalTitle,
    download?.titleName || metadata.title || entry.title || "Untitled"
  );
  const availability = normalizeString(entry.availability, download?.titleUrl ? "available" : "unavailable");
  const coverUrl = normalizeString(entry.coverUrl, normalizeString(download?.coverUrl, normalizeString(metadata.coverUrl)));
  return {
    query: normalizeString(entry.query),
    canonicalTitle,
    requestType,
    libraryTypeSlug,
    availability,
    coverUrl,
    selectedMetadata: metadata,
    selectedDownload: download
  };
};

/**
 * Determine whether an intake selection already exists in the live Raven
 * library catalog.
 *
 * @param {ReturnType<typeof buildIntakeSelection>} selection
 * @param {Record<string, unknown>} [title={}]
 * @returns {boolean}
 */
export const matchesSelectionAgainstTitle = (selection, title = {}) => {
  const selectedDownload = normalizeObject(selection.selectedDownload);
  const sourceUrl = normalizeString(selectedDownload?.titleUrl);
  if (sourceUrl && sourceUrl === normalizeString(title.sourceUrl)) {
    return true;
  }

  return normalizeTitleMatchKey(selection.canonicalTitle) === normalizeTitleMatchKey(title.title)
    && normalizeTypeSlug(selection.libraryTypeSlug || selection.requestType) === normalizeTypeSlug(title.libraryTypeSlug || title.mediaType);
};

/**
 * Determine whether an intake selection matches an already-active moderated
 * request.
 *
 * @param {ReturnType<typeof buildIntakeSelection>} selection
 * @param {Record<string, unknown>} [request={}]
 * @param {{ignoreRequestId?: string}} [options={}]
 * @returns {boolean}
 */
export const matchesSelectionAgainstRequest = (selection, request = {}, options = {}) => {
  if (normalizeScalarString(options.ignoreRequestId) === normalizeScalarString(request.id)) {
    return false;
  }
  if (!activeRequestStatuses.has(normalizeString(request.status))) {
    return false;
  }

  const selectedDownload = normalizeObject(request.details?.selectedDownload);
  const selectionDownload = normalizeObject(selection.selectedDownload);
  const downloadUrl = normalizeString(selectionDownload?.titleUrl);
  if (downloadUrl && downloadUrl === normalizeString(selectedDownload?.titleUrl)) {
    return true;
  }
  if (hasMatchingMetadataIdentity(selection, request.details)) {
    return true;
  }

  return normalizeTitleMatchKey(selection.canonicalTitle) === normalizeTitleMatchKey(request.title)
    && normalizeTypeSlug(selection.libraryTypeSlug || selection.requestType) === normalizeTypeSlug(request.requestType);
};

/**
 * Determine whether an intake selection matches an already-active Raven task.
 *
 * @param {ReturnType<typeof buildIntakeSelection>} selection
 * @param {Record<string, unknown>} [task={}]
 * @returns {boolean}
 */
export const matchesSelectionAgainstTask = (selection, task = {}) => {
  if (!activeTaskStatuses.has(normalizeString(task.status))) {
    return false;
  }

  const downloadUrl = normalizeString(selection.selectedDownload?.titleUrl);
  if (downloadUrl && downloadUrl === normalizeString(task.titleUrl)) {
    return true;
  }

  return normalizeTitleMatchKey(selection.canonicalTitle) === normalizeTitleMatchKey(task.titleName)
    && normalizeTypeSlug(selection.libraryTypeSlug || selection.requestType) === normalizeTypeSlug(task.libraryTypeSlug || task.requestType);
};

/**
 * Evaluate a normalized selection against the current library, request, and
 * task state.
 *
 * @param {ReturnType<typeof buildIntakeSelection>} selection
 * @param {{
 *   libraryTitles?: Array<Record<string, unknown>>,
 *   requests?: Array<Record<string, unknown>>,
 *   tasks?: Array<Record<string, unknown>>
 * }} [guardState={}]
 * @param {{ignoreRequestId?: string}} [options={}]
 * @returns {{
 *   matchingTitle: Record<string, unknown> | null,
 *   matchingRequest: Record<string, unknown> | null,
 *   matchingTask: Record<string, unknown> | null,
 *   alreadyInLibrary: boolean,
 *   alreadyQueuedOrRequested: boolean
 * }}
 */
export const evaluateSelectionAgainstGuardState = (selection, guardState = {}, options = {}) => {
  const libraryTitles = normalizeArray(guardState.libraryTitles);
  const requests = normalizeArray(guardState.requests);
  const tasks = normalizeArray(guardState.tasks);

  const matchingTitle = libraryTitles.find((title) => matchesSelectionAgainstTitle(selection, title)) || null;
  const matchingRequest = requests.find((request) => matchesSelectionAgainstRequest(selection, request, options)) || null;
  const matchingTask = tasks.find((task) => matchesSelectionAgainstTask(selection, task)) || null;

  return {
    matchingTitle,
    matchingRequest,
    matchingTask,
    alreadyInLibrary: Boolean(matchingTitle),
    alreadyQueuedOrRequested: Boolean(matchingRequest || matchingTask)
  };
};
