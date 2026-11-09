/** @file Reconcile reader metadata without treating a live refresh as a new reading session. */

/** @param {{userId?:string,titleId?:string,chapterId?:string}} route Requested route and authenticated identity. @returns {string} Stable route scope. */
export const readerRouteKey = ({userId = "", titleId = "", chapterId = ""} = {}) => JSON.stringify([userId, titleId, chapterId]);

/** @param {any} session Reader session. @returns {string} Content identity independent of progress and preferences. */
export const readerSessionContentKey = (session) => JSON.stringify([
  session?.title?.id || "", session?.chapter?.id || "", session?.pageRevision || "",
  Math.max(1, Number.parseInt(String(session?.pageCount || session?.chapter?.pageCount || 1), 10) || 1)
]);

/** @param {number} index Current logical index. @param {number} count New logical count. @returns {number} Bounded index. */
const clampIndex = (index, count) => Math.max(0, Math.min(Math.max(1, count) - 1, index));

/**
 * Distinguish bootstrap, metadata-only refresh and one changed chapter.
 * @param {{previous?:any,routeKey:string,session:any,activeChapterId:string,activePageIndex:number,pagedChapterId:string,pagedPageIndex:number}} input Current route and reading position.
 * @returns {{kind:string,chapterId:string,activePageIndex:number,pagedPageIndex:number}} Scoped update plan.
 */
export const planReaderSessionRefresh = ({previous, routeKey, session, activeChapterId, activePageIndex, pagedChapterId, pagedPageIndex}) => {
  const chapterId = session.chapter.id;
  const result = {kind: "bootstrap", chapterId, activePageIndex, pagedPageIndex};
  if (!previous || previous.routeKey !== routeKey || previous.session?.title?.id !== session.title?.id
    || previous.session?.chapter?.id !== chapterId) return result;
  if (readerSessionContentKey(previous.session) === readerSessionContentKey(session)) return {...result, kind: "retain"};
  const count = Math.max(1, Number.parseInt(String(session.pageCount || 1), 10) || 1);
  return {...result, kind: "invalidate", activePageIndex: activeChapterId === chapterId ? clampIndex(activePageIndex, count) : activePageIndex,
    pagedPageIndex: pagedChapterId === chapterId ? clampIndex(pagedPageIndex, count) : pagedPageIndex};
};

/** @param {Map<string,any>} current Loaded chapter sessions. @param {any} session Fresh metadata. @returns {Map<string,any>} Merge retaining unrelated chapter objects. */
export const mergeReaderSessionMetadata = (current, session) => new Map(current).set(session.chapter.id, session);

/** @param {Map<string,any>} current Loaded page windows. @param {string} chapterId Invalidated chapter. @returns {Map<string,any>} Windows retaining unrelated chapters. */
export const dropReaderChapterPages = (current, chapterId) => {
  const next = new Map(current); next.delete(chapterId); return next;
};

/** @param {any[]} current Current bookmarks. @param {any} session Refreshed canonical scope. @param {{titleId?:string,chapterId?:string}} requested Requested aliases. @returns {any[]} Scoped bookmarks retaining unrelated chapters. */
export const mergeReaderSessionBookmarks = (current, session, requested = {}) => {
  const titles = new Set([session.title?.id, requested.titleId].filter(Boolean));
  const chapters = new Set([session.chapter.id, requested.chapterId].filter(Boolean));
  const incoming = new Map((Array.isArray(session.bookmarks) ? session.bookmarks : [])
    .map((entry) => [entry.id || JSON.stringify([entry.titleId, entry.chapterId, entry.pageIndex]), entry]));
  return [...current.filter((entry) => !titles.has(entry.titleId) || !chapters.has(entry.chapterId)), ...incoming.values()];
};

/**
 * Cancel only stale work for the affected chapter, preserving other decoded pages.
 * @param {{chapterId:string,sessionCache:Map<string,any>,warmState:Map<string,any>}} input Local caches.
 * @returns {void}
 */
export const clearReaderChapterCaches = ({chapterId, sessionCache, warmState}) => {
  sessionCache.delete(chapterId);
  for (const [key, entry] of warmState) if (entry?.chapterId === chapterId) {
    entry.controller?.abort?.(); warmState.delete(key);
  }
};

/** @param {Map<string,string>} versions Current chapter content identities. @param {any} session Captured session. @returns {boolean} Whether captured work still belongs to current content. */
export const isReaderSessionCurrent = (versions, session) => versions.get(session?.chapter?.id) === readerSessionContentKey(session);

/** @param {string} chapterId Target chapter. @param {number} pageIndex Logical page. @returns {{chapterId:string,pageIndex:number}} New observable request even for repeated seeks. */
export const createReaderSeekRequest = (chapterId, pageIndex) => ({chapterId, pageIndex});

/**
 * Consume a seek only after its actual target exists; metadata arrival can retry the same request.
 * @param {any} request Pending logical seek.
 * @param {{activeChapterId:string,isPaged:boolean,findPage:Function}} context Current stage and DOM lookup.
 * @returns {boolean} Whether a visible scroll was requested.
 */
export const applyReaderSeekRequest = (request, {activeChapterId, isPaged, findPage}) => {
  if (!request || isPaged || request.chapterId !== activeChapterId) return false;
  const target = findPage(request);
  if (!target) return false;
  target.scrollIntoView({block: "center", behavior: "smooth"}); return true;
};
