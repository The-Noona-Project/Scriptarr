/** @file Viewport-local Webtoon tracking and user-cancellable logical seek anchors. */

/** @param {number} height Viewport height. @returns {{height:number,top:number,bottom:number,anchor:number}} Pixel reading band. */
export const webtoonReadingBand = (height) => {
  const size = Math.max(1, Number.isFinite(height) ? height : 1);
  return {height: size, top: size * 0.2, bottom: size * 0.45, anchor: size * 0.325};
};

/** @param {{pageIndex:number,pageCount:number,chunkSize?:number,previousCushion?:number,aheadCount?:number}} input Saved or explicitly sought logical page. @returns {{pageIndex:number,cursor:number,pageSize:number}} Bounded metadata window, including the target and its preload cushion. */
export const webtoonSeekWindow = ({pageIndex, pageCount, chunkSize = 18, previousCushion = 3, aheadCount = 10}) => {
  const count = Math.max(1, Number.parseInt(String(pageCount || 1), 10) || 1);
  const index = Math.max(0, Math.min(count - 1, Number.parseInt(String(pageIndex || 0), 10) || 0));
  const cursor = Math.max(0, index - previousCushion);
  return {pageIndex: index, cursor, pageSize: Math.min(count - cursor, Math.max(chunkSize, index - cursor + aheadCount + 1))};
};

/** @param {Set<any>} candidates Full currently intersecting set. @param {any[]} entries Changed observer entries. @returns {void} */
export const updateWebtoonCandidates = (candidates, entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) candidates.add(entry.target);
    else candidates.delete(entry.target);
  }
};

/** @param {any} target Page element. @param {number} viewportHeight Viewport height. @returns {any|null} Current visible logical page geometry. */
export const visibleWebtoonPage = (target, viewportHeight) => {
  if (!target || target.isConnected === false) return null;
  const rect = target.getBoundingClientRect();
  const chapterId = target.dataset?.chapterId || "";
  const pageIndex = Number(target.dataset?.pageIndex);
  if (!chapterId || !Number.isSafeInteger(pageIndex) || pageIndex < 0 || !Number.isFinite(rect.top)
    || !Number.isFinite(rect.bottom) || rect.bottom <= rect.top || rect.bottom <= 0 || rect.top >= viewportHeight) return null;
  return {target, chapterId, pageIndex, top: rect.top, bottom: rect.bottom};
};

/** @param {Iterable<any>} candidates Only viewport-intersecting elements. @param {number} viewportHeight Viewport height. @returns {any|null} Logical page nearest the pixel reading line. */
export const selectWebtoonPage = (candidates, viewportHeight) => {
  const band = webtoonReadingBand(viewportHeight);
  let chosen = null;
  let bestDistance = Infinity;
  let bestCenter = Infinity;
  for (const target of candidates) {
    const page = visibleWebtoonPage(target, band.height);
    if (!page) continue;
    const distance = Math.max(page.top - band.anchor, band.anchor - page.bottom, 0);
    const center = Math.abs((page.top + page.bottom) / 2 - band.anchor);
    if (distance < bestDistance || (distance === bestDistance && center < bestCenter)) {
      bestDistance = distance; bestCenter = center; chosen = page;
    }
  }
  return chosen;
};

/** @param {{chapterId:string,pageIndex:number}} request Explicit logical seek. @returns {any} Per-request stabilization state, retained passively after completion. */
export const createWebtoonSeekAnchor = (request) => ({request, stableFrames: 0, top: null, height: null});

/**
 * Align only the sought element. Retain the same anchor for later metadata insertion until user intent cancels it.
 * @param {any} anchor Per-request state.
 * @param {{findPage:Function,viewportHeight:number,scrollBy:Function,getScrollY:Function,getMaxScrollY:Function,metadataLoading?:boolean}} context Live geometry and scrolling.
 * @returns {{found:boolean,settled:boolean}} Whether the request can leave its preparing state.
 */
export const alignWebtoonSeekAnchor = (anchor, {findPage, viewportHeight, scrollBy, getScrollY, getMaxScrollY, metadataLoading = false}) => {
  const target = findPage(anchor.request);
  if (!target) { anchor.stableFrames = 0; return {found: false, settled: false}; }
  const band = webtoonReadingBand(viewportHeight);
  const before = target.getBoundingClientRect();
  if (!Number.isFinite(before.top) || !Number.isFinite(before.height) || before.height <= 0) return {found: false, settled: false};
  const offset = Math.min(before.height / 2, (band.bottom - band.top) / 2);
  const delta = before.top + offset - band.anchor;
  if (Math.abs(delta) > 1) scrollBy({top: delta, behavior: "instant"});
  const after = target.getBoundingClientRect();
  const remaining = after.top + Math.min(after.height / 2, (band.bottom - band.top) / 2) - band.anchor;
  const boundary = remaining < 0 ? getScrollY() <= 1 : getScrollY() >= getMaxScrollY() - 1;
  const aligned = Math.abs(remaining) <= 1 || (boundary && after.bottom > 0 && after.top < band.height);
  const stable = anchor.top !== null && Math.abs(after.top - anchor.top) <= 1 && Math.abs(after.height - anchor.height) <= 1;
  anchor.stableFrames = !metadataLoading && aligned ? (stable ? anchor.stableFrames + 1 : 1) : 0;
  anchor.top = after.top;
  anchor.height = after.height;
  return {found: true, settled: anchor.stableFrames >= 2};
};

/** @param {{type?:string,key?:string}} event Captured user event. @returns {boolean} Whether this user intent cancels an automatic seek anchor. */
export const cancelsWebtoonSeek = (event) => ["wheel", "touchstart", "pointerdown"].includes(event.type)
  || (event.type === "keydown" && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " ", "Escape"].includes(event.key));
