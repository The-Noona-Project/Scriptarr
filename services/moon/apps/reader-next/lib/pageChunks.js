"use client";

/**
 * @file Reader page-chunk state helpers.
 */

const REQUEST_TOKEN_SEPARATOR = "\u001f";

const toPositiveInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const clampIndex = (value, pageCount) => {
  const parsed = Number.parseInt(String(value), 10);
  const index = Number.isFinite(parsed) ? parsed : 0;
  return Math.max(0, Math.min(index, Math.max(0, pageCount - 1)));
};

const normalizeConnectionType = (value) => String(value || "").trim().toLowerCase();
const now = () => typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

/**
 * Resolve the reader's page warm-ahead budget for the current device.
 *
 * @param {{saveData?: boolean, effectiveType?: string, viewportWidth?: number, deviceMemory?: number}} [environment]
 * @returns {{aheadCount: number, previousCushion: number, profile: "conservative" | "standard"}}
 */
export const resolveReaderPreloadConfig = (environment = {}) => {
  const connectionType = normalizeConnectionType(environment.effectiveType);
  const constrainedNetwork = environment.saveData === true || ["slow-2g", "2g"].includes(connectionType);
  const constrainedViewport = Number.isFinite(environment.viewportWidth) && environment.viewportWidth > 0 && environment.viewportWidth <= 760;
  const constrainedMemory = Number.isFinite(environment.deviceMemory) && environment.deviceMemory > 0 && environment.deviceMemory <= 4;

  if (constrainedNetwork || constrainedViewport || constrainedMemory) {
    return {aheadCount: 4, previousCushion: 1, profile: "conservative"};
  }

  return {aheadCount: 10, previousCushion: 3, profile: "standard"};
};

/**
 * List the spread page indexes that must be ready before paged navigation lands.
 *
 * @param {{layoutMode?: string, pageIndex?: number, pageCount?: number}} [options]
 * @returns {number[]}
 */
export const resolvePagedReaderWindowIndexes = ({layoutMode = "single", pageIndex = 0, pageCount = 0} = {}) => {
  const total = toPositiveInteger(pageCount, 0);
  if (!total) {
    return [];
  }
  const active = clampIndex(pageIndex, total);
  const spreadSize = layoutMode === "double" || layoutMode === "manga-double" ? 2 : 1;
  const start = layoutMode === "single" ? active : Math.max(0, active - (active % spreadSize));
  return Array.from({length: Math.min(spreadSize, total - start)}, (_value, offset) => start + offset);
};

/**
 * Check whether a page window has loaded metadata with image URLs.
 *
 * @param {Array<{index?: number, src?: string}>} [pages]
 * @param {number[]} [indexes]
 * @returns {boolean}
 */
export const hasReaderPageImages = (pages = [], indexes = []) => {
  const byIndex = new Map(pages.map((page) => [page?.index, page]));
  return indexes.length > 0 && indexes.every((index) => {
    const page = byIndex.get(index);
    return Boolean(page?.src);
  });
};

/**
 * Merge reader page metadata by page index while preserving numeric page order.
 *
 * @param {Array<{index?: number}>} [current]
 * @param {Array<{index?: number}>} [incoming]
 * @returns {Array<{index?: number}>}
 */
export const mergeReaderPages = (current = [], incoming = []) => {
  const byIndex = new Map();
  for (const page of current) {
    if (Number.isInteger(page?.index)) {
      byIndex.set(page.index, page);
    }
  }
  for (const page of incoming) {
    if (Number.isInteger(page?.index)) {
      byIndex.set(page.index, page);
    }
  }
  return Array.from(byIndex.values()).sort((left, right) => left.index - right.index);
};

/**
 * Merge one completed page request into local state without letting a late
 * initial replacement erase newer chunks from the same page revision.
 *
 * @param {{currentPages?: Array<{index?: number}>, incomingPages?: Array<{index?: number}>, replace?: boolean, currentRevision?: string, nextRevision?: string}} options
 * @returns {Array<{index?: number}>}
 */
export const mergeReaderPageRequestPages = ({
  currentPages = [],
  incomingPages = [],
  replace = false,
  currentRevision = "",
  nextRevision = ""
} = {}) => {
  if (replace && currentRevision && nextRevision && currentRevision !== nextRevision) {
    return mergeReaderPages([], incomingPages);
  }
  return mergeReaderPages(currentPages, incomingPages);
};

