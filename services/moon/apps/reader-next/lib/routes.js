/**
 * @file Route helpers for Moon's dedicated reader app.
 */

const normalizeTypeSlug = (value, fallback = "manga") => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

/**
 * Build a canonical type-scoped title route in the user app.
 *
 * @param {string} typeSlug
 * @param {string} titleId
 * @returns {string}
 */
export const buildTitlePath = (typeSlug, titleId) =>
  `/title/${encodeURIComponent(normalizeTypeSlug(typeSlug))}/${encodeURIComponent(String(titleId || "").trim())}`;

/**
 * Build a canonical type-scoped reader route.
 *
 * @param {string} typeSlug
 * @param {string} titleId
 * @param {string} chapterId
 * @returns {string}
 */
export const buildReaderPath = (typeSlug, titleId, chapterId) =>
  `/reader/${encodeURIComponent(normalizeTypeSlug(typeSlug))}/${encodeURIComponent(String(titleId || "").trim())}/${encodeURIComponent(String(chapterId || "").trim())}`;

/**
 * Resolve a title-like payload into Moon's canonical library type slug.
 *
 * @param {{libraryTypeSlug?: string, mediaType?: string} | null | undefined} title
 * @returns {string}
 */
export const resolveTitleTypeSlug = (title) =>
  normalizeTypeSlug(title?.libraryTypeSlug || title?.mediaType);

/**
 * Build a canonical user title route from a title-like payload.
 *
 * @param {{id?: string, libraryTypeSlug?: string, mediaType?: string} | null | undefined} title
 * @returns {string}
 */
export const buildTitlePathForTitle = (title) =>
  buildTitlePath(resolveTitleTypeSlug(title), title?.id || "");

/**
 * Build a canonical reader route from a title-like payload.
 *
 * @param {{id?: string, libraryTypeSlug?: string, mediaType?: string} | null | undefined} title
 * @param {string} chapterId
 * @returns {string}
 */
export const buildReaderPathForTitle = (title, chapterId) =>
  buildReaderPath(resolveTitleTypeSlug(title), title?.id || "", chapterId);

export default {
  buildReaderPath,
  buildReaderPathForTitle,
  buildTitlePath,
  buildTitlePathForTitle,
  resolveTitleTypeSlug
};
