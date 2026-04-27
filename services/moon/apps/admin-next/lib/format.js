/**
 * @file Compact display helpers for Moon admin Next pages.
 */

/**
 * Normalize unknown values into display strings.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Convert unknown API values into compact render-safe labels.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export const formatDisplayValue = (value, fallback = "unknown") => {
  if (typeof value === "string") {
    return value.trim() || fallback;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : fallback;
  }

  if (typeof value === "bigint") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (value == null) {
    return fallback;
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      return fallback;
    }
    const scalarEntries = value
      .map((entry) => formatDisplayValue(entry, ""))
      .filter(Boolean);
    if (scalarEntries.length === value.length) {
      return scalarEntries.join(", ");
    }
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }

  if (typeof value === "object") {
    for (const key of ["label", "name", "title", "message", "phase", "status", "key", "id", "service", "provider", "model", "image", "configuredImage", "selectedImage"]) {
      const entry = value[key];
      if (["string", "number", "bigint", "boolean"].includes(typeof entry)) {
        const normalized = formatDisplayValue(entry, "");
        if (normalized) {
          return normalized;
        }
      }
    }
    if ("ok" in value && typeof value.ok === "boolean") {
      return value.ok ? "ok" : "failed";
    }
  }

  return fallback;
};

/**
 * Format a number as a queue percentage.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const formatPercent = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "0%";
  }
  return `${Math.max(0, Math.min(100, Math.round(numeric)))}%`;
};

/**
 * Format a timestamp into a dense admin date label.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const formatDate = (value) => {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
};

/**
 * Format transfer speed when Raven reports credible telemetry.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const formatTransferRate = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let amount = numeric;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unitIndex]}`;
};

/**
 * Format an active-task ETA.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const formatEta = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  if (numeric < 1) {
    return "<1m";
  }
  if (numeric < 60) {
    return `${Math.round(numeric)}m`;
  }
  const hours = Math.floor(numeric / 60);
  const minutes = Math.round(numeric % 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
};
