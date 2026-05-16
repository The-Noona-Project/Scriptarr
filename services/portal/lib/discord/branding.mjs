const DEFAULT_BRAND_NAME = "Scriptarr";

/**
 * Normalize a public product name for Discord copy.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export const normalizeBrandName = (value, fallback = DEFAULT_BRAND_NAME) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Build a synchronous brand-name getter for command and notification copy.
 *
 * @param {() => string} [getBrandName]
 * @returns {() => string}
 */
export const createBrandNameGetter = (getBrandName) => () =>
  normalizeBrandName(typeof getBrandName === "function" ? getBrandName() : "");

export default {
  createBrandNameGetter,
  normalizeBrandName
};
