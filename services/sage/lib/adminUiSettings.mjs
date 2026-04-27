/**
 * @file Normalizers for Moon admin UI settings brokered through Sage.
 */

export const MOON_BRANDING_KEY = "moon.branding";
export const ADMIN_TOAST_GLOBAL_KEY = "moon.admin.toasts.global";
export const ADMIN_TOAST_USER_PREFIX = "moon.admin.toasts.user";

const MAX_LOGO_DATA_LENGTH = 6 * 1024 * 1024;
const LOGO_VARIANTS = Object.freeze(["chrome", "icon192", "icon512"]);

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};

const normalizeNumber = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const normalizeVariant = (value = {}) => {
  const dataBase64 = normalizeString(value.dataBase64);
  return {
    mimeType: "image/webp",
    width: normalizeNumber(value.width),
    height: normalizeNumber(value.height),
    byteLength: normalizeNumber(value.byteLength),
    dataBase64: dataBase64.length <= MAX_LOGO_DATA_LENGTH ? dataBase64 : ""
  };
};

const hasUsableLogoVariant = (variant = {}) =>
  variant.mimeType === "image/webp" && variant.dataBase64 && variant.width > 0 && variant.height > 0;

/**
 * Build default Moon branding settings.
 *
 * @returns {Record<string, unknown>}
 */
export const defaultMoonBrandingSettings = () => ({
  key: MOON_BRANDING_KEY,
  siteName: "Scriptarr",
  logo: {
    enabled: false,
    revision: "",
    updatedAt: null,
    updatedBy: null,
    originalMimeType: "",
    originalBytes: 0,
    variants: {}
  }
});

/**
 * Normalize persisted or inbound branding settings.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export const normalizeMoonBrandingSettings = (value) => {
  const defaults = defaultMoonBrandingSettings();
  const siteName = normalizeString(value?.siteName, defaults.siteName).slice(0, 80).trim() || defaults.siteName;
  const rawLogo = value?.logo && typeof value.logo === "object" && !Array.isArray(value.logo) ? value.logo : {};
  const variants = Object.fromEntries(LOGO_VARIANTS.map((variantName) => [
    variantName,
    normalizeVariant(rawLogo.variants?.[variantName] || rawLogo[variantName] || {})
  ]));
  const enabled = normalizeBoolean(rawLogo.enabled, false) && hasUsableLogoVariant(variants.chrome);
  return {
    ...defaults,
    siteName,
    logo: {
      enabled,
      revision: normalizeString(rawLogo.revision),
      updatedAt: normalizeString(rawLogo.updatedAt) || null,
      updatedBy: rawLogo.updatedBy && typeof rawLogo.updatedBy === "object" ? rawLogo.updatedBy : null,
      originalMimeType: normalizeString(rawLogo.originalMimeType),
      originalBytes: normalizeNumber(rawLogo.originalBytes),
      variants
    }
  };
};

/**
 * Convert persisted branding to browser-safe public metadata.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export const publicMoonBranding = (value) => {
  const branding = normalizeMoonBrandingSettings(value);
  const revision = normalizeString(branding.logo?.revision);
  const suffix = revision ? `?rev=${encodeURIComponent(revision)}` : "";
  return {
    siteName: branding.siteName,
    logo: {
      enabled: Boolean(branding.logo?.enabled),
      revision,
      updatedAt: branding.logo?.updatedAt || null,
      urls: branding.logo?.enabled ? {
        chrome: `/api/moon/v3/public/branding/logo/chrome${suffix}`,
        icon192: `/api/moon/v3/public/branding/logo/icon192${suffix}`,
        icon512: `/api/moon/v3/public/branding/logo/icon512${suffix}`
      } : {}
    }
  };
};

/**
 * Select a stored logo variant for image serving.
 *
 * @param {unknown} brandingValue
 * @param {string} variantName
 * @returns {{mimeType: string, buffer: Buffer, width: number, height: number, revision: string} | null}
 */
export const selectMoonLogoVariant = (brandingValue, variantName) => {
  const branding = normalizeMoonBrandingSettings(brandingValue);
  const normalizedVariantName = LOGO_VARIANTS.includes(variantName) ? variantName : "chrome";
  const variant = branding.logo?.variants?.[normalizedVariantName];
  if (!branding.logo?.enabled || !hasUsableLogoVariant(variant)) {
    return null;
  }
  return {
    mimeType: "image/webp",
    buffer: Buffer.from(variant.dataBase64, "base64"),
    width: variant.width,
    height: variant.height,
    revision: normalizeString(branding.logo.revision)
  };
};

/**
 * Build the per-user toast settings key.
 *
 * @param {string} discordUserId
 * @returns {string}
 */
export const adminToastUserKey = (discordUserId) =>
  `${ADMIN_TOAST_USER_PREFIX}.${normalizeString(discordUserId, "anonymous")}`;

/**
 * Build default admin toast settings.
 *
 * @returns {Record<string, unknown>}
 */
export const defaultAdminToastSettings = () => ({
  actionToasts: true,
  jobToasts: true,
  liveEventToasts: true,
  failuresOnly: false,
  severities: {
    info: true,
    success: true,
    warning: true,
    error: true
  }
});

/**
 * Normalize toast preferences.
 *
 * @param {unknown} value
 * @param {unknown} [fallback]
 * @returns {Record<string, unknown>}
 */
export const normalizeAdminToastSettings = (value, fallback = defaultAdminToastSettings()) => {
  const base = fallback && typeof fallback === "object" && !Array.isArray(fallback)
    ? fallback
    : defaultAdminToastSettings();
  const severities = value?.severities && typeof value.severities === "object" && !Array.isArray(value.severities)
    ? value.severities
    : {};
  return {
    actionToasts: normalizeBoolean(value?.actionToasts, base.actionToasts !== false),
    jobToasts: normalizeBoolean(value?.jobToasts, base.jobToasts !== false),
    liveEventToasts: normalizeBoolean(value?.liveEventToasts, base.liveEventToasts !== false),
    failuresOnly: normalizeBoolean(value?.failuresOnly, Boolean(base.failuresOnly)),
    severities: {
      info: normalizeBoolean(severities.info, base.severities?.info !== false),
      success: normalizeBoolean(severities.success, base.severities?.success !== false),
      warning: normalizeBoolean(severities.warning, base.severities?.warning !== false),
      error: normalizeBoolean(severities.error, base.severities?.error !== false)
    }
  };
};

/**
 * Merge global and personal toast preferences.
 *
 * @param {unknown} globalSettings
 * @param {unknown} personalSettings
 * @returns {Record<string, unknown>}
 */
export const mergeAdminToastSettings = (globalSettings, personalSettings) =>
  normalizeAdminToastSettings(personalSettings, normalizeAdminToastSettings(globalSettings));

export default {
  ADMIN_TOAST_GLOBAL_KEY,
  ADMIN_TOAST_USER_PREFIX,
  MOON_BRANDING_KEY,
  adminToastUserKey,
  defaultAdminToastSettings,
  defaultMoonBrandingSettings,
  mergeAdminToastSettings,
  normalizeAdminToastSettings,
  normalizeMoonBrandingSettings,
  publicMoonBranding,
  selectMoonLogoVariant
};
