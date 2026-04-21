const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a Moon admin date value without shifting plain YYYY-MM-DD strings across timezones.
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
 * Format a date or date-time string for compact admin tables.
 *
 * @param {string | null | undefined} value
 * @param {{includeTime?: boolean}} [options]
 * @returns {string}
 */
export const formatDate = (value, {includeTime = false} = {}) => {
  if (!value) {
    return "Not available";
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
 * Format a numeric percentage value.
 *
 * @param {number | null | undefined} value
 * @returns {string}
 */
export const formatPercent = (value) => `${Math.max(0, Math.round(Number(value || 0)))}%`;

/**
 * Convert a status value into a UI tone class.
 *
 * @param {string | null | undefined} status
 * @returns {"good" | "warn" | "bad" | "muted"}
 */
export const statusTone = (status) => {
  const normalized = String(status || "").toLowerCase();

  if (["active", "approved", "completed", "healthy", "running", "enabled", "online", "owner"].includes(normalized)) {
    return "good";
  }

  if (["pending", "queued", "watching", "warning", "degraded", "update available", "available", "hiatus", "upcoming"].includes(normalized)) {
    return "warn";
  }

  if (["failed", "denied", "blocked", "disabled", "offline", "error", "cancelled", "canceled"].includes(normalized)) {
    return "bad";
  }

  return "muted";
};

/**
 * Humanize a nullable string array for table cells.
 *
 * @param {string[] | null | undefined} values
 * @returns {string}
 */
export const joinValues = (values) => Array.isArray(values) && values.length ? values.join(", ") : "None";

export default {
  formatDate,
  parseDateValue,
  formatPercent,
  joinValues,
  statusTone
};