/**
 * Check whether the locally loaded metadata covers a contiguous reader window.
 *
 * @param {Array<{index?: number}>} [pages]
 * @param {number} [start]
 * @param {number} [size]
 * @param {number} [pageCount]
 * @returns {boolean}
 */
export const hasReaderPageWindow = (pages = [], start = 0, size = 1, pageCount = 0) => {
  const indexes = new Set(pages.map((page) => page.index));
  const end = Math.min(Math.max(0, pageCount), start + size);
  for (let index = start; index < end; index += 1) {
    if (!indexes.has(index)) {
      return false;
    }
  }
  return end > start;
};

/**
 * Create a token for one concrete reader page metadata request.
 *
 * @param {{epoch?: number, chapterId: string, cursor?: string | number, pageSize?: number, pageRevision?: string, replace?: boolean, requestId?: string | number}} options
 * @returns {string}
 */
export const createReaderPageRequestToken = ({
  epoch = 0,
  chapterId,
  cursor = 0,
  pageSize = 1,
  pageRevision = "",
  replace = false,
  requestId = ""
}) => [
  epoch,
  chapterId,
  cursor,
  pageSize,
  pageRevision,
  replace ? "replace" : "append",
  requestId
].map((part) => String(part ?? "")).join(REQUEST_TOKEN_SEPARATOR);

/**
 * Mark one page request as in flight and return its completion token.
 *
 * @param {Set<string>} inFlight
 * @param {{epoch?: number, chapterId: string, cursor?: string | number, pageSize?: number, pageRevision?: string, replace?: boolean, requestId?: string | number}} options
 * @returns {string}
 */
export const beginReaderPageRequest = (inFlight, options) => {
  const token = createReaderPageRequestToken(options);
  inFlight.add(token);
  return token;
};

/**
 * Complete one page request without invalidating other chapter requests.
 *
 * @param {Set<string>} inFlight
 * @param {string} token
 * @returns {boolean}
 */
export const completeReaderPageRequest = (inFlight, token) => {
  if (!inFlight.has(token)) {
    return false;
  }
  inFlight.delete(token);
  return true;
};

/**
 * Check whether a chapter still has metadata requests in flight.
 *
 * @param {Set<string>} inFlight
 * @param {{epoch?: number, chapterId: string}} options
 * @returns {boolean}
 */
export const hasReaderPageRequestForChapter = (inFlight, {epoch = 0, chapterId}) => {
  const prefix = [epoch, chapterId].map((part) => String(part ?? "")).join(REQUEST_TOKEN_SEPARATOR) + REQUEST_TOKEN_SEPARATOR;
  for (const token of inFlight) {
    if (token.startsWith(prefix)) {
      return true;
    }
  }
  return false;
};

/**
 * Resolve page metadata and image warm-up work around the active reader page.
 *
 * @param {{layoutMode?: string, activeIndex?: number, pageCount?: number, loadedPages?: Array<{index?: number}>, chunkSize?: number, aheadCount?: number, previousCushion?: number}} options
 * @returns {{metadataRequests: Array<{cursor: number, pageSize: number}>, warmIndexes: number[], prefetchNextChapter: boolean}}
 */
export const resolveReaderPreloadPlan = ({
  layoutMode = "webtoon",
  activeIndex = 0,
  pageCount = 0,
  loadedPages = [],
  chunkSize = 12,
  aheadCount = 3,
  previousCushion = 1,
  scrollDirection = "forward"
} = {}) => {
  const total = toPositiveInteger(pageCount, 0);
  if (!total) {
    return {metadataRequests: [], warmIndexes: [], prefetchNextChapter: false};
  }
  const active = clampIndex(activeIndex, total);
  const isWebtoon = layoutMode === "webtoon";
  const metadataIndexes = [];
  const warmIndexes = [];

  if (isWebtoon) {
    const behindCount = scrollDirection === "backward" ? Math.max(previousCushion, aheadCount) : previousCushion;
    const forwardCount = scrollDirection === "backward" ? Math.max(1, previousCushion) : aheadCount;
    for (let index = active - behindCount; index < active; index += 1) {
      metadataIndexes.push(index);
      warmIndexes.push(index);
    }
    for (let index = active + 1; index <= active + forwardCount; index += 1) {
      metadataIndexes.push(index);
      warmIndexes.push(index);
    }
  } else {
    for (let index = active; index <= active + aheadCount; index += 1) {
      metadataIndexes.push(index);
      if (index > active) {
        warmIndexes.push(index);
      }
    }
  }

  const normalize = (indexes) => Array.from(new Set(indexes))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < total)
    .sort((left, right) => left - right);
  const loadedIndexes = new Set(loadedPages.map((page) => page?.index).filter(Number.isInteger));
  const missing = normalize(metadataIndexes).filter((index) => !loadedIndexes.has(index));
  const metadataRequests = [];
  if (missing.length) {
    const cursor = missing[0];
    const minimumSize = missing[missing.length - 1] - cursor + 1;
    metadataRequests.push({
      cursor,
      pageSize: Math.min(total - cursor, Math.max(toPositiveInteger(chunkSize, 1), minimumSize))
    });
  }

  return {
    metadataRequests,
    warmIndexes: normalize(warmIndexes),
    prefetchNextChapter: !isWebtoon && active + aheadCount >= total
  };
};

