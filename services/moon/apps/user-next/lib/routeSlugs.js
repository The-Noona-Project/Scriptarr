/**
 * @file Shared slug helpers for Moon's Next-based user route helpers.
 */

/**
 * Normalize a library type value for Moon user routes.
 *
 * @param {string | null | undefined} value
 * @param {string} [fallback]
 * @returns {string}
 */
export const normalizeTypeSlug = (value, fallback = "manga") => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

