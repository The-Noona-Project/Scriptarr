"use client";

/**
 * @file Full-page Once UI reader for Moon's Next user app.
 */

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {useRouter} from "next/navigation";
import {Button, Flex, InfiniteScroll, SegmentedControl} from "@once-ui-system/core";
import {requestJson, useMoonJson} from "../../lib/api.js";
import {buildReaderPath, buildReaderPathForTitle, buildTitlePathForTitle} from "../../lib/routes.js";
import {formatDate, formatProgress} from "../../lib/date.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView, EmptyView, ErrorView, LoadingView} from "../StateView.jsx";

const sortManifest = (chapters) => [...(Array.isArray(chapters) ? chapters : [])].sort((left, right) => {
  const leftNumber = Number.parseFloat(String(left?.chapterNumber || "0"));
  const rightNumber = Number.parseFloat(String(right?.chapterNumber || "0"));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && rightNumber !== leftNumber) {
    return rightNumber - leftNumber;
  }
  return Date.parse(String(right?.releaseDate || "")) - Date.parse(String(left?.releaseDate || ""));
});

const normalizeMode = (value) => value === "paged" ? "paged" : "infinite";

const getPageRatio = (pageIndex, pages) => pageIndex / Math.max(1, (Array.isArray(pages) ? pages.length : 1) - 1);

/**
 * Render the new full-page reader.
 *
 * @param {{titleId: string, chapterId: string, typeSlug?: string}} props
 * @returns {import("react").ReactNode}
 */
