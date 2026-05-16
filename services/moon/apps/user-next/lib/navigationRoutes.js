/**
 * @file Navigation-only route helpers for Moon's Next-based user shell.
 */

import {canAccessAdmin as canAccessMoonAdmin} from "@scriptarr/access";
import {normalizeTypeSlug} from "./routeSlugs.js";

const PREFERRED_LIBRARY_TYPES = Object.freeze([
  {slug: "manga", label: "Manga"},
  {slug: "manhwa", label: "Manhwa"},
  {slug: "manhua", label: "Manhua"},
  {slug: "webtoon", label: "Webtoon"},
  {slug: "comic", label: "Comic"},
  {slug: "oel", label: "OEL"}
]);

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
 * Normalize a compact card type-count payload into positive-count buckets.
 *
 * @param {Record<string, unknown> | null | undefined} countsByType
 * @returns {Map<string, number>}
 */
const normalizeLibraryTypeCounts = (countsByType) => {
  const counts = new Map();
  if (!countsByType || typeof countsByType !== "object" || Array.isArray(countsByType)) {
    return counts;
  }

  for (const [rawSlug, rawCount] of Object.entries(countsByType)) {
    const slug = normalizeTypeSlug(rawSlug, "");
    const count = Math.max(0, Number.parseInt(String(rawCount ?? 0), 10) || 0);
    if (!slug || count <= 0) {
      continue;
    }
    counts.set(slug, (counts.get(slug) || 0) + count);
  }

  return counts;
};

/**
 * Resolve the positive count for a library type slug.
 *
 * @param {Record<string, unknown> | null | undefined} countsByType
 * @param {string | null | undefined} typeSlug
 * @returns {number}
 */
export const getLibraryTypeCount = (countsByType, typeSlug) => {
  const slug = normalizeTypeSlug(typeSlug, "");
  if (!slug) {
    return 0;
  }
  return normalizeLibraryTypeCounts(countsByType).get(slug) || 0;
};

/**
 * Expose visible library types for navigation and filters.
 *
 * @param {Record<string, unknown> | null | undefined} [countsByType]
 * @returns {Array<{slug: string, label: string, count: number}>}
 */
export const getLibraryTypes = (countsByType = null) => {
  const counts = normalizeLibraryTypeCounts(countsByType);
  const preferredSlugs = new Set(PREFERRED_LIBRARY_TYPES.map((entry) => entry.slug));
  const preferred = PREFERRED_LIBRARY_TYPES
    .filter((entry) => (counts.get(entry.slug) || 0) > 0)
    .map((entry) => ({...entry, count: counts.get(entry.slug) || 0}));
  const dynamic = Array.from(counts.entries())
    .filter(([slug]) => !preferredSlugs.has(slug))
    .map(([slug, count]) => ({slug, label: formatTypeLabel(slug), count}))
    .sort((left, right) => left.label.localeCompare(right.label, "en", {numeric: true, sensitivity: "base"}));

  return [...preferred, ...dynamic];
};
