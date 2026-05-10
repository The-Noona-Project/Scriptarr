/**
 * @file Settings-page draft normalizers.
 */

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Normalize provider rows into editable Settings-page drafts.
 *
 * @param {unknown} providers
 * @returns {Array<Record<string, unknown>>}
 */
export const normalizeProviderDraft = (providers) => normalizeArray(providers).map((provider) => ({
  ...provider,
  enabled: provider.enabled !== false,
  priority: Number.parseInt(String(provider.priority || 10), 10) || 10
}));

/**
 * Normalize toast preferences into editable Settings-page drafts.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export const normalizeToastDraft = (value = {}) => ({
  actionToasts: value.actionToasts !== false,
  jobToasts: value.jobToasts !== false,
  liveEventToasts: value.liveEventToasts !== false,
  failuresOnly: value.failuresOnly === true,
  severities: {
    info: value.severities?.info !== false,
    success: value.severities?.success !== false,
    warning: value.severities?.warning !== false,
    error: value.severities?.error !== false
  }
});

export const settingsDraftSections = Object.freeze([
  "branding",
  "ravenVpn",
  "ravenDownloadRuntime",
  "metadataProviders",
  "downloadProviders",
  "requestWorkflow",
  "discord",
  "personalToasts",
  "globalToasts"
]);

/**
 * Build an editable Settings-page draft from the brokered settings payload.
 *
 * @param {Record<string, any>} data
 * @returns {Record<string, unknown>}
 */
export const buildSettingsDraft = (data = {}) => ({
  branding: {
    siteName: normalizeString(data.branding?.siteName, normalizeString(data.publicBranding?.siteName, "Scriptarr"))
  },
  ravenVpn: {
    enabled: Boolean(data.ravenVpn?.enabled),
    region: normalizeString(data.ravenVpn?.region, "us_california"),
    piaUsername: normalizeString(data.ravenVpn?.piaUsername),
    piaPassword: ""
  },
  ravenDownloadRuntime: {
    activeTitleDownloads: Math.max(1, Math.min(6, Number.parseInt(String(data.ravenDownloadRuntime?.activeTitleDownloads ?? 2), 10) || 2))
  },
  metadataProviders: normalizeProviderDraft(data.metadataProviders?.providers),
  downloadProviders: normalizeProviderDraft(data.downloadProviders?.providers),
  requestWorkflow: {
    autoApproveAndDownload: Boolean(data.requestWorkflow?.autoApproveAndDownload)
  },
  discord: {
    guildId: normalizeString(data.discord?.guildId),
    superuserId: normalizeString(data.discord?.superuserId),
    onboarding: {
      channelId: normalizeString(data.discord?.onboarding?.channelId),
      template: normalizeString(data.discord?.onboarding?.template)
    }
  },
  personalToasts: normalizeToastDraft(data.toastSettings?.personal || data.toastSettings?.effective),
  globalToasts: normalizeToastDraft(data.toastSettings?.global)
});

/**
 * Merge fresh broker settings into a draft while keeping dirty sections intact.
 *
 * @param {Record<string, unknown> | null} current
 * @param {Record<string, unknown>} incoming
 * @param {Set<string> | string[]} dirtySections
 * @returns {Record<string, unknown>}
 */
export const mergeSettingsDraft = (current, incoming, dirtySections = []) => {
  if (!current) {
    return incoming;
  }
  const dirty = dirtySections instanceof Set ? dirtySections : new Set(dirtySections);
  return Object.fromEntries(settingsDraftSections.map((section) => [
    section,
    dirty.has(section) ? current[section] : incoming[section]
  ]));
};

/**
 * Clear the write-only VPN password field after a successful save.
 *
 * @param {Record<string, unknown>} draft
 * @returns {Record<string, unknown>}
 */
export const clearVpnPasswordDraft = (draft) => ({
  ...(draft || {}),
  ravenVpn: {
    ...(draft?.ravenVpn || {}),
    piaPassword: ""
  }
});
