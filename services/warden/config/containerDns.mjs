/**
 * @file Optional, service-scoped Docker DNS configuration.
 */
import {isIP} from "node:net";

const normalizeAddress = (value, label) => {
  if (typeof value !== "string" || !isIP(value.trim())) throw new Error(`${label} must contain only resolver IP addresses.`);
  const address = value.trim();
  return isIP(address) === 6 ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address;
};

const normalizeServers = (values, label) => {
  if (!Array.isArray(values)) throw new Error(`${label} must be a resolver IP list.`);
  return [...new Set(values.map((value) => normalizeAddress(value, label)))];
};

/**
 * Resolve an optional per-service DNS override without changing inherited defaults.
 * An explicit empty JSON array requests restoration of Docker's inherited DNS.
 *
 * @param {string} serviceName canonical managed service name
 * @param {NodeJS.ProcessEnv | Record<string, unknown>} [env] Warden environment
 * @returns {string[] | undefined} ordered resolver addresses, or no configured override
 */
export const resolveServiceDnsServers = (serviceName, env = process.env) => {
  const key = `SCRIPTARR_${String(serviceName).replace(/^scriptarr-/, "").toUpperCase()}_DNS_SERVERS`;
  const value = env[key];
  if (value == null || (typeof value === "string" && !value.trim())) return undefined;
  let values = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("[")) {
      try { values = JSON.parse(text); }
      catch { throw new Error(`${key} must be a valid resolver IP list.`); }
    } else {
      values = text.split(/[\s,]+/).filter(Boolean);
      if (!values.length) throw new Error(`${key} must contain resolver IP addresses or an explicit empty JSON array.`);
    }
  }
  return normalizeServers(values, key);
};

/**
 * Build Docker argument pairs for an explicitly configured resolver list.
 *
 * @param {string[] | undefined} servers normalized service resolver addresses
 * @returns {string[]} Docker CLI arguments
 */
export const containerDnsArguments = (servers) => servers === undefined ? []
  : normalizeServers(servers, "Container DNS").flatMap((server) => ["--dns", server]);

/**
 * Compare only explicitly managed DNS, preserving resolver priority and inherited settings.
 *
 * @param {string[] | undefined} servers desired resolver addresses
 * @param {object | null} inspect Docker container inspection
 * @returns {boolean} whether configured DNS agrees, or DNS was left unmanaged
 */
export const containerDnsMatchesInspect = (servers, inspect) => {
  if (servers === undefined) return true;
  try {
    return JSON.stringify(normalizeServers(servers, "Container DNS"))
      === JSON.stringify(normalizeServers(inspect?.HostConfig?.Dns || [], "Inspected DNS"));
  } catch { return false; }
};
