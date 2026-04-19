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
  formatProgress,
  joinValues
};
