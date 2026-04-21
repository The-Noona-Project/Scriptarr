const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a Moon user-facing date without shifting plain YYYY-MM-DD strings across timezones.
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
    const [year, month, day] = normalized.split("-").map((part) => Number.parseInt(part, 10));
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * Format a date label for the Moon user app.
 *
 * @param {string | null | undefined} value
 * @param {{includeTime?: boolean}} [options]
 * @returns {string}
 */
export const formatDate = (value, {includeTime = false} = {}) => {
  if (!value) {
    return "Unknown";
  }

  const parsed = parseDateValue(value);
  if (!parsed) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(includeTime ? {hour: "numeric", minute: "2-digit"} : {})
  }).format(parsed);
};

/**
 * Format a read progress ratio as a percentage label.
 *
 * @param {number | null | undefined} value
 * @returns {string}
 */
export const formatProgress = (value) => `${Math.round(Math.max(0, Math.min(1, Number(value || 0))) * 100)}%`;

/**
 * Join a list of strings for compact metadata summaries.
 *
 * @param {string[] | null | undefined} values
 * @returns {string}
 */
export const joinValues = (values) => Array.isArray(values) && values.length ? values.join(", ") : "None";

export default {
  formatDate,
  parseDateValue,
  formatProgress,
  joinValues
};
