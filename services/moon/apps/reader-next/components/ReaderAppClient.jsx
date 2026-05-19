"use client";

/**
 * @file Fullscreen reader client backed by split session and page-chunk APIs.
 */

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {loadMoonChromeContext, loadMoonLoginUrl, requestJson, useMoonJson} from "../lib/api.js";
import {
  READER_INPUT_ACTIONS,
  createReaderInputState,
  resolveGamepadActions,
  resolveKeyboardAction,
  resolvePointerSwipe
} from "../lib/inputController.js";
import {
  beginReaderPageRequest,
  completeReaderPageRequest,
  hasReaderPageImages,
  hasReaderPageWindow,
  hasReaderPageRequestForChapter,
  mergeReaderPageRequestPages,
  resolvePagedReaderWindowIndexes,
  resolveReaderPreloadConfig,
  resolveReaderPreloadPlan,
  resolveWebtoonLoadMoreAction,
  warmReaderPageImages
} from "../lib/pageChunks.js";
import {buildReaderPath, buildReaderPathForTitle} from "../lib/routes.js";
import {countDecodedReaderPages, readerTelemetryNow, recordReaderTelemetry} from "../lib/readerTelemetry.js";
import ReaderControls from "./ReaderControls.jsx";
import ReaderSettings from "./ReaderSettings.jsx";
import ReaderStage from "./ReaderStage.jsx";
import {ReaderInitialSkeleton} from "./ReaderSkeleton.jsx";

const PAGE_CHUNK_SIZE = 18;
const CHAPTER_RAIL_PAGE_SIZE = 60;
const WARM_IMAGE_CONCURRENCY = 4;
const DEFAULT_PRELOAD_CONFIG = resolveReaderPreloadConfig();
const PAGE_FITS = ["width", "height", "contain"];
const DIRECTIONS = ["ltr", "rtl"];

const normalizeLayoutMode = (value) => ["single", "double", "manga-double", "webtoon"].includes(value) ? value : "webtoon";
const pagesPerStep = (layoutMode) => layoutMode === "double" || layoutMode === "manga-double" ? 2 : 1;
const pageRatio = (pageIndex, pageCount) => pageIndex / Math.max(1, Math.max(1, pageCount) - 1);
const clampPage = (value, pageCount) => Math.max(0, Math.min(value, Math.max(0, pageCount - 1)));
const cssEscape = (value) => globalThis.CSS?.escape?.(String(value)) || String(value).replace(/"/g, "\\\"");

const sessionUrlFor = (titleId, chapterId) =>
  `/api/moon-v3/user/reader/title/${encodeURIComponent(titleId)}/chapter/${encodeURIComponent(chapterId)}/session`;

const pagesUrlFor = (titleId, chapterId, {cursor = 0, pageSize = PAGE_CHUNK_SIZE, rev = ""} = {}) => {
  const params = new URLSearchParams({
    cursor: String(cursor),
    pageSize: String(pageSize)
  });
  if (rev) {
    params.set("rev", rev);
  }
  return `/api/moon-v3/user/reader/title/${encodeURIComponent(titleId)}/chapter/${encodeURIComponent(chapterId)}/pages?${params.toString()}`;
};

const chapterRowsUrlFor = (titleId, cursor = "") => {
  const params = new URLSearchParams({
    pageSize: String(CHAPTER_RAIL_PAGE_SIZE),
    sort: "number-desc"
  });
  if (cursor) {
    params.set("cursor", cursor);
  }
  return `/api/moon-v3/user/title/${encodeURIComponent(titleId)}/chapters?${params.toString()}`;
};

const mergeChapterRows = (current = [], incoming = []) => {
  const byId = new Map();
  for (const chapter of current) {
    if (chapter?.id) {
      byId.set(chapter.id, chapter);
    }
  }
  for (const chapter of incoming) {
    if (chapter?.id) {
      byId.set(chapter.id, chapter);
    }
  }
  return Array.from(byId.values());
};

const normalizeBootSession = (session) => session?.chapter?.id ? session : null;

const bootLayoutModeFor = (session) => {
  const preferences = session?.preferences || {};
  return normalizeLayoutMode(preferences.layoutMode || (preferences.readingMode === "paged" ? "single" : "webtoon"));
};

const bootBookmarkPageFor = (session) => clampPage(
  Number.isInteger(session?.progress?.bookmark?.pageIndex) ? session.progress.bookmark.pageIndex : 0,
  session?.pageCount || 1
);

const createBootPageState = (session, pagesPayload) => {
  if (!session?.chapter?.id || !Array.isArray(pagesPayload?.pages) || !pagesPayload.pages.length) {
    return new Map();
  }
  return new Map([[session.chapter.id, {
    pages: pagesPayload.pages,
    pageInfo: pagesPayload.pageInfo || null,
    loading: false,
    error: "",
    pageRevision: pagesPayload.pageRevision || session.pageRevision || ""
  }]]);
};

