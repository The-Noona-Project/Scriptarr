/**
 * @file Title and reader route helpers for Moon's Next-based user app.
 */

import {normalizeTypeSlug} from "./routeSlugs.js";

/**
 * Build a canonical title route.
 *
 * @param {string} typeSlug
 * @param {string} titleId
 * @returns {string}
 */
export const buildTitlePath = (typeSlug, titleId) =>
  `/title/${encodeURIComponent(normalizeTypeSlug(typeSlug))}/${encodeURIComponent(String(titleId || "").trim())}`;

/**
 * Build a canonical reader route.
 *
 * @param {string} typeSlug
 * @param {string} titleId
 * @param {string} chapterId
 * @returns {string}
 */
export const buildReaderPath = (typeSlug, titleId, chapterId) =>
  `/reader/${encodeURIComponent(normalizeTypeSlug(typeSlug))}/${encodeURIComponent(String(titleId || "").trim())}/${encodeURIComponent(String(chapterId || "").trim())}`;

/**
 * Resolve a title-like payload into Moon's canonical type slug.
 *
 * @param {{libraryTypeSlug?: string, mediaType?: string} | null | undefined} title
 * @returns {string}
 */
export const resolveTitleTypeSlug = (title) =>
  normalizeTypeSlug(title?.libraryTypeSlug || title?.mediaType);

/**
 * Build a canonical title route from a title-like payload.
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

/**
 * Build the best reader route for a compact title card.
 *
 * @param {{id?: string, libraryTypeSlug?: string, mediaType?: string, readerTarget?: {chapterId?: string} | null} | null | undefined} title
 * @returns {string}
 */
export const buildReaderPathForTitleTarget = (title) => {
  const chapterId = String(title?.readerTarget?.chapterId || "").trim();
  return chapterId ? buildReaderPathForTitle(title, chapterId) : buildTitlePathForTitle(title);
};

