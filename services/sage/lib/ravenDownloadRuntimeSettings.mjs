/**
 * @file Normalize brokered Raven download runtime settings.
 */

export const RAVEN_DOWNLOAD_RUNTIME_KEY = "raven.download.runtime";
export const MIN_ACTIVE_TITLE_DOWNLOADS = 1;
export const MAX_ACTIVE_TITLE_DOWNLOADS = 6;
export const DEFAULT_ACTIVE_TITLE_DOWNLOADS = 2;

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const toInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

/**
 * Normalize Raven download runtime settings from Vault.
 *
 * @param {Record<string, unknown> | null | undefined} value
 * @returns {{key: string, activeTitleDownloads: number, minActiveTitleDownloads: number, maxActiveTitleDownloads: number}}
 */
export const normalizeRavenDownloadRuntimeSettings = (value) => {
  const activeTitleDownloads = toInteger(value?.activeTitleDownloads, DEFAULT_ACTIVE_TITLE_DOWNLOADS);
  return {
    key: RAVEN_DOWNLOAD_RUNTIME_KEY,
    activeTitleDownloads: Math.max(MIN_ACTIVE_TITLE_DOWNLOADS, Math.min(MAX_ACTIVE_TITLE_DOWNLOADS, activeTitleDownloads)),
    minActiveTitleDownloads: MIN_ACTIVE_TITLE_DOWNLOADS,
    maxActiveTitleDownloads: MAX_ACTIVE_TITLE_DOWNLOADS
  };
};

/**
 * Validate an admin-supplied active title download count.
 *
 * @param {unknown} value
 * @returns {{ok: true, value: number} | {ok: false, error: string}}
 */
export const validateActiveTitleDownloads = (value) => {
  const normalized = typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : normalizeString(value);
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== normalized) {
    return {ok: false, error: "activeTitleDownloads must be an integer from 1 to 6."};
  }
  if (parsed < MIN_ACTIVE_TITLE_DOWNLOADS || parsed > MAX_ACTIVE_TITLE_DOWNLOADS) {
    return {ok: false, error: "activeTitleDownloads must be between 1 and 6."};
  }
  return {ok: true, value: parsed};
};
