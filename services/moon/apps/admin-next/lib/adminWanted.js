/**
 * @file Wanted-page helpers for Moon's Next admin app.
 */

export const metadataGapLabels = Object.freeze({
  provider: "Provider",
  matchedAt: "Matched",
  summary: "Summary",
  aliases: "Aliases",
  tags: "Tags",
  cover: "Cover"
});

/**
 * Normalize unknown values into an array.
 *
 * @param {unknown} value
 * @returns {Array<any>}
 */
export const normalizeArray = (value) => Array.isArray(value) ? value : [];

/**
 * Normalize string values used by wanted-page filters.
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
 * Build a stable title row key.
 *
 * @param {Record<string, unknown>} title
 * @returns {string}
 */
export const titleRowKey = (title = {}) => normalizeString(title.id);

/**
 * Keep a drawer selection only when the title still exists.
 *
 * @param {Array<Record<string, unknown>>} titles
 * @param {string} selectedId
 * @returns {string}
 */
export const resolveExistingTitleSelection = (titles = [], selectedId = "") => {
  const normalizedSelectedId = normalizeString(selectedId);
  if (!normalizedSelectedId) {
    return "";
  }
  return normalizeArray(titles).some((title) => titleRowKey(title) === normalizedSelectedId) ? normalizedSelectedId : "";
};

/**
 * Compute a clamped downloaded/chapter coverage percent.
 *
 * @param {Record<string, unknown>} title
 * @returns {number}
 */
export const chapterCoveragePercent = (title = {}) => {
  const total = Number.parseInt(String(title.chapterCount || 0), 10) || 0;
  const downloaded = Number.parseInt(String(title.chaptersDownloaded || 0), 10) || 0;
  if (total <= 0) {
    return downloaded > 0 ? 100 : 0;
  }
  return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
};

/**
 * Resolve a title's missing chapter count.
 *
 * @param {Record<string, unknown>} title
 * @returns {number}
 */
export const missingChapterCount = (title = {}) => {
  const explicit = Number.parseInt(String(title.missingCount ?? ""), 10);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }
  const total = Number.parseInt(String(title.chapterCount || 0), 10) || 0;
  const downloaded = Number.parseInt(String(title.chaptersDownloaded || 0), 10) || 0;
  return Math.max(0, total - downloaded);
};

/**
 * Whether a wanted title has chapter/page quality damage.
 *
 * @param {Record<string, unknown>} title
 * @returns {boolean}
 */
export const hasMissingContentDamage = (title = {}) => {
  const quality = normalizeString(title.qualityStatus).toLowerCase();
  return ["missing_content", "possible_missing_page", "bad_source"].includes(quality)
    || Number.parseInt(String(title.missingPageCount || 0), 10) > 0
    || Number.parseInt(String(title.partialChapterCount || 0), 10) > 0
    || Number.parseInt(String(title.badChapterCount || 0), 10) > 0;
};

/**
 * Convert metadata gap ids into human labels.
 *
 * @param {Array<string>} gaps
 * @returns {string}
 */
export const metadataGapText = (gaps = []) =>
  normalizeArray(gaps).map((gap) => metadataGapLabels[gap] || gap).filter(Boolean).join(", ");

/**
 * Build searchable text for wanted title rows.
 *
 * @param {Record<string, unknown>} title
 * @returns {string}
 */
export const wantedTitleSearchText = (title = {}) => [
  title.title,
  title.mediaType,
  title.libraryTypeLabel,
  title.status,
  title.latestChapter,
  title.metadataProvider,
  title.sourceUrl,
  metadataGapText(title.gaps),
  ...normalizeArray(title.aliases),
  ...normalizeArray(title.tags)
].map((entry) => normalizeString(entry).toLowerCase()).filter(Boolean).join(" ");

/**
 * Filter metadata rows by query and optional gap id.
 *
 * @param {Array<Record<string, unknown>>} titles
 * @param {{query?: string, gap?: string}} options
 * @returns {Array<Record<string, unknown>>}
 */
export const filterMetadataRows = (titles = [], {query = "", gap = "all"} = {}) => {
  const normalizedQuery = normalizeString(query).toLowerCase();
  const normalizedGap = normalizeString(gap, "all");
  return normalizeArray(titles)
    .filter((title) => normalizedGap === "all" || normalizeArray(title.gaps).includes(normalizedGap))
    .filter((title) => !normalizedQuery || wantedTitleSearchText(title).includes(normalizedQuery));
};

/**
 * Filter missing chapter rows by query.
 *
 * @param {Array<Record<string, unknown>>} titles
 * @param {{query?: string}} options
 * @returns {Array<Record<string, unknown>>}
 */
export const filterMissingChapterRows = (titles = [], {query = ""} = {}) => {
  const normalizedQuery = normalizeString(query).toLowerCase();
  return normalizeArray(titles)
    .filter((title) => missingChapterCount(title) > 0 || hasMissingContentDamage(title))
    .filter((title) => !normalizedQuery || wantedTitleSearchText(title).includes(normalizedQuery));
};

export default {
  chapterCoveragePercent,
  filterMetadataRows,
  filterMissingChapterRows,
  hasMissingContentDamage,
  metadataGapLabels,
  metadataGapText,
  missingChapterCount,
  normalizeArray,
  normalizeString,
  resolveExistingTitleSelection,
  titleRowKey,
  wantedTitleSearchText
};
