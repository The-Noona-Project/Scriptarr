"use client";

/**
 * @file Raven VPN runtime display helpers for Moon admin.
 */

/**
 * Normalize a Raven VPN runtime state into Moon's admin badge vocabulary.
 *
 * @param {Record<string, any>} runtime
 * @returns {string}
 */
export const normalizeVpnRuntimeState = (runtime = {}) => {
  const normalized = String(runtime?.state || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (normalized) {
    return normalized;
  }
  if (runtime?.protected) {
    return "protected";
  }
  if (runtime?.runtimeCapable === false) {
    return "runtime_unsupported";
  }
  if (runtime?.settingsFresh === false) {
    return "settings_stale";
  }
  if (runtime?.connected) {
    return "connected";
  }
  return runtime?.enabled ? "armed" : "disabled";
};

/**
 * Pick the Once UI admin badge tone for a Raven VPN runtime state.
 *
 * @param {Record<string, any>} vpnSettings
 * @param {Record<string, any>} runtime
 * @returns {"good" | "warning" | "bad"}
 */
export const vpnRuntimeTone = (vpnSettings = {}, runtime = {}) => {
  const state = normalizeVpnRuntimeState(runtime);
  if (!vpnSettings?.enabled || state === "disabled") {
    return "warning";
  }
  if (state === "protected" || state === "connected") {
    return "good";
  }
  if (state === "armed" || state === "connecting") {
    return "warning";
  }
  return "bad";
};

/**
 * Pick the human-readable label for a Raven VPN runtime state.
 *
 * @param {Record<string, any>} vpnSettings
 * @param {Record<string, any>} runtime
 * @returns {string}
 */
export const vpnRuntimeLabel = (vpnSettings = {}, runtime = {}) => {
  if (!vpnSettings?.enabled) {
    return "disabled";
  }
  const state = normalizeVpnRuntimeState(runtime);
  if (state === "protected" || state === "connected") {
    return "protected";
  }
  if (state === "armed") {
    return "armed / idle";
  }
  if (state === "connecting") {
    return "connecting";
  }
  if (state === "runtime_unsupported") {
    return "runtime unsupported";
  }
  if (state === "settings_stale") {
    return "settings stale";
  }
  if (state === "failed") {
    return "failed";
  }
  return "armed / idle";
};
