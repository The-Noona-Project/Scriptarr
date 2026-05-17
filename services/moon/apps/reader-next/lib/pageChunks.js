"use client";

/**
 * @file Reader page-chunk state helpers.
 */

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
  hasReaderPageWindow,
  mergeReaderPages,
  resolveWebtoonLoadMoreAction
};
