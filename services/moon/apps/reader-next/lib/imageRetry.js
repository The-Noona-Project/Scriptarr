/**
 * @file Reader image retry helpers shared by the page component and tests.
 */

export const READER_IMAGE_AUTO_RETRY_LIMIT = 3;

/**
 * Decide whether a failed reader image should retry before showing the manual
 * retry panel.
 *
 * @param {number} nextAttempt one-based retry attempt about to be scheduled
 * @param {number} [limit] maximum automatic retry attempts
 * @returns {boolean}
 */
export const shouldAutoRetryReaderImage = (nextAttempt, limit = READER_IMAGE_AUTO_RETRY_LIMIT) => {
  const attempt = Number.parseInt(String(nextAttempt), 10);
  const maxAttempts = Number.parseInt(String(limit), 10);
  return Number.isFinite(attempt) && Number.isFinite(maxAttempts) && attempt > 0 && attempt <= Math.max(0, maxAttempts);
};

/**
 * Resolve a short jittered delay before retrying a reader image.
 *
 * @param {number} attempt one-based retry attempt
 * @param {number} [jitter] deterministic jitter value from 0 to 1 for tests
 * @returns {number}
 */
export const resolveReaderImageRetryDelay = (attempt, jitter = Math.random()) => {
  const safeAttempt = Math.max(1, Number.parseInt(String(attempt), 10) || 1);
  const parsedJitter = Number.parseFloat(String(jitter));
  const safeJitter = Number.isFinite(parsedJitter) ? Math.max(0, Math.min(1, parsedJitter)) : 0;
  return Math.round(220 * (2 ** (safeAttempt - 1)) + safeJitter * 180);
};

/**
 * Build the brokered page-status URL that matches a revisioned reader image.
 *
 * @param {string} source reader page image source
 * @returns {string}
 */
export const buildReaderPageStatusUrl = (source = "") => {
  const normalized = String(source || "").trim();
  if (!normalized) {
    return "";
  }
  try {
    const parsed = new URL(normalized, "https://scriptarr.local");
    parsed.pathname = `${parsed.pathname.replace(/\/+$/g, "")}/status`;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "";
  }
};

export default {
  READER_IMAGE_AUTO_RETRY_LIMIT,
  buildReaderPageStatusUrl,
  resolveReaderImageRetryDelay,
  shouldAutoRetryReaderImage
};
