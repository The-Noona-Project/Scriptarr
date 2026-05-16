/**
 * @file Navigation-only route helpers for Moon's Next-based user shell.
 */

import {canAccessAdmin as canAccessMoonAdmin} from "@scriptarr/access";
import {normalizeTypeSlug} from "./routeSlugs.js";

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
 * Expose the known library types for navigation and filters.
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

