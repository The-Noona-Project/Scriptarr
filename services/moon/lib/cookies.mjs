/**
 * Parse an HTTP cookie header into a key/value lookup object.
 *
 * @param {string} header
 * @returns {Record<string, string>}
 */
export const parseCookies = (header) => {
  const jar = {};

  for (const part of String(header || "").split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) {
      continue;
    }

    jar[rawKey] = decodeURIComponent(rawValue.join("="));
  }

  return jar;
};

/**
 * Serialize a cookie value for Moon auth session responses.
 *
 * @param {string} name
 * @param {string} value
 * @param {{httpOnly?: boolean, path?: string, maxAge?: number}} [options]
 * @returns {string}
 */
export const serializeCookie = (name, value, {httpOnly = true, path = "/", maxAge = 86400} = {}) => {
  const segments = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    "SameSite=Lax"
  ];

  if (httpOnly) {
    segments.push("HttpOnly");
  }

  return segments.join("; ");
};

export default {
  parseCookies,
  serializeCookie
};
