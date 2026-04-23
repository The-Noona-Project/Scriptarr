/**
 * @file Route helpers for Moon's Next-based user application.
 */
import {canAccessAdmin as canAccessMoonAdmin} from "@scriptarr/access";

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
 * Resolve whether the active session can open Moon admin.
 *
 * @param {{role?: string, isOwner?: boolean, adminGrants?: Record<string, string>} | null | undefined} user
 * @returns {boolean}
 */
export const canAccessAdmin = (user) => canAccessMoonAdmin(user);

/**
 * Build the canonical profile route.
 *
 * @returns {string}
 */
export const buildProfilePath = () => "/profile";

/**
 * Build a canonical type-scoped library route.
 *
 * @param {string} [typeSlug]
 * @returns {string}
 */
export const buildLibraryPath = (typeSlug = "manga") =>
  `/library/${encodeURIComponent(normalizeTypeSlug(typeSlug))}`;

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
 * Normalize a pathname so Moon can highlight the active chrome surface.
 *
 * @param {string} pathname
 * @returns {"home" | "browse" | "library" | "requests" | "following" | "profile" | "title" | "reader"}
 */
export const classifyPathname = (pathname) => {
  if (pathname === "/") {
    return "home";
  }
  if (pathname.startsWith("/browse")) {
    return "browse";
  }
  if (pathname.startsWith("/library")) {
    return "library";
  }
  if (pathname.startsWith("/myrequests")) {
    return "requests";
  }
  if (pathname.startsWith("/following")) {
    return "following";
  }
  if (pathname.startsWith("/profile")) {
    return "profile";
  }
  if (pathname.startsWith("/reader")) {
    return "reader";
  }
  return "title";
};

/**
 * Normalize a Moon library type label for display.
 *
 * @param {string | null | undefined} value
 * @returns {string}
 */
export const formatTypeLabel = (value) => {
  const normalized = normalizeTypeSlug(value);
  return normalized
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

/**
 * Expose the known library types for MegaMenu and filters.
 *
 * @returns {Array<{slug: string, label: string}>}
 */
export const getLibraryTypes = () => [
  {slug: "manga", label: "Manga"},
  {slug: "manhwa", label: "Manhwa"},
  {slug: "manhua", label: "Manhua"},
  {slug: "webtoon", label: "Webtoon"},
  {slug: "comic", label: "Comic"},
  {slug: "oel", label: "OEL"}
];

export default {
  buildProfilePath,
  buildLibraryPath,
  buildReaderPath,
  buildReaderPathForTitle,
  buildTitlePath,
  buildTitlePathForTitle,
  canAccessAdmin,
  classifyPathname,
  formatTypeLabel,
  getLibraryTypes,
  resolveTitleTypeSlug
};