export const ReaderPageClient = ({titleId, chapterId, typeSlug = ""}) => {
  const router = useRouter();
  const {auth, loginUrl} = useMoonChrome();
  const {loading, error, status, data} = useMoonJson(
    `/api/moon-v3/user/reader/title/${encodeURIComponent(titleId)}/chapter/${encodeURIComponent(chapterId)}`,
    {fallback: null, deps: [titleId, chapterId]}
  );
  const [mode, setMode] = useState("infinite");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [pageFit, setPageFit] = useState("width");
  const [loadedChapters, setLoadedChapters] = useState([]);
  const [chapterMap, setChapterMap] = useState(() => new Map());
  const [bookmarks, setBookmarks] = useState([]);
  const [activeChapterId, setActiveChapterId] = useState(chapterId);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [pagedChapterId, setPagedChapterId] = useState(chapterId);
  const [pagedPageIndex, setPagedPageIndex] = useState(0);
  const prefetchCache = useRef(new Map());
  const pageObserverRef = useRef(/** @type {IntersectionObserver | null} */ (null));

  const manifest = useMemo(() => sortManifest(data?.manifest?.chapters), [data?.manifest?.chapters]);
  const title = data?.title || null;

  const fetchBookmarks = useCallback(async () => {
    const result = await requestJson(`/api/moon-v3/user/reader/bookmarks?titleId=${encodeURIComponent(titleId)}`);
    if (result.ok) {
      setBookmarks(Array.isArray(result.payload?.bookmarks) ? result.payload.bookmarks : []);
    }
  }, [titleId]);

  const fetchChapterPayload = useCallback(async (nextChapterId) => {
    const cacheKey = String(nextChapterId || "").trim();
    if (!cacheKey) {
      return null;
    }
    const cached = prefetchCache.current.get(cacheKey);
    if (cached) {
      return cached;
    }
    const promise = requestJson(
      `/api/moon-v3/user/reader/title/${encodeURIComponent(titleId)}/chapter/${encodeURIComponent(cacheKey)}`
    ).then((result) => (result.ok ? result.payload : null));
    prefetchCache.current.set(cacheKey, promise);
    return promise;
  }, [titleId]);

  const persistPreferenceMode = useCallback(async (nextMode) => {
    await requestJson("/api/moon-v3/user/reader/preferences", {
      method: "PUT",
      json: {
        typeSlug: title?.libraryTypeSlug || title?.mediaType || typeSlug || "manga",
        readingMode: nextMode === "paged" ? "paged" : "infinite",
        pageFit,
        showSidebar: drawerOpen,
        showPageNumbers: true
      }
    });
  }, [drawerOpen, pageFit, title?.libraryTypeSlug, title?.mediaType, typeSlug]);

  useEffect(() => {
    if (!data) {
      return;
    }

    const resolvedMode = normalizeMode(data?.preferences?.readingMode);
    setMode(resolvedMode);
    setDrawerOpen(data?.preferences?.showSidebar !== false);
    setPageFit(["width", "contain", "height"].includes(data?.preferences?.pageFit) ? data.preferences.pageFit : "width");
    setLoadedChapters([data]);
    setChapterMap(new Map([[data.chapter.id, data]]));
    setActiveChapterId(data.chapter.id);
    setActivePageIndex(Number.isInteger(data?.progress?.bookmark?.pageIndex) ? data.progress.bookmark.pageIndex : 0);
    setPagedChapterId(data.chapter.id);
    setPagedPageIndex(Number.isInteger(data?.progress?.bookmark?.pageIndex) ? data.progress.bookmark.pageIndex : 0);
    void fetchBookmarks();
  }, [data, fetchBookmarks]);

  useEffect(() => {
    if (title && title.libraryTypeSlug && typeSlug && title.libraryTypeSlug !== typeSlug) {
      router.replace(buildReaderPathForTitle(title, chapterId));
    }
  }, [chapterId, router, title, typeSlug]);

  useEffect(() => {
    if (!title || !activeChapterId) {
      return;
    }
    window.history.replaceState(null, "", buildReaderPath(title.libraryTypeSlug || title.mediaType || "manga", title.id, activeChapterId));
  }, [activeChapterId, title]);

  useEffect(() => {
    if (!title || !activeChapterId) {
      return;
    }
    const currentChapter = chapterMap.get(activeChapterId) || loadedChapters.find((entry) => entry.chapter?.id === activeChapterId);
    const pageCount = currentChapter?.pages?.length || 1;
    const timer = setTimeout(() => {
      void requestJson("/api/moon-v3/user/reader/progress", {
        method: "PUT",
        json: {
          mediaId: title.id,
          chapterLabel: currentChapter?.chapter?.label || "Chapter",
          positionRatio: getPageRatio(activePageIndex, currentChapter?.pages || []),
          bookmark: {
            titleId: title.id,
            chapterId: activeChapterId,
            pageIndex: Math.max(0, Math.min(activePageIndex, pageCount - 1))
          }
        }
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [activeChapterId, activePageIndex, chapterMap, loadedChapters, title]);

  useEffect(() => {
    if (mode !== "infinite") {
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
      setActiveChapterId(target.dataset.chapterId || chapterId);
      setActivePageIndex(Number.parseInt(target.dataset.pageIndex || "0", 10) || 0);
    }, {
      rootMargin: "-18% 0px -55% 0px",
      threshold: [0.15, 0.35, 0.65]
    });

    for (const node of nodes) {
      observer.observe(node);
    }
    pageObserverRef.current = observer;
    return () => observer.disconnect();
  }, [chapterId, loadedChapters, mode]);

  const ensureChapter = useCallback(async (nextChapterId) => {
    if (!nextChapterId) {
      return null;
    }
    if (chapterMap.has(nextChapterId)) {
      return chapterMap.get(nextChapterId);
    }
    const payload = await fetchChapterPayload(nextChapterId);
    if (!payload) {
      return null;
    }
    setChapterMap((current) => new Map(current).set(nextChapterId, payload));
    setLoadedChapters((current) => current.some((entry) => entry.chapter.id === nextChapterId) ? current : [...current, payload]);
    return payload;
  }, [chapterMap, fetchChapterPayload]);

  const loadMore = useCallback(async () => {
    if (!manifest.length || !loadedChapters.length) {
      return false;
    }
    const lastLoaded = loadedChapters[loadedChapters.length - 1];
    const index = manifest.findIndex((entry) => entry.id === lastLoaded.chapter.id);
    const nextChapter = manifest[index + 1];
    if (!nextChapter) {
      return false;
    }
    const payload = await ensureChapter(nextChapter.id);
    if (!payload) {
      return false;
    }
    const after = manifest[index + 2];
    if (after) {
      void fetchChapterPayload(after.id);
    }
    return true;
  }, [ensureChapter, fetchChapterPayload, loadedChapters, manifest]);

  const currentPagedChapter = chapterMap.get(pagedChapterId) || loadedChapters.find((entry) => entry.chapter.id === pagedChapterId) || data;
  const currentPagedPages = currentPagedChapter?.pages || [];
  const currentPagedPage = currentPagedPages[Math.max(0, Math.min(pagedPageIndex, currentPagedPages.length - 1))] || null;
  const leadInfiniteChapterId = data?.chapter?.id || chapterId;

  const openPagedChapter = useCallback(async (nextChapterId, nextPageIndex = 0) => {
    const payload = await ensureChapter(nextChapterId);
    if (!payload || !title) {
      return;
    }
    const safePageIndex = Math.max(0, Math.min(nextPageIndex, (payload.pages?.length || 1) - 1));
    setPagedChapterId(nextChapterId);
    setPagedPageIndex(safePageIndex);
    setActiveChapterId(nextChapterId);
    setActivePageIndex(safePageIndex);
    router.replace(buildReaderPathForTitle(title, nextChapterId));
  }, [ensureChapter, router, title]);

  const goPreviousPaged = useCallback(async () => {
    if (pagedPageIndex > 0) {
      setPagedPageIndex((value) => Math.max(0, value - 1));
      setActivePageIndex((value) => Math.max(0, value - 1));
      return;
    }
    const index = manifest.findIndex((entry) => entry.id === pagedChapterId);
    const previous = manifest[index - 1];
    if (!previous) {
      return;
    }
    const payload = await ensureChapter(previous.id);
    if (payload) {
      await openPagedChapter(previous.id, Math.max(0, (payload.pages?.length || 1) - 1));
    }
  }, [ensureChapter, manifest, openPagedChapter, pagedChapterId, pagedPageIndex]);

  const goNextPaged = useCallback(async () => {
    if (pagedPageIndex + 1 < currentPagedPages.length) {
      setPagedPageIndex((value) => Math.min(currentPagedPages.length - 1, value + 1));
      setActivePageIndex((value) => Math.min(currentPagedPages.length - 1, value + 1));
      return;
    }
    const index = manifest.findIndex((entry) => entry.id === pagedChapterId);
    const next = manifest[index + 1];
    if (next) {
      await openPagedChapter(next.id, 0);
    }
  }, [currentPagedPages.length, manifest, openPagedChapter, pagedChapterId, pagedPageIndex]);

  useEffect(() => {
    if (mode !== "paged") {
      return undefined;
    }
    const onKeyDown = (event) => {
      const target = event.target;
      const tagName = target instanceof HTMLElement ? target.tagName.toLowerCase() : "";
      if (tagName === "input" || tagName === "textarea" || event.defaultPrevented) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        void goPreviousPaged();
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        void goNextPaged();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goNextPaged, goPreviousPaged, mode]);

  const addBookmark = useCallback(async () => {
    if (!title) {
      return;
    }
    const currentChapter = mode === "paged" ? currentPagedChapter : (chapterMap.get(activeChapterId) || data);
    const bookmarkPage = mode === "paged" ? pagedPageIndex : activePageIndex;
    await requestJson("/api/moon-v3/user/reader/bookmarks", {
      method: "POST",
      json: {
        titleId: title.id,
        chapterId: currentChapter?.chapter?.id || activeChapterId,
        pageIndex: bookmarkPage,
        label: `${currentChapter?.chapter?.label || "Chapter"} · Page ${bookmarkPage + 1}`
      }
    });
    await fetchBookmarks();
  }, [activeChapterId, activePageIndex, chapterMap, currentPagedChapter, data, fetchBookmarks, mode, pagedPageIndex, title]);

  const chapterCoverageCopy = useMemo(() => {
    if (!manifest.length) {
      return "No manifest chapters";
    }
    const loadedCount = loadedChapters.length;
    return `${loadedCount} of ${manifest.length} chapters staged`;
  }, [loadedChapters.length, manifest.length]);

  if (loading) {
    return <LoadingView label="Moon is hydrating the full-page reader workspace and chapter rail." />;
  }

  if (status === 401 && !auth) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        title="Sign in to use the reader"
        detail="Moon needs your Discord session to load chapters, progress, and bookmarks in the full-page reader."
      />
    );
  }

  if (error) {
    return <ErrorView detail={error} />;
  }

  if (!title || !data) {
    return <EmptyView title="Reader unavailable" detail="Moon could not load this chapter right now." />;
  }

  return (
    <div className="moon-reader-layout">
      <aside className="moon-reader-sidebar">
        <section className="moon-panel moon-reader-sidebar-section">
          <span className="moon-kicker">Reader</span>
          <h2>{title.title}</h2>
          <p className="moon-muted">{data.chapter.label} · {chapterCoverageCopy}</p>
          <Flex gap="10" wrap style={{marginTop: "12px"}}>
            <Button href={buildTitlePathForTitle(title)} variant="secondary" size="m">
              Back to title
            </Button>
            <Button variant="secondary" size="m" onClick={() => setDrawerOpen((value) => !value)}>
              {drawerOpen ? "Collapse rail" : "Expand rail"}
            </Button>
          </Flex>
          <div style={{marginTop: "16px"}}>
            <SegmentedControl
              selected={mode}
              onToggle={async (value) => {
                setMode(value);
                await persistPreferenceMode(value);
              }}
              buttons={[
                {label: "Infinite", value: "infinite", size: "l"},
                {label: "Paged", value: "paged", size: "l"}
              ]}
            />
          </div>
        </section>

        {drawerOpen ? (
          <>
            <section className="moon-panel moon-reader-sidebar-section">
              <span className="moon-kicker">Chapters</span>
              <h2>Jump through the run</h2>
              <div className="moon-reader-chapter-nav">
                {manifest.map((chapter) => (
                  <button
                    key={chapter.id}
                    className="moon-reader-chapter-button"
                    type="button"
                    onClick={() => {
                      if (mode === "paged") {
                        void openPagedChapter(chapter.id, 0);
                      } else {
                        router.push(buildReaderPathForTitle(title, chapter.id));
                      }
                    }}
                  >
                    <strong>{chapter.label}</strong>
                    <div className="moon-muted">{formatDate(chapter.releaseDate)} · {chapter.pageCount || 0} pages</div>
                  </button>
                ))}
              </div>
            </section>

            <section className="moon-panel moon-reader-sidebar-section">
              <span className="moon-kicker">Bookmarks</span>
              <h2>Saved spots</h2>
              <Button variant="primary" size="m" onClick={addBookmark}>
                Save bookmark
              </Button>
              <div className="moon-reader-bookmarks" style={{marginTop: "14px"}}>
                {bookmarks.length ? bookmarks.map((bookmark) => (
                  <button
                    key={bookmark.id}
                    className="moon-reader-bookmark-button"
                    type="button"
                    onClick={() => {
                      if (mode === "paged") {
                        void openPagedChapter(bookmark.chapterId, bookmark.pageIndex || 0);
                      } else {
                        router.push(buildReaderPath(title.libraryTypeSlug || title.mediaType || "manga", title.id, bookmark.chapterId));
                      }
                    }}
                  >
                    <strong>{bookmark.label || "Bookmark"}</strong>
                    <div className="moon-muted">Page {(bookmark.pageIndex || 0) + 1}</div>
                  </button>
                )) : (
                  <div className="moon-reader-empty">No bookmarks yet for this title.</div>
                )}
              </div>
            </section>
          </>
        ) : null}
      </aside>

      <section className="moon-reader-canvas">
        <div className="moon-reader-topbar-shell">
          <header className="moon-reader-topbar">
            <div>
              <span className="moon-kicker">{title.libraryTypeLabel || title.mediaType || "Reader"}</span>
              <h1>{title.title}</h1>
            </div>
            <div className="moon-reader-progress">
              <span className="moon-pill">{mode === "paged" ? "Paged mode" : "Infinite mode"}</span>
              <span className="moon-pill">
                {mode === "paged"
                  ? `Page ${Math.max(1, pagedPageIndex + 1)} of ${currentPagedPages.length || 1}`
                  : `${formatProgress(getPageRatio(activePageIndex, chapterMap.get(activeChapterId)?.pages || data.pages || []))} read`}
              </span>
            </div>
          </header>
        </div>

        <section className="moon-panel moon-reader-stage">
          {mode === "paged" ? (
            <div className="moon-reader-paged-surface">
              <div className="moon-reader-paged-toolbar">
                <Button
                  variant="secondary"
                  size="m"
                  onClick={goPreviousPaged}
                >
                  Previous
                </Button>
                <div className="moon-muted">
                  {currentPagedChapter?.chapter?.label || "Chapter"} · {pageFit}
                </div>
                <Button
                  variant="secondary"
                  size="m"
                  onClick={goNextPaged}
                >
                  Next
                </Button>
              </div>
              <div className="moon-reader-paged-frame" data-fit={pageFit}>
                {currentPagedPage ? (
                  <img
                    src={currentPagedPage.src}
                    alt={currentPagedPage.label}
                    className="moon-reader-paged-image"
                  />
                ) : (
                  <div className="moon-reader-empty">No pages are available for this chapter.</div>
                )}
              </div>
            </div>
          ) : (
            <InfiniteScroll
              items={loadedChapters}
              threshold={0.45}
              loading={loading}
              loadMore={loadMore}
              renderItem={(chapterPayload) => (
                <section
                  key={chapterPayload.chapter.id}
                  className={`moon-reader-chapter-section ${chapterPayload.chapter.id === leadInfiniteChapterId ? "is-lead" : ""}`}
                  data-reader-chapter={chapterPayload.chapter.id}
                >
                  {chapterPayload.chapter.id === leadInfiniteChapterId ? null : (
                    <div className="moon-reader-chapter-header">
                    <strong>{chapterPayload.chapter.label}</strong>
                    <div className="moon-muted">{formatDate(chapterPayload.chapter.releaseDate)} · {chapterPayload.pages.length} pages</div>
                    </div>
                  )}
                  <div className="moon-reader-pages">
                    {chapterPayload.pages.map((page) => (
                      <div
                        key={`${chapterPayload.chapter.id}:${page.index}`}
                        className={`moon-reader-page ${activeChapterId === chapterPayload.chapter.id && activePageIndex === page.index ? "is-active" : ""}`}
                        data-reader-page
                        data-chapter-id={chapterPayload.chapter.id}
                        data-page-index={page.index}
                      >
                        <img src={page.src} alt={page.label} loading="lazy" />
                      </div>
                    ))}
                  </div>
                </section>
              )}
            />
          )}
        </section>
      </section>
    </div>
  );
};

export default ReaderPageClient;
