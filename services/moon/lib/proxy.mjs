/**
 * @typedef {{
 *   baseUrl: string,
 *   path: string,
 *   method?: string,
 *   body?: unknown,
 *   sessionToken?: string,
 *   headers?: Record<string, string>
 * }} ProxyRequestOptions
 */
import {Readable} from "node:stream";

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
  headers = {}
}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body == null ? {} : {"Content-Type": "application/json"}),
      ...(sessionToken ? {"Authorization": `Bearer ${sessionToken}`} : {}),
      ...headers
    },
    body: body == null ? undefined : JSON.stringify(body)
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
  headers = {}
}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body == null ? {} : {"Content-Type": "application/json"}),
      ...(sessionToken ? {"Authorization": `Bearer ${sessionToken}`} : {}),
      ...headers
    },
    body: body == null ? undefined : JSON.stringify(body)
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
  proxyStream
};
