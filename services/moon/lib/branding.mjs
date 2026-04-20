export const DEFAULT_SITE_NAME = "Scriptarr";

/**
 * Normalize a Moon branding site name into a safe display string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const normalizeSiteName = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || DEFAULT_SITE_NAME;
};

/**
 * Derive a short install-friendly site label for manifest metadata.
 *
 * @param {string} siteName
 * @returns {string}
 */
export const deriveShortSiteName = (siteName) => {
  const normalized = normalizeSiteName(siteName);
  const firstWord = normalized.split(/\s+/)[0] || normalized;
  return firstWord.length <= 12 ? firstWord : normalized.slice(0, 12).trim() || DEFAULT_SITE_NAME;
};

/**
 * Read the public Moon branding payload through Sage, falling back safely when
 * Sage is unavailable or returns an invalid response.
 *
 * @param {string} sageBaseUrl
 * @returns {Promise<{siteName: string, shortName: string}>}
 */
export const readMoonBranding = async (sageBaseUrl) => {
  try {
    const response = await fetch(`${String(sageBaseUrl || "").replace(/\/$/, "")}/api/moon-v3/public/branding`, {
      headers: {"Accept": "application/json"}
    });

    if (!response.ok) {
      throw new Error(`Branding request failed with status ${response.status}.`);
    }

    const payload = await response.json().catch(() => ({}));
    const siteName = normalizeSiteName(payload?.siteName);
    return {
      siteName,
      shortName: deriveShortSiteName(siteName)
    };
  } catch {
    return {
      siteName: DEFAULT_SITE_NAME,
      shortName: deriveShortSiteName(DEFAULT_SITE_NAME)
    };
  }
};

export default {
  DEFAULT_SITE_NAME,
  deriveShortSiteName,
  normalizeSiteName,
  readMoonBranding
};
