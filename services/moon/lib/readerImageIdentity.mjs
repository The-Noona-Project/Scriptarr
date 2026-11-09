/** @file Strict identities for logical-page segment and thumbnail cache variants. */

/**
 * Normalize selectors without allowing malformed queries to alias cached tile zero.
 * @param {Record<string,unknown>} [query] Express image query.
 * @returns {{segmentIndex:number,thumbnail:boolean,key:string}|null} Valid selectors.
 */
export const readerImageSelector = (query = {}) => {
  const rawSegment = query.segment ?? "0";
  const rawThumbnail = query.thumbnail ?? "false";
  if (typeof rawSegment !== "string" || !/^(0|[1-9][0-9]{0,8})$/.test(rawSegment)
    || typeof rawThumbnail !== "string" || !["true", "false"].includes(rawThumbnail)) return null;
  const segmentIndex = Number(rawSegment), thumbnail = rawThumbnail === "true";
  if (thumbnail && segmentIndex !== 0) return null;
  return {segmentIndex, thumbnail, key: `segment=${segmentIndex}&thumbnail=${thumbnail}`};
};

/**
 * Require an exact variant probe for new selectors while accepting legacy page probes.
 * @param {any} payload Sage-authorized page status.
 * @param {{segmentIndex:number,thumbnail:boolean}|null} selector Requested variant.
 * @returns {boolean} Whether the probe authorizes this exact variant.
 */
export const readerProbeMatchesSelector = (payload, selector) => Boolean(selector)
  && (selector.segmentIndex === 0 && !selector.thumbnail
    ? (payload?.segmentIndex == null || payload.segmentIndex === 0) && payload?.thumbnail !== true
    : payload?.segmentIndex === selector.segmentIndex && payload?.thumbnail === selector.thumbnail);

/**
 * Check streamed representation headers before accepting new variant bytes.
 * @param {Record<string,string>} headers Lowercase upstream response headers.
 * @param {{segmentIndex:number,thumbnail:boolean}|null} selector Requested variant.
 * @returns {boolean} Whether this response is the requested representation.
 */
export const readerResponseMatchesSelector = (headers, selector) => {
  if (!selector) return false;
  const segment = headers["x-scriptarr-segment-index"], thumbnail = headers["x-scriptarr-thumbnail"];
  if (selector.segmentIndex === 0 && !selector.thumbnail && segment == null && thumbnail == null) return true;
  return segment === String(selector.segmentIndex) && thumbnail === String(selector.thumbnail);
};
