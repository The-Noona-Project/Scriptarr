/**
 * @typedef {{
 *   ok: boolean,
 *   status: number,
 *   payload: any
 * }} ApiResult
 */

/**
 * Parse a Moon user API response.
 *
 * @param {Response} response
 * @returns {Promise<any>}
 */
const parseBody = async (response) => {
  const text = await response.text();
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
 * Perform a JSON request against Moon's same-origin API surface.
 *
 * @param {string} url
 * @param {RequestInit & {json?: unknown}} [options]
 * @returns {Promise<ApiResult>}
 */
export const requestJson = async (url, options = {}) => {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.json == null ? {} : {"Content-Type": "application/json"}),
        ...(options.headers || {})
      },
      body: options.json == null ? options.body : JSON.stringify(options.json)
    });

    return {
      ok: response.ok,
      status: response.status,
      payload: await parseBody(response)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: {
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
};

/**
 * Build the Moon user-side API helpers.
 *
 * @returns {{
 *   get: (url: string) => Promise<ApiResult>,
 *   post: (url: string, json?: unknown) => Promise<ApiResult>,
 *   put: (url: string, json?: unknown) => Promise<ApiResult>,
 *   delete: (url: string) => Promise<ApiResult>,
 *   getAuthStatus: () => Promise<ApiResult>,
 *   getBootstrapStatus: () => Promise<ApiResult>,
 *   getDiscordUrl: () => Promise<ApiResult>,
 *   getBranding: () => Promise<ApiResult>
 * }}
 */
export const createUserApi = () => ({
  get: (url) => requestJson(url),
  post: (url, json) => requestJson(url, {method: "POST", json}),
  put: (url, json) => requestJson(url, {method: "PUT", json}),
  delete: (url) => requestJson(url, {method: "DELETE"}),
  getAuthStatus: () => requestJson("/api/moon/auth/status"),
  getBootstrapStatus: () => requestJson("/api/moon/auth/bootstrap-status"),
  getDiscordUrl: () => requestJson("/api/moon/auth/discord/url"),
  getBranding: () => requestJson("/api/moon/v3/public/branding")
});

export default createUserApi;
