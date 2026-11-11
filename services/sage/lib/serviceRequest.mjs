/**
 * @file Authenticated, bounded first-party JSON requests from Sage.
 */
import {sageFetch as fetch} from "./httpTransport.mjs";

/**
 * Resolve a credential only for an explicitly configured service origin.
 *
 * @param {Record<string, any>} config Sage runtime configuration.
 * @param {string} baseUrl Configured destination URL.
 * @returns {Record<string, string>} Service authorization headers.
 */
export const serviceRequestHeaders = (config, baseUrl) => {
  const normalize = (value) => String(value || "").replace(/\/+$/, "");
  const destinations = [
    [config.wardenBaseUrl, "scriptarr-warden", config.wardenServiceToken],
    [config.portalBaseUrl, "scriptarr-portal", config.portalServiceToken],
    [config.oracleBaseUrl, "scriptarr-oracle", config.oracleServiceToken]
  ];
  const match = destinations.find(([url]) => url && normalize(url) === normalize(baseUrl));
  if (!match) {
    return {};
  }
  const token = match[2] || config.serviceTokens?.[match[1]];
  return token ? {Authorization: `Bearer ${token}`} : {};
};

/**
 * Create a first-party requester whose credentials remain scoped to its configuration.
 *
 * @param {Record<string, any>} config Sage runtime configuration.
 * @param {typeof fetch} [fetchImpl] Fetch implementation for requests and tests.
 * @returns {Function} JSON requester preserving the existing service result shape.
 */
export const createServiceJson = (config, fetchImpl = fetch) => async (baseUrl, servicePath, options = {}) => {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : 120000;
  const response = await fetchImpl(`${baseUrl}${servicePath}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...serviceRequestHeaders(config, baseUrl),
      ...(options.headers || {})
    },
    body: options.body == null ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error"
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {error: response.ok
        ? "Service returned a non-JSON response."
        : `Service request failed with HTTP ${response.status}.`};
    }
  }
  return {ok: response.ok, status: response.status, payload};
};
