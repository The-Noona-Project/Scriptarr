/**
 * @file Display helpers for the Moon admin System Status endpoint matrix.
 */

/**
 * Resolve the badge tone for a status probe result.
 *
 * @param {unknown} status
 * @returns {string}
 */
export const probeStatusTone = (status) => {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (normalized === "online") {
    return "good";
  }
  if (normalized === "protected") {
    return "warning";
  }
  if (normalized === "degraded" || normalized === "failed") {
    return "bad";
  }
  return "queued";
};

/**
 * Format a probe result for compact badge display.
 *
 * @param {unknown} status
 * @returns {string}
 */
export const probeStatusLabel = (status) => {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (!normalized) {
    return "not probed";
  }
  return normalized.replaceAll("_", " ");
};

/**
 * Format the route safety/read-check state for the endpoint table.
 *
 * @param {boolean} safeToProbe
 * @returns {string}
 */
export const probeSafetyLabel = (safeToProbe) => safeToProbe ? "GET checked" : "mutation skipped";

export default {
  probeSafetyLabel,
  probeStatusLabel,
  probeStatusTone
};
