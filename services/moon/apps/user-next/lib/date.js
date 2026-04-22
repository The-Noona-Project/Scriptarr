/**
 * @file Date formatting helpers for Moon's Next user app.
 */

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a user-facing date without shifting plain date-only strings across timezones.
 *
 * @param {string | null | undefined} value
 * @returns {Date | null}
 */
export const parseDateValue = (value) => {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  if (DATE_ONLY_PATTERN.test(normalized)) {
    const [year, month, day] = normalized.split("-").map((segment) => Number.parseInt(segment, 10));
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * Format a Moon-facing date label.
 *
 * @param {string | null | undefined} value
 * @param {{includeTime?: boolean}} [options]
 * @returns {string}
 */
export const formatDate = (value, {includeTime = false} = {}) => {
  const parsed = parseDateValue(value);
  if (!parsed) {
    return value ? String(value) : "Unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(includeTime ? {hour: "numeric", minute: "2-digit"} : {})
  }).format(parsed);
};

/**
 * Format a progress ratio as a percentage label.
 *
 * @param {number | null | undefined} value
 * @returns {string}
 */
export const formatProgress = (value) =>
  `${Math.round(Math.max(0, Math.min(1, Number(value || 0))) * 100)}%`;

/**
 * Humanize a chapter coverage summary.
 *
 * @param {number | null | undefined} downloaded
 * @param {number | null | undefined} total
 * @returns {string}
 */
export const formatCoverage = (downloaded, total) =>
  `${Number.parseInt(String(downloaded || 0), 10) || 0}/${Number.parseInt(String(total || 0), 10) || 0}`;

export default {
  formatCoverage,
  formatDate,
  formatProgress,
  parseDateValue
};
