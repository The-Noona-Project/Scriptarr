/**
 * @file Portal-facing library ingest broker payload helpers.
 */

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
export const PORTAL_INGEST_TYPE_SLUGS = Object.freeze(["manga", "manhwa", "manhua", "webtoon", "comic", "oel"]);

/**
 * Normalize a library type slug without inventing a default.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const normalizePortalIngestTypeSlug = (value) => normalizeString(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+/, "")
  .replace(/-+$/, "");

/**
 * Check whether a normalized library type slug is supported by Appa ingest.
 *
 * @param {string} value
 * @returns {boolean}
 */
export const isPortalIngestTypeSlug = (value) => PORTAL_INGEST_TYPE_SLUGS.includes(normalizePortalIngestTypeSlug(value));

const humanizeTypeSlug = (value) => normalizePortalIngestTypeSlug(value)
  .split("-")
  .filter(Boolean)
  .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
  .join(" ");

const titleTypeSlug = (title) => normalizePortalIngestTypeSlug(
  title?.libraryTypeSlug || title?.typeSlug || title?.mediaType || title?.type
);

const runTypeSlug = (run) => {
  const filters = normalizeObject(run?.filters, {}) || {};
  return normalizePortalIngestTypeSlug(
    run?.libraryTypeSlug
    || run?.typeSlug
    || run?.mediaType
    || run?.type
    || filters.libraryTypeSlug
    || filters.typeSlug
    || filters.mediaType
    || filters.type
  );
};

const runMatchesType = (run, libraryTypeSlug) => {
  const normalizedRunType = runTypeSlug(run);
  return !normalizedRunType || normalizedRunType === libraryTypeSlug;
};

const isActiveRun = (run) => ["queued", "running", "paused", "waiting", "active"]
  .includes(normalizeString(run?.status).toLowerCase());

const findActiveIngestRun = (payload, libraryTypeSlug) => {
  const directRun = normalizeObject(payload?.activeRun || payload?.activeIngestRun || payload?.run);
  if (directRun && runMatchesType(directRun, libraryTypeSlug)) {
    return directRun;
  }

  return [
    ...normalizeArray(payload?.activeRuns),
    ...normalizeArray(payload?.runs),
    ...normalizeArray(payload?.ingestRuns)
  ].find((run) => normalizeObject(run) && isActiveRun(run) && runMatchesType(run, libraryTypeSlug)) || null;
};

/**
 * Build the compact preview payload Portal needs before asking Raven to start
 * a durable ingest run.
 *
 * @param {unknown} ravenPayload
 * @param {{libraryTypeSlug: string}} options
 * @returns {{
 *   ok: boolean,
 *   type: string,
 *   libraryTypeSlug: string,
 *   libraryTypeLabel: string,
 *   titleCount: number,
 *   hardware: Record<string, unknown>,
 *   activeRun: Record<string, unknown> | null
 * }}
 */
export const buildPortalIngestPreview = (ravenPayload, {libraryTypeSlug}) => {
  const normalizedType = normalizePortalIngestTypeSlug(libraryTypeSlug);
  const payload = normalizeObject(ravenPayload, {}) || {};
  const titles = normalizeArray(payload.titles)
    .filter((title) => titleTypeSlug(title) === normalizedType);
  const firstTitle = titles[0] || {};
  const countByType = Number.parseInt(String(payload.counts?.byType?.[normalizedType] ?? ""), 10);
  const pageTotal = Number.parseInt(String(payload.pageInfo?.total ?? ""), 10);
  const hardware = normalizeObject(payload.hardware || payload.summary?.hardware, {}) || {};

  return {
    ok: true,
    type: normalizedType,
    libraryTypeSlug: normalizedType,
    libraryTypeLabel: normalizeString(firstTitle.libraryTypeLabel, humanizeTypeSlug(normalizedType)),
    titleCount: Number.isFinite(countByType)
      ? countByType
      : Number.isFinite(pageTotal)
        ? pageTotal
        : titles.length,
    hardware,
    activeRun: findActiveIngestRun(payload, normalizedType)
  };
};

/**
 * Build the Raven ingest-run request body from Portal's brokered request.
 *
 * @param {unknown} body
 * @param {{libraryTypeSlug: string, fallbackRequestedBy?: string}} options
 * @returns {Record<string, unknown>}
 */
export const buildPortalIngestRunPayload = (body, {libraryTypeSlug, fallbackRequestedBy = ""}) => {
  const source = normalizeObject(body, {}) || {};
  const normalizedType = normalizePortalIngestTypeSlug(libraryTypeSlug);
  return {
    ...source,
    type: normalizedType,
    libraryTypeSlug: normalizedType,
    requestedBy: normalizeString(source.requestedBy, normalizeString(fallbackRequestedBy, "scriptarr-portal"))
  };
};
