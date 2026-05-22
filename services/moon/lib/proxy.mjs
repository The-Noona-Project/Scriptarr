/**
 * @typedef {{
 *   baseUrl: string,
 *   path: string,
 *   method?: string,
 *   body?: unknown,
 *   sessionToken?: string,
 *   headers?: Record<string, string>,
 *   signal?: AbortSignal
 * }} ProxyRequestOptions
 */
import {lookup} from "node:dns/promises";
import {isIP} from "node:net";
import {Readable} from "node:stream";

const INTERNAL_DNS_CACHE_TTL_MS = 30 * 1000;
const internalDnsCache = new Map();

/**
 * Parse a proxied response body into JSON when possible.
 *
 * @param {Buffer} buffer
 * @returns {unknown}
 */
const parseJsonBuffer = (buffer) => {
  const text = buffer.toString("utf8");
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return {raw: text};
  }
};

/**
 * Decide whether a proxy hostname is an internal Docker alias worth resolving.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
const shouldResolveInternalHost = (hostname) =>
  Boolean(hostname) && hostname !== "localhost" && !hostname.includes(".") && !isIP(hostname);

/**
 * Resolve and cache a single-label Docker service alias.
 *
 * @param {string} hostname
 * @returns {Promise<string>}
 */
const resolveInternalHost = async (hostname) => {
  const cached = internalDnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.address;
  }
  const result = await lookup(hostname, {family: 4});
  const address = result?.address || "";
  if (address) {
    internalDnsCache.set(hostname, {
      address,
      expiresAt: Date.now() + INTERNAL_DNS_CACHE_TTL_MS
    });
  }
  return address;
};

/**
 * Build a fetch URL for Moon's internal proxy calls.
 *
 * Docker's single-label service aliases can occasionally make Node's fetch
 * spend seconds in the name/connect path. Resolve those internal names first
 * and fetch the IPv4 address directly; dotted, localhost, and literal IP
 * targets keep their original URL.
 *
 * @param {string} baseUrl
 * @param {string} path
 * @returns {Promise<string>}
 */
export const resolveProxyFetchUrl = async (baseUrl, path) => {
  const target = new URL(`${baseUrl}${path}`);
  if (!shouldResolveInternalHost(target.hostname)) {
    return target.toString();
  }
  try {
    const address = await resolveInternalHost(target.hostname);
    if (address) {
      target.hostname = address;
    }
  } catch {
    return target.toString();
  }
  return target.toString();
};

/**
 * Proxy a request from Moon to one of its internal upstream services.
 *
 * @param {ProxyRequestOptions} options
 * @returns {Promise<{
 *   status: number,
 *   headers: Record<string, string>,
 *   body: Buffer
 * }>}
 */
export const proxyRequest = async ({
  baseUrl,
  path,
  method = "GET",
  body,
  sessionToken,
  headers = {},
  signal
}) => {
  const response = await fetch(await resolveProxyFetchUrl(baseUrl, path), {
    method,
    headers: {
      ...(body == null ? {} : {"Content-Type": "application/json"}),
      ...(sessionToken ? {"Authorization": `Bearer ${sessionToken}`} : {}),
      ...headers
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal
  });

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer())
  };
};

/**
 * Proxy a request from Moon to an upstream service while preserving the
 * response stream for long-lived transports such as SSE.
 *
 * @param {ProxyRequestOptions} options
 * @returns {Promise<{
 *   status: number,
 *   headers: Record<string, string>,
 *   body: import("node:stream").Readable | null
 * }>}
 */
export const proxyStream = async ({
  baseUrl,
  path,
  method = "GET",
  body,
  sessionToken,
  headers = {},
  signal
}) => {
  const response = await fetch(await resolveProxyFetchUrl(baseUrl, path), {
    method,
    headers: {
      ...(body == null ? {} : {"Content-Type": "application/json"}),
      ...(sessionToken ? {"Authorization": `Bearer ${sessionToken}`} : {}),
      ...headers
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal
  });

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: response.body ? Readable.fromWeb(response.body) : null
  };
};

/**
 * Proxy a request and parse the response body as JSON when possible.
 *
 * @param {ProxyRequestOptions} options
 * @returns {Promise<{
 *   status: number,
 *   headers: Record<string, string>,
 *   payload: unknown
 * }>}
 */
export const proxyJson = async (options) => {
  const response = await proxyRequest(options);
  return {
    status: response.status,
    headers: response.headers,
    payload: parseJsonBuffer(response.body)
  };
};

export default {
  proxyJson,
  proxyRequest,
  proxyStream,
  resolveProxyFetchUrl
};
