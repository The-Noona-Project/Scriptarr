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

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
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

  if (["pending", "queued", "watching", "warning", "degraded", "update available", "available"].includes(normalized)) {
    return "warn";
  }

  if (["failed", "denied", "blocked", "disabled", "offline", "error"].includes(normalized)) {
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
  formatPercent,
  joinValues,
  statusTone
};