const runWarmImageJobs = async (jobs = []) => {
  const results = [];
  let cursor = 0;
  const workers = Array.from({length: Math.min(WARM_IMAGE_CONCURRENCY, jobs.length)}, async () => {
    while (cursor < jobs.length) {
      const jobIndex = cursor;
      cursor += 1;
      results[jobIndex] = await jobs[jobIndex]();
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
};

/**
 * Render the dedicated fullscreen reader app for one title chapter.
 *
 * @param {{titleId: string, chapterId: string, typeSlug?: string, initialSessionData?: any, initialPagesData?: any}} props
 * @returns {import("react").ReactNode}
 */
export const ReaderAppClient = ({titleId, chapterId, typeSlug = "", initialSessionData = null, initialPagesData = null}) => {
  const bootSession = normalizeBootSession(initialSessionData);
  const bootChapterId = bootSession?.chapter?.id || chapterId;
  const bootLayoutMode = bootLayoutModeFor(bootSession);
  const bootBookmarkPage = bootBookmarkPageFor(bootSession);
  const bootPageState = createBootPageState(bootSession, initialPagesData);
  const {
    loading,
    refreshing,
    error,
    status,
    data: initialSession
  } = useMoonJson(sessionUrlFor(titleId, chapterId), {
    fallback: bootSession,
    deps: [titleId, chapterId],
    keepPreviousData: true,
    telemetry: {type: "session-fetch", titleId, chapterId}
  });
  const [chrome, setChrome] = useState({auth: null, loginUrl: "", branding: {siteName: "Scriptarr"}});
  const [layoutMode, setLayoutMode] = useState(bootLayoutMode);
  const [readingDirection, setReadingDirection] = useState(DIRECTIONS.includes(bootSession?.preferences?.readingDirection) ? bootSession.preferences.readingDirection : "ltr");
  const [pageFit, setPageFit] = useState(PAGE_FITS.includes(bootSession?.preferences?.pageFit) ? bootSession.preferences.pageFit : "width");
  const [showSidebar, setShowSidebar] = useState(bootSession?.preferences?.showSidebar === true);
  const [showPageNumbers, setShowPageNumbers] = useState(bootSession?.preferences?.showPageNumbers !== false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [sessionMap, setSessionMap] = useState(() => bootSession ? new Map([[bootSession.chapter.id, bootSession]]) : new Map());
  const [pageState, setPageState] = useState(() => bootPageState);
  const [webtoonChapterIds, setWebtoonChapterIds] = useState(() => bootSession ? [bootSession.chapter.id] : []);
  const [bookmarks, setBookmarks] = useState(() => Array.isArray(bootSession?.bookmarks) ? bootSession.bookmarks : []);
  const [activeChapterId, setActiveChapterId] = useState(bootChapterId);
  const [activePageIndex, setActivePageIndex] = useState(bootLayoutMode === "webtoon" ? 0 : bootBookmarkPage);
  const [pagedChapterId, setPagedChapterId] = useState(bootChapterId);
  const [pagedPageIndex, setPagedPageIndex] = useState(bootBookmarkPage);
  const [chapterRows, setChapterRows] = useState([]);
  const [chapterPageInfo, setChapterPageInfo] = useState(null);
  const [chapterRowsLoading, setChapterRowsLoading] = useState(false);
  const [preloadConfig, setPreloadConfig] = useState(DEFAULT_PRELOAD_CONFIG);
  const [preparingMessage, setPreparingMessage] = useState("");
  const sessionCache = useRef(new Map());
  const pageStateRef = useRef(pageState);
  const pageRequestTokensRef = useRef(new Set());
  const pageRequestSeqRef = useRef(0);
  const pageLoadEpochRef = useRef(0);
  const imageWarmStateRef = useRef(new Map());
  const pageObserverRef = useRef(/** @type {IntersectionObserver | null} */ (null));
  const pointerStartRef = useRef(/** @type {{x: number, y: number} | null} */ (null));
  const inputStateRef = useRef(createReaderInputState());
  const settingsRef = useRef(/** @type {HTMLElement | null} */ (null));
  const pendingScrollRef = useRef(null);
  const scrollDirectionRef = useRef("forward");
  const activeWebtoonPageRef = useRef({chapterId: bootChapterId, pageIndex: 0});
  const bootPagesPendingRef = useRef(bootPageState.size > 0);

  const siteName = chrome.branding?.siteName || "Scriptarr";
  const title = initialSession?.title || null;
  const isPaged = layoutMode !== "webtoon";
  const currentPagedSession = sessionMap.get(pagedChapterId) || initialSession;
  const activeSession = sessionMap.get(activeChapterId) || currentPagedSession || initialSession;
  const activePageCount = Math.max(1, Number.parseInt(String(activeSession?.pageCount || 1), 10) || 1);
  const activePageDisplayIndex = isPaged ? pagedPageIndex : activePageIndex;
  const currentPageEntry = pageState.get(pagedChapterId) || {pages: [], pageInfo: null, loading: false, error: ""};
  const lastWebtoonChapterId = webtoonChapterIds[webtoonChapterIds.length - 1] || "";
  const lastWebtoonSession = lastWebtoonChapterId ? sessionMap.get(lastWebtoonChapterId) : null;
  const lastWebtoonEntry = lastWebtoonChapterId ? pageState.get(lastWebtoonChapterId) : null;
  const lastWebtoonLoadAction = resolveWebtoonLoadMoreAction({
    session: lastWebtoonSession,
    entry: lastWebtoonEntry
  });
  const webtoonLoadMoreReady = !isPaged && lastWebtoonLoadAction.ready && !lastWebtoonLoadAction.done;
  const webtoonLoadMoreKey = [
    lastWebtoonChapterId,
    lastWebtoonSession?.pageRevision || "",
    lastWebtoonEntry?.pageInfo?.nextCursor || "",
    lastWebtoonEntry?.error || ""
  ].join(":");
  const spreadSize = pagesPerStep(layoutMode);
  const spreadStart = layoutMode === "single" ? pagedPageIndex : Math.max(0, pagedPageIndex - (pagedPageIndex % spreadSize));
  const spreadDirection = layoutMode === "manga-double" || readingDirection === "rtl" ? "rtl" : "ltr";
  const visualRtl = layoutMode === "manga-double" || readingDirection === "rtl";

  const spreadPages = useMemo(() => {
    const byIndex = new Map(currentPageEntry.pages.map((page) => [page.index, page]));
    const total = Math.max(1, Number.parseInt(String(currentPagedSession?.pageCount || 1), 10) || 1);
    return Array.from({length: Math.min(spreadSize, Math.max(1, total - spreadStart))}, (_value, offset) => {
      const index = spreadStart + offset;
      return byIndex.get(index) || {index, missing: true, label: `Page ${index + 1}`};
    });
  }, [currentPageEntry.pages, currentPagedSession?.pageCount, spreadSize, spreadStart]);

  const webtoonChapters = useMemo(() =>
    webtoonChapterIds.map((id) => {
      const session = sessionMap.get(id);
      const pages = pageState.get(id);
      return session ? {
        ...session,
        pages: pages?.pages || [],
        loading: pages?.loading || false,
        error: pages?.error || ""
      } : null;
    }).filter(Boolean), [pageState, sessionMap, webtoonChapterIds]);

  const setSession = useCallback((session) => {
    if (!session?.chapter?.id) {
      return;
    }
    setSessionMap((current) => new Map(current).set(session.chapter.id, session));
  }, []);

  const setReaderPageState = useCallback((updater) => {
    setPageState((current) => {
      const next = updater(current);
      pageStateRef.current = next;
      return next;
    });
  }, []);

  const fetchSession = useCallback(async (nextChapterId) => {
    const key = String(nextChapterId || "").trim();
    if (!key) {
      return null;
    }
    const existing = sessionMap.get(key);
    if (existing) {
      return existing;
    }
    const cached = sessionCache.current.get(key);
    if (cached) {
      return cached;
    }
    const promise = requestJson(sessionUrlFor(titleId, key), {
      telemetry: {type: "session-fetch", titleId, chapterId: key}
    }).then((result) => {
      if (!result.ok) {
        throw new Error(result.payload?.error || "Could not load that chapter.");
      }
      setSession(result.payload);
      return result.payload;
    });
    sessionCache.current.set(key, promise);
    return promise;
  }, [sessionMap, setSession, titleId]);

  const loadPages = useCallback(async (session, {cursor = 0, replace = false, pageSize = PAGE_CHUNK_SIZE} = {}) => {
    if (!session?.chapter?.id) {
      return null;
    }
    const key = session.chapter.id;
    const requestEpoch = pageLoadEpochRef.current;
    pageRequestSeqRef.current += 1;
    const requestToken = beginReaderPageRequest(pageRequestTokensRef.current, {
      epoch: requestEpoch,
      chapterId: key,
      cursor,
      pageSize,
      pageRevision: session.pageRevision || "",
      replace,
      requestId: pageRequestSeqRef.current
    });
    setReaderPageState((current) => {
      const next = new Map(current);
      const entry = next.get(key) || {pages: [], pageInfo: null, loading: false, error: ""};
      next.set(key, {...entry, loading: true, error: ""});
      return next;
    });

    const result = await requestJson(pagesUrlFor(titleId, key, {
      cursor,
      pageSize,
      rev: session.pageRevision || ""
    }), {
      telemetry: {
        type: "page-chunk-fetch",
        titleId,
        chapterId: key,
        cursor,
        pageSize
      }
    });
    if (!completeReaderPageRequest(pageRequestTokensRef.current, requestToken)) {
      return null;
    }
    const stillLoading = hasReaderPageRequestForChapter(pageRequestTokensRef.current, {
      epoch: requestEpoch,
      chapterId: key
    });
    if (!result.ok) {
      setReaderPageState((current) => {
        const next = new Map(current);
        const entry = next.get(key) || {pages: [], pageInfo: null, loading: false, error: ""};
        next.set(key, {...entry, loading: stillLoading, error: result.payload?.error || "Could not load these pages."});
        return next;
      });
      return null;
    }

    setReaderPageState((current) => {
      const next = new Map(current);
      const entry = next.get(key) || {pages: [], pageInfo: null, loading: false, error: ""};
      const pageRevision = result.payload.pageRevision || session.pageRevision || "";
      next.set(key, {
        pages: mergeReaderPageRequestPages({
          currentPages: entry.pages,
          incomingPages: result.payload.pages || [],
          replace,
          currentRevision: entry.pageRevision || "",
          nextRevision: pageRevision
        }),
        pageInfo: result.payload.pageInfo || null,
        loading: stillLoading,
        error: "",
        pageRevision
      });
      return next;
    });
    return result.payload;
  }, [setReaderPageState, titleId]);

  const ensurePageWindow = useCallback(async (nextChapterId, nextPageIndex, nextSession = null) => {
    const session = nextSession || await fetchSession(nextChapterId);
    if (!session) {
      return;
    }
    const pageCount = Math.max(1, Number.parseInt(String(session.pageCount || 1), 10) || 1);
    const start = Math.max(0, Math.min(nextPageIndex, pageCount - 1));
    const alignedStart = layoutMode === "single" ? start : Math.max(0, start - (start % pagesPerStep(layoutMode)));
    const entry = pageStateRef.current.get(session.chapter.id);
    const plan = resolveReaderPreloadPlan({
      layoutMode,
      activeIndex: alignedStart,
      pageCount,
      loadedPages: entry?.pages || [],
      chunkSize: PAGE_CHUNK_SIZE,
      aheadCount: PAGE_CHUNK_SIZE - 1,
      previousCushion: 0
    });
    if (!plan.metadataRequests.length || entry?.loading) {
      return;
    }
    await Promise.all(plan.metadataRequests.map((request) =>
      loadPages(session, {cursor: request.cursor, pageSize: request.pageSize})
    ));
  }, [fetchSession, layoutMode, loadPages]);

  const warmPageImages = useCallback(async (session, indexes = [], {retryFailures = false} = {}) => {
    if (!session?.chapter?.id || !indexes.length) {
      return [];
    }
    const entry = pageStateRef.current.get(session.chapter.id);
    if (!entry?.pages?.length) {
      return [];
    }
    const warmJobs = indexes.map((index) => {
      const page = entry.pages.find((candidate) => candidate.index === index && candidate.src);
      if (!page) {
        return null;
      }
      return () => {
        const warmKey = `${session.chapter.id}:${page.index}:${page.src}`;
        const current = imageWarmStateRef.current.get(warmKey);
        if (current?.status === "ready") {
          return Promise.resolve({index: page.index, ok: true, cached: true});
        }
        if (current?.status === "loading" && current.promise) {
          return current.promise;
        }
        if (current?.status === "error" && !retryFailures) {
          return Promise.resolve({index: page.index, ok: false, cached: true});
        }
        const promise = warmReaderPageImages([page], [page.index], {
          onMetric: (metric) => recordReaderTelemetry({
            ...metric,
            titleId: title?.id || "",
            chapterId: session.chapter.id,
            layoutMode
          })
        }).then((results) => {
          const result = results[0] || {index: page.index, ok: false};
          imageWarmStateRef.current.set(warmKey, {
            status: result.ok ? "ready" : "error",
            chapterId: session.chapter.id,
            pageIndex: page.index,
            updatedAt: Date.now()
          });
          return result;
        }, () => {
          imageWarmStateRef.current.set(warmKey, {
            status: "error",
            chapterId: session.chapter.id,
            pageIndex: page.index,
            updatedAt: Date.now()
          });
          return {index: page.index, ok: false};
        });
        imageWarmStateRef.current.set(warmKey, {
          status: "loading",
          chapterId: session.chapter.id,
          pageIndex: page.index,
          promise,
          updatedAt: Date.now()
        });
        return promise;
      };
    }).filter(Boolean);

    return runWarmImageJobs(warmJobs);
  }, [layoutMode, title?.id]);

  const waitForPageImageMetadata = useCallback((session, indexes = [], {timeoutMs = 5000} = {}) => new Promise((resolve) => {
    if (!session?.chapter?.id || !indexes.length) {
      resolve(false);
      return;
    }
    const startedAt = Date.now();
    const tick = () => {
      const entry = pageStateRef.current.get(session.chapter.id);
      if (hasReaderPageImages(entry?.pages || [], indexes)) {
        resolve(true);
        return;
      }
      if (!entry?.loading || Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      window.setTimeout(tick, 50);
    };
    tick();
  }), []);

  const preparePagedPage = useCallback(async (session, pageIndex, {message = "Preparing page."} = {}) => {
    if (!session?.chapter?.id) {
      return false;
    }
    const pageCount = Math.max(1, Number.parseInt(String(session.pageCount || 1), 10) || 1);
    const indexes = resolvePagedReaderWindowIndexes({layoutMode, pageIndex, pageCount});
    if (!indexes.length) {
      return false;
    }
    const startedAt = readerTelemetryNow();
    let ready = false;
    let reason = "ready";
    setPreparingMessage(message);
    try {
      await ensurePageWindow(session.chapter.id, indexes[0], session);
      if (!await waitForPageImageMetadata(session, indexes)) {
        reason = "metadata_unavailable";
        return false;
      }
      const results = await warmPageImages(session, indexes, {retryFailures: true});
      ready = indexes.every((index) => results.some((result) => result.index === index && result.ok));
      reason = ready ? "ready" : "decode_unavailable";
      return ready;
    } finally {
      const durationMs = readerTelemetryNow() - startedAt;
      if (!ready || durationMs >= 250) {
        recordReaderTelemetry({
          type: "caught-buffer",
          titleId: title?.id || "",
          chapterId: session.chapter.id,
          layoutMode,
          pageIndex,
          activeIndex: pageIndex,
          pageCount,
          durationMs,
          ok: ready,
          reason,
          phase: message
        });
      }
      setPreparingMessage("");
    }
  }, [ensurePageWindow, layoutMode, title?.id, waitForPageImageMetadata, warmPageImages]);

  useEffect(() => {
    let active = true;
    const returnTo = typeof window === "undefined" ? "/reader" : `${window.location.pathname}${window.location.search}`;
    void loadMoonChromeContext(returnTo).then((nextValue) => {
      if (!active) {
        return;
      }
      setChrome((current) => ({...current, ...nextValue}));
      if (!nextValue.auth) {
        void loadMoonLoginUrl(returnTo).then((loginUrl) => {
          if (active && loginUrl) {
            setChrome((current) => ({...current, loginUrl}));
          }
        });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
    const readEnvironment = () => ({
      saveData: connection.saveData === true,
      effectiveType: connection.effectiveType || "",
      viewportWidth: window.innerWidth,
      deviceMemory: navigator.deviceMemory || 0
    });
    const updatePreloadConfig = () => setPreloadConfig(resolveReaderPreloadConfig(readEnvironment()));
    updatePreloadConfig();
    window.addEventListener("resize", updatePreloadConfig);
    connection.addEventListener?.("change", updatePreloadConfig);
    return () => {
      window.removeEventListener("resize", updatePreloadConfig);
      connection.removeEventListener?.("change", updatePreloadConfig);
    };
  }, []);

  useEffect(() => {
    if (!initialSession?.chapter?.id) {
      return;
    }
    const preferences = initialSession.preferences || {};
    const nextLayoutMode = normalizeLayoutMode(preferences.layoutMode || (preferences.readingMode === "paged" ? "single" : "webtoon"));
    const bookmarkPage = clampPage(
      Number.isInteger(initialSession?.progress?.bookmark?.pageIndex) ? initialSession.progress.bookmark.pageIndex : 0,
      initialSession.pageCount || 1
    );
    const hydratedBootPageState = bootPagesPendingRef.current ? createBootPageState(initialSession, initialPagesData) : new Map();
    const hasHydratedBootPages = hydratedBootPageState.size > 0;
    bootPagesPendingRef.current = false;
    sessionCache.current.clear();
    pageLoadEpochRef.current += 1;
    pageRequestTokensRef.current.clear();
    imageWarmStateRef.current.clear();
    setSessionMap(new Map([[initialSession.chapter.id, initialSession]]));
    setReaderPageState(() => hydratedBootPageState);
    setWebtoonChapterIds([initialSession.chapter.id]);
    setBookmarks(Array.isArray(initialSession.bookmarks) ? initialSession.bookmarks : []);
    setLayoutMode(nextLayoutMode);
    setReadingDirection(DIRECTIONS.includes(preferences.readingDirection) ? preferences.readingDirection : "ltr");
    setPageFit(PAGE_FITS.includes(preferences.pageFit) ? preferences.pageFit : "width");
    setShowSidebar(preferences.showSidebar === true);
    setShowPageNumbers(preferences.showPageNumbers !== false);
    setActiveChapterId(initialSession.chapter.id);
    activeWebtoonPageRef.current = {chapterId: initialSession.chapter.id, pageIndex: 0};
    scrollDirectionRef.current = "forward";
    setActivePageIndex(nextLayoutMode === "webtoon" ? 0 : bookmarkPage);
    setPagedChapterId(initialSession.chapter.id);
    setPagedPageIndex(bookmarkPage);
    const firstCursor = nextLayoutMode === "webtoon" ? 0 : Math.max(0, bookmarkPage - (bookmarkPage % pagesPerStep(nextLayoutMode)));
    if (!hasHydratedBootPages || firstCursor > 0) {
      void loadPages(initialSession, {cursor: firstCursor, replace: true});
    }
  }, [initialPagesData, initialSession, loadPages, setReaderPageState]);

  useEffect(() => {
    if (!title || !activeChapterId) {
      return;
    }
    const nextPath = buildReaderPath(title.libraryTypeSlug || title.mediaType || typeSlug || "manga", title.id, activeChapterId);
    if (window.location.pathname !== nextPath) {
      window.history.replaceState(null, "", nextPath);
    }
  }, [activeChapterId, title, typeSlug]);

  useEffect(() => {
    if (!title || !activeSession?.chapter?.id) {
      return;
    }
    const pageCount = Math.max(1, Number.parseInt(String(activeSession.pageCount || 1), 10) || 1);
    const pageIndex = clampPage(activePageDisplayIndex, pageCount);
    const timer = setTimeout(() => {
      void requestJson("/api/moon-v3/user/reader/progress", {
        method: "PUT",
        json: {
          mediaId: title.id,
          chapterLabel: activeSession.chapter?.label || "Chapter",
          positionRatio: pageRatio(pageIndex, pageCount),
          bookmark: {
            titleId: title.id,
            chapterId: activeSession.chapter.id,
            pageIndex
          }
        }
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [activePageDisplayIndex, activeSession, title]);

  useEffect(() => {
    if (isPaged) {
      pageObserverRef.current?.disconnect();
      pageObserverRef.current = null;
      return;
    }
    const nodes = Array.from(document.querySelectorAll("[data-reader-page]"));
    if (!nodes.length) {
      return;
    }
    pageObserverRef.current?.disconnect();
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (!visible) {
        return;
      }
      const target = /** @type {HTMLElement} */ (visible.target);
      const nextChapterId = target.dataset.chapterId || chapterId;
      const nextPageIndex = Number.parseInt(target.dataset.pageIndex || "0", 10) || 0;
      const previous = activeWebtoonPageRef.current;
      activeWebtoonPageRef.current = {chapterId: nextChapterId, pageIndex: nextPageIndex};
      scrollDirectionRef.current = nextChapterId === previous.chapterId && nextPageIndex < previous.pageIndex ? "backward" : "forward";
      setActiveChapterId(nextChapterId);
      setActivePageIndex(nextPageIndex);
    }, {
      rootMargin: "-20% 0px -55% 0px",
      threshold: [0.15, 0.35, 0.65]
    });
    for (const node of nodes) {
      observer.observe(node);
    }
    pageObserverRef.current = observer;
    return () => observer.disconnect();
  }, [chapterId, isPaged, pageState, webtoonChapterIds]);

  useEffect(() => {
    const session = isPaged ? currentPagedSession : activeSession;
    const activeIndex = isPaged ? pagedPageIndex : activePageIndex;
    if (!session?.chapter?.id) {
      return;
    }
    const pageCount = Math.max(1, Number.parseInt(String(session.pageCount || 1), 10) || 1);
    const entry = pageState.get(session.chapter.id);
    const plan = resolveReaderPreloadPlan({
      layoutMode,
      activeIndex,
      pageCount,
      loadedPages: entry?.pages || [],
      chunkSize: PAGE_CHUNK_SIZE,
      aheadCount: preloadConfig.aheadCount,
      previousCushion: preloadConfig.previousCushion,
      scrollDirection: scrollDirectionRef.current
    });
    recordReaderTelemetry({
      type: "preload-queue",
      titleId: title?.id || "",
      chapterId: session.chapter.id,
      layoutMode,
      direction: scrollDirectionRef.current,
      activeIndex,
      pageCount,
      queueDepth: plan.metadataRequests.length + plan.warmIndexes.length,
      metadataRequestCount: plan.metadataRequests.length,
      warmRequestCount: plan.warmIndexes.length,
      inFlightPageRequests: pageRequestTokensRef.current.size,
      ...countDecodedReaderPages(imageWarmStateRef.current.values(), {
        chapterId: session.chapter.id,
        activeIndex
      })
    });
    if (!entry?.loading) {
      for (const request of plan.metadataRequests) {
        void loadPages(session, {cursor: request.cursor, pageSize: request.pageSize});
      }
    }
    void warmPageImages(session, plan.warmIndexes);
    if (!isPaged || !plan.prefetchNextChapter || !session.nextChapterId) {
      return;
    }
    void fetchSession(session.nextChapterId).then((nextSession) => {
      if (!nextSession?.chapter?.id) {
        return;
      }
      const nextEntry = pageState.get(nextSession.chapter.id);
      if (nextEntry?.loading || hasReaderPageWindow(nextEntry?.pages || [], 0, Math.min(3, nextSession.pageCount || 1), nextSession.pageCount || 1)) {
        return;
      }
      void loadPages(nextSession, {cursor: 0, pageSize: PAGE_CHUNK_SIZE, replace: true});
    });
  }, [
    activePageIndex,
    activeSession,
    currentPagedSession,
    fetchSession,
    isPaged,
    layoutMode,
    loadPages,
    pageState,
    pagedPageIndex,
    preloadConfig.aheadCount,
    preloadConfig.previousCushion,
    title?.id,
    warmPageImages
  ]);

  useEffect(() => {
    const pending = pendingScrollRef.current;
    if (pending == null || isPaged) {
      return;
    }
    const target = document.querySelector(`[data-chapter-id="${cssEscape(activeChapterId)}"][data-page-index="${pending}"]`);
    if (target) {
      pendingScrollRef.current = null;
      target.scrollIntoView({block: "center", behavior: "smooth"});
    }
  }, [activeChapterId, isPaged, pageState]);

  const persistPreference = useCallback(async (next = {}) => {
    if (!title) {
      return;
    }
    await requestJson("/api/moon-v3/user/reader/preferences", {
      method: "PUT",
      json: {
        typeSlug: title.libraryTypeSlug || title.mediaType || typeSlug || "manga",
        titleId: title.id,
        layoutMode,
        readingDirection,
        pageFit,
        showSidebar,
        showPageNumbers,
        ...next
      }
    });
  }, [layoutMode, pageFit, readingDirection, showPageNumbers, showSidebar, title, typeSlug]);

  const loadChapterRows = useCallback(async ({append = false} = {}) => {
    if (!title?.id || chapterRowsLoading) {
      return;
    }
    const cursor = append ? chapterPageInfo?.nextCursor || "" : "";
    if (append && !cursor) {
      return;
    }
    setChapterRowsLoading(true);
    const result = await requestJson(chapterRowsUrlFor(title.id, cursor));
    if (result.ok) {
      setChapterRows((current) => append ? mergeChapterRows(current, result.payload?.chapters || []) : result.payload?.chapters || []);
      setChapterPageInfo(result.payload?.pageInfo || null);
    }
    setChapterRowsLoading(false);
  }, [chapterPageInfo?.nextCursor, chapterRowsLoading, title?.id]);

  useEffect(() => {
    if ((settingsOpen || showSidebar) && title?.id && !chapterRows.length && !chapterRowsLoading) {
      void loadChapterRows();
    }
  }, [chapterRows.length, chapterRowsLoading, loadChapterRows, settingsOpen, showSidebar, title?.id]);

  const openPagedChapter = useCallback(async (nextChapterId, nextPageIndex = 0) => {
    const session = await fetchSession(nextChapterId);
    if (!session || !title) {
      return;
    }
    const safePageIndex = clampPage(nextPageIndex, session.pageCount || 1);
    const ready = await preparePagedPage(session, safePageIndex, {message: "Preparing chapter."});
    if (!ready) {
      return;
    }
    setPagedChapterId(nextChapterId);
    setPagedPageIndex(safePageIndex);
    setActiveChapterId(nextChapterId);
    setActivePageIndex(safePageIndex);
    window.history.replaceState(null, "", buildReaderPathForTitle(title, nextChapterId));
  }, [fetchSession, preparePagedPage, title]);

  const goPreviousPaged = useCallback(async () => {
    const step = pagesPerStep(layoutMode);
    if (pagedPageIndex > 0) {
      const nextIndex = Math.max(0, pagedPageIndex - step);
      const ready = await preparePagedPage(currentPagedSession, nextIndex, {message: "Preparing previous page."});
      if (!ready) {
        return;
      }
      setPagedPageIndex(nextIndex);
      setActivePageIndex(nextIndex);
      return;
    }
    if (currentPagedSession?.previousChapterId) {
      const previousSession = await fetchSession(currentPagedSession.previousChapterId);
      if (previousSession) {
        await openPagedChapter(previousSession.chapter.id, Math.max(0, (previousSession.pageCount || 1) - 1));
      }
    }
  }, [currentPagedSession, fetchSession, layoutMode, openPagedChapter, pagedPageIndex, preparePagedPage]);

  const goNextPaged = useCallback(async () => {
    const step = pagesPerStep(layoutMode);
    const pageCount = Math.max(1, Number.parseInt(String(currentPagedSession?.pageCount || 1), 10) || 1);
    if (pagedPageIndex + step < pageCount) {
      const nextIndex = Math.min(pageCount - 1, pagedPageIndex + step);
      const ready = await preparePagedPage(currentPagedSession, nextIndex, {message: "Preparing next page."});
      if (!ready) {
        return;
      }
      setPagedPageIndex(nextIndex);
      setActivePageIndex(nextIndex);
      return;
    }
    if (currentPagedSession?.nextChapterId) {
      await openPagedChapter(currentPagedSession.nextChapterId, 0);
    }
  }, [currentPagedSession, layoutMode, openPagedChapter, pagedPageIndex, preparePagedPage]);

  const goVisualNext = useCallback(() => {
    if (!isPaged) {
      window.scrollBy({top: Math.round(window.innerHeight * 0.88), behavior: "smooth"});
      return;
    }
    void (visualRtl ? goPreviousPaged() : goNextPaged());
  }, [goNextPaged, goPreviousPaged, isPaged, visualRtl]);

  const goVisualPrevious = useCallback(() => {
    if (!isPaged) {
      window.scrollBy({top: -Math.round(window.innerHeight * 0.88), behavior: "smooth"});
      return;
    }
    void (visualRtl ? goNextPaged() : goPreviousPaged());
  }, [goNextPaged, goPreviousPaged, isPaged, visualRtl]);

  const addBookmark = useCallback(async () => {
    if (!title || !activeSession?.chapter?.id) {
      return;
    }
    const bookmarkPage = isPaged ? pagedPageIndex : activePageIndex;
    const result = await requestJson("/api/moon-v3/user/reader/bookmarks", {
      method: "POST",
      json: {
        titleId: title.id,
        chapterId: activeSession.chapter.id,
        pageIndex: bookmarkPage,
        label: `${activeSession.chapter.label || "Chapter"} - Page ${bookmarkPage + 1}`
      }
    });
    if (result.ok) {
      const bookmarksResult = await requestJson(`/api/moon-v3/user/reader/bookmarks?titleId=${encodeURIComponent(title.id)}`);
      if (bookmarksResult.ok) {
        setBookmarks(Array.isArray(bookmarksResult.payload?.bookmarks) ? bookmarksResult.payload.bookmarks : []);
      }
    }
  }, [activePageIndex, activeSession, isPaged, pagedPageIndex, title]);

  const loadMoreWebtoon = useCallback(async () => {
    const lastChapterId = webtoonChapterIds[webtoonChapterIds.length - 1];
    const lastSession = sessionMap.get(lastChapterId);
    const current = pageState.get(lastChapterId);
    const action = resolveWebtoonLoadMoreAction({session: lastSession, entry: current});
    if (!action.ready) {
      recordReaderTelemetry({
        type: "caught-buffer",
        titleId: title?.id || "",
        chapterId: lastChapterId,
        layoutMode,
        activeIndex: activePageIndex,
        ok: false,
        reason: "webtoon_chunk_not_ready"
      });
      return null;
    }
    if (action.done) {
      return false;
    }
    if (Object.hasOwn(action, "cursor")) {
      if (action.cursor === "" || action.cursor == null) {
        return null;
      }
      await loadPages(lastSession, {cursor: action.cursor, replace: action.replace === true});
      return true;
    }
    const nextSession = await fetchSession(action.nextChapterId);
    if (!nextSession) {
      return null;
    }
    setWebtoonChapterIds((currentIds) => currentIds.includes(nextSession.chapter.id) ? currentIds : [...currentIds, nextSession.chapter.id]);
    await loadPages(nextSession, {cursor: 0, replace: true});
    return true;
  }, [activePageIndex, fetchSession, layoutMode, loadPages, pageState, sessionMap, title?.id, webtoonChapterIds]);

  const handleSeek = useCallback((nextIndex) => {
    const safeIndex = clampPage(nextIndex, activePageCount);
    if (isPaged) {
      void (async () => {
        const ready = await preparePagedPage(currentPagedSession, safeIndex, {message: "Preparing page."});
        if (!ready) {
          return;
        }
        setPagedPageIndex(safeIndex);
        setActivePageIndex(safeIndex);
      })();
      return;
    }
    setActivePageIndex(safeIndex);
    pendingScrollRef.current = safeIndex;
    const current = pageState.get(activeChapterId);
    if (!current || !current.pages.some((page) => page.index === safeIndex)) {
      recordReaderTelemetry({
        type: "caught-buffer",
        titleId: title?.id || "",
        chapterId: activeChapterId,
        layoutMode,
        pageIndex: safeIndex,
        activeIndex: activePageIndex,
        pageCount: activePageCount,
        ok: false,
        reason: "seek_metadata_missing"
      });
      void loadPages(activeSession, {cursor: safeIndex});
    }
  }, [activeChapterId, activePageCount, activePageIndex, activeSession, currentPagedSession, isPaged, layoutMode, loadPages, pageState, preparePagedPage, title?.id]);

  const updateLayoutMode = (value) => {
    const nextValue = normalizeLayoutMode(value);
    setLayoutMode(nextValue);
    void persistPreference({layoutMode: nextValue, readingMode: nextValue === "webtoon" ? "infinite" : "paged"});
  };

  const updateReadingDirection = (value) => {
    const nextValue = DIRECTIONS.includes(value) ? value : "ltr";
    setReadingDirection(nextValue);
    void persistPreference({readingDirection: nextValue});
  };

  const updatePageFit = (value) => {
    const nextValue = PAGE_FITS.includes(value) ? value : "width";
    setPageFit(nextValue);
    void persistPreference({pageFit: nextValue});
  };

  const applyAction = useCallback((action) => {
    switch (action) {
      case READER_INPUT_ACTIONS.NEXT:
        if (!settingsOpen) {
          goVisualNext();
        }
        break;
      case READER_INPUT_ACTIONS.PREVIOUS:
        if (!settingsOpen) {
          goVisualPrevious();
        }
        break;
      case READER_INPUT_ACTIONS.TOGGLE_SETTINGS:
        setSettingsOpen((value) => !value);
        break;
      case READER_INPUT_ACTIONS.CLOSE_SETTINGS:
        setSettingsOpen(false);
        if (document.fullscreenElement) {
          void document.exitFullscreen?.();
        }
        break;
      case READER_INPUT_ACTIONS.TOGGLE_CONTROLS:
        setControlsVisible((value) => !value);
        break;
      case READER_INPUT_ACTIONS.BOOKMARK:
        void addBookmark();
        break;
      case READER_INPUT_ACTIONS.FULLSCREEN:
        void document.documentElement.requestFullscreen?.();
        break;
      case READER_INPUT_ACTIONS.SETTINGS_SCROLL_DOWN:
        settingsRef.current?.scrollBy?.({top: 120, behavior: "smooth"});
        break;
      case READER_INPUT_ACTIONS.SETTINGS_SCROLL_UP:
        settingsRef.current?.scrollBy?.({top: -120, behavior: "smooth"});
        break;
      default:
        break;
    }
  }, [addBookmark, goVisualNext, goVisualPrevious, settingsOpen]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const action = resolveKeyboardAction(event);
      if (!action) {
        return;
      }
      event.preventDefault();
      applyAction(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyAction]);

  useEffect(() => {
    let frame = 0;
    const pollGamepad = () => {
      const actions = resolveGamepadActions(navigator.getGamepads?.() || [], inputStateRef.current, {
        settingsOpen,
        documentHidden: document.visibilityState === "hidden"
      });
      for (const action of actions) {
        applyAction(action);
      }
      frame = window.requestAnimationFrame(pollGamepad);
    };
    const onGamepadConnected = () => {
      inputStateRef.current.connected = true;
    };
    const onGamepadDisconnected = () => {
      inputStateRef.current = createReaderInputState();
    };
    window.addEventListener("gamepadconnected", onGamepadConnected);
    window.addEventListener("gamepaddisconnected", onGamepadDisconnected);
    frame = window.requestAnimationFrame(pollGamepad);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("gamepadconnected", onGamepadConnected);
      window.removeEventListener("gamepaddisconnected", onGamepadDisconnected);
    };
  }, [applyAction, settingsOpen]);

  useEffect(() => {
    const hideTimer = setTimeout(() => {
      if (!settingsOpen) {
        setControlsVisible(false);
      }
    }, 2600);
    return () => clearTimeout(hideTimer);
  }, [controlsVisible, settingsOpen]);

  const onPointerDown = (event) => {
    pointerStartRef.current = {x: event.clientX, y: event.clientY};
    setControlsVisible(true);
  };

  const onPointerUp = (event) => {
    const action = resolvePointerSwipe(pointerStartRef.current, {x: event.clientX, y: event.clientY});
    pointerStartRef.current = null;
    if (action) {
      applyAction(action);
    }
  };

  if (loading && !initialSession) {
    return <ReaderInitialSkeleton />;
  }

  if (status === 401 && !chrome.auth) {
    return (
      <main className="reader-app reader-landing">
        <section className="reader-empty-panel">
          <span className="reader-eyebrow">Reader</span>
          <h1>Sign in to read.</h1>
          <p>{siteName} needs your Discord session to load chapters, progress, and bookmarks.</p>
          {chrome.loginUrl ? <a href={chrome.loginUrl}>Sign in with Discord</a> : null}
        </section>
      </main>
    );
  }

  if (error && !initialSession) {
    return <main className="reader-app"><div className="reader-empty-panel">{error}</div></main>;
  }

  if (!title || !initialSession) {
    return <main className="reader-app"><div className="reader-empty-panel">Reader unavailable.</div></main>;
  }

  return (
    <main
      className={`reader-app ${controlsVisible || settingsOpen || refreshing ? "has-visible-controls" : ""}`.trim()}
      data-layout={layoutMode}
      data-fit={pageFit}
      data-sidebar={showSidebar}
      onMouseMove={() => setControlsVisible(true)}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="reader-tap-zone is-previous" onClick={goVisualPrevious} aria-hidden="true" />
      <div className="reader-tap-zone is-next" onClick={goVisualNext} aria-hidden="true" />

      <ReaderControls
        title={title}
        activeChapter={activeSession?.chapter || initialSession.chapter}
        activePageIndex={activePageDisplayIndex}
        pageCount={activePageCount}
        onBookmark={addBookmark}
        onSettings={() => setSettingsOpen((value) => !value)}
        onFullscreen={() => document.documentElement.requestFullscreen?.()}
        onPrevious={goVisualPrevious}
        onNext={goVisualNext}
        onSeek={handleSeek}
      />

      <ReaderStage
        title={title}
        layoutMode={layoutMode}
        pageFit={pageFit}
        spreadDirection={spreadDirection}
        isPaged={isPaged}
        spreadPages={spreadPages}
        pagedChapterId={pagedChapterId}
        webtoonChapters={webtoonChapters}
        showPageNumbers={showPageNumbers}
        loadingPages={currentPageEntry.loading}
        loadMoreReady={webtoonLoadMoreReady}
        loadMoreKey={webtoonLoadMoreKey}
        loadMore={loadMoreWebtoon}
      />

      {preparingMessage ? (
        <div className="reader-preparing" role="status" aria-live="polite">
          {preparingMessage}
        </div>
      ) : null}

      <ReaderSettings
        containerRef={settingsRef}
        title={title}
        activeChapterId={activeChapterId}
        bookmarks={bookmarks}
        chapterRows={chapterRows}
        chapterPageInfo={chapterPageInfo}
        chapterRowsLoading={chapterRowsLoading}
        isOpen={settingsOpen}
        pinned={showSidebar}
        isPaged={isPaged}
        layoutMode={layoutMode}
        readingDirection={readingDirection}
        pageFit={pageFit}
        showPageNumbers={showPageNumbers}
        onClose={() => setSettingsOpen(false)}
        onLayoutMode={updateLayoutMode}
        onReadingDirection={updateReadingDirection}
        onPageFit={updatePageFit}
        onPinned={(value) => {
          setShowSidebar(value);
          void persistPreference({showSidebar: value});
        }}
        onPageNumbers={(value) => {
          setShowPageNumbers(value);
          void persistPreference({showPageNumbers: value});
        }}
        onOpenPagedChapter={openPagedChapter}
        onLoadMoreChapters={() => loadChapterRows({append: true})}
      />
    </main>
  );
};

export default ReaderAppClient;