/**
 * Decode available page images ahead of the reader viewport.
 *
 * @param {Array<{index?: number, src?: string}>} pages
 * @param {number[]} indexes
 * @param {{imageFactory?: typeof Image, onMetric?: (event: Record<string, unknown>) => void}} [options]
 * @returns {Promise<Array<{index: number, ok: boolean}>>}
 */
export const warmReaderPageImages = async (pages = [], indexes = [], {imageFactory = globalThis.Image, onMetric = null} = {}) => {
  if (typeof imageFactory !== "function") {
    return [];
  }
  const wanted = new Set(indexes);
  const pageEntries = pages.filter((page) => Number.isInteger(page?.index) && wanted.has(page.index) && page.src);
  const results = await Promise.all(pageEntries.map((page) => new Promise((resolve) => {
    const image = new imageFactory();
    const startedAt = now();
    const finish = (ok) => resolve({index: page.index, ok});
    image.onload = () => {
      const imageLoadMs = now() - startedAt;
      onMetric?.({
        type: "image-stream-fetch",
        pageIndex: page.index,
        ok: true,
        durationMs: imageLoadMs
      });
      if (typeof image.decode === "function") {
        const decodeStartedAt = now();
        Promise.resolve(image.decode()).then(() => {
          onMetric?.({
            type: "image-decode",
            pageIndex: page.index,
            ok: true,
            durationMs: now() - decodeStartedAt,
            imageLoadMs
          });
          finish(true);
        }, () => {
          onMetric?.({
            type: "image-decode",
            pageIndex: page.index,
            ok: false,
            durationMs: now() - decodeStartedAt,
            imageLoadMs,
            reason: "decode_failed"
          });
          finish(false);
        });
        return;
      }
      finish(true);
    };
    image.onerror = () => {
      onMetric?.({
        type: "image-stream-fetch",
        pageIndex: page.index,
        ok: false,
        durationMs: now() - startedAt,
        reason: "image_error"
      });
      finish(false);
    };
    image.src = page.src;
  })));
  return results;
};

/**
 * Decide the next webtoon load-more action without treating "initial chunk is
 * still loading" as "there are no more pages."
 *
 * @param {{session?: any, entry?: {pageInfo?: any, loading?: boolean, error?: string}}} options
 * @returns {{ready: boolean, done: boolean, cursor?: string | number, replace?: boolean, nextChapterId?: string}}
 */
export const resolveWebtoonLoadMoreAction = ({session = null, entry = null} = {}) => {
  if (!session?.chapter?.id) {
    return {ready: false, done: false};
  }
  if (!entry || (entry.loading && !entry.pageInfo && !entry.error)) {
    return {ready: false, done: false};
  }
  if (entry.error && !entry.pageInfo) {
    return {ready: true, done: false, cursor: 0, replace: true};
  }
  if (entry.pageInfo?.hasMore) {
    return {ready: true, done: false, cursor: entry.pageInfo.nextCursor, replace: false};
  }
  if (session.nextChapterId) {
    return {ready: true, done: false, nextChapterId: session.nextChapterId};
  }
  return {ready: true, done: true};
};

export default {
  beginReaderPageRequest,
  completeReaderPageRequest,
  createReaderPageRequestToken,
  hasReaderPageWindow,
  hasReaderPageRequestForChapter,
  hasReaderPageImages,
  mergeReaderPageRequestPages,
  mergeReaderPages,
  resolvePagedReaderWindowIndexes,
  resolveReaderPreloadPlan,
  resolveReaderPreloadConfig,
  warmReaderPageImages,
  resolveWebtoonLoadMoreAction
};
