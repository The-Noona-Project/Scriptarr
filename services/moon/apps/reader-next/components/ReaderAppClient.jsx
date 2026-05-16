"use client";

/**
 * @file Fullscreen Moon reader app client.
 */

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {formatDate, formatProgress} from "../lib/date.js";
import {loadMoonChromeContext, loadMoonLoginUrl, requestJson, useMoonJson} from "../lib/api.js";
import {buildReaderPath, buildReaderPathForTitle, buildTitlePathForTitle} from "../lib/routes.js";

const LAYOUT_MODES = [
  {label: "Single", value: "single"},
  {label: "Double", value: "double"},
  {label: "Manga double", value: "manga-double"},
  {label: "Webtoon", value: "webtoon"}
];
const PAGE_FITS = ["width", "height", "contain"];
const DIRECTIONS = ["ltr", "rtl"];

const sortManifest = (chapters) => [...(Array.isArray(chapters) ? chapters : [])].sort((left, right) => {
  const leftNumber = Number.parseFloat(String(left?.chapterNumber || "0"));
  const rightNumber = Number.parseFloat(String(right?.chapterNumber || "0"));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && rightNumber !== leftNumber) {
    return rightNumber - leftNumber;
  }
  return Date.parse(String(right?.releaseDate || "")) - Date.parse(String(left?.releaseDate || ""));
});

const normalizeLayoutMode = (value) => ["single", "double", "manga-double", "webtoon"].includes(value) ? value : "webtoon";
const pagesPerStep = (layoutMode) => layoutMode === "double" || layoutMode === "manga-double" ? 2 : 1;
const getPageRatio = (pageIndex, pages) => pageIndex / Math.max(1, (Array.isArray(pages) ? pages.length : 1) - 1);
const clampIndex = (value, pages) => Math.max(0, Math.min(value, Math.max(0, pages.length - 1)));
const cssEscape = (value) => globalThis.CSS?.escape?.(String(value)) || String(value).replace(/"/g, "\\\"");

/**
 * Render a segmented button group for reader settings.
 *
 * @param {{label: string, value: string, options: Array<string | {label: string, value: string}>, onChange: (value: string) => void}} props
 * @returns {import("react").ReactNode}
 */
const ReaderSegmented = ({label, value, options, onChange}) => (
  <label className="reader-control-group">
    <span>{label}</span>
    <div className="reader-segmented">
      {options.map((option) => {
        const entry = typeof option === "string" ? {label: option, value: option} : option;
        return (
          <button
            aria-pressed={entry.value === value}
            className={entry.value === value ? "is-active" : ""}
            key={entry.value}
            type="button"
            onClick={() => onChange(entry.value)}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  </label>
);

/**
 * Render the dedicated fullscreen reader app for one title chapter.
 *
 * @param {{titleId: string, chapterId: string, typeSlug?: string}} props
 * @returns {import("react").ReactNode}
 */
export const ReaderAppClient = ({titleId, chapterId, typeSlug = ""}) => {
  const {loading, error, status, data} = useMoonJson(
    `/api/moon-v3/user/reader/title/${encodeURIComponent(titleId)}/chapter/${encodeURIComponent(chapterId)}`,
    {fallback: null, deps: [titleId, chapterId]}
  );
  const [chrome, setChrome] = useState({auth: null, loginUrl: "", branding: {siteName: "Scriptarr"}});
  const [layoutMode, setLayoutMode] = useState("webtoon");
  const [readingDirection, setReadingDirection] = useState("ltr");
  const [pageFit, setPageFit] = useState("width");
  const [showSidebar, setShowSidebar] = useState(false);
  const [showPageNumbers, setShowPageNumbers] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [loadedChapters, setLoadedChapters] = useState([]);
  const [chapterMap, setChapterMap] = useState(() => new Map());
  const [bookmarks, setBookmarks] = useState([]);
  const [activeChapterId, setActiveChapterId] = useState(chapterId);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [pagedChapterId, setPagedChapterId] = useState(chapterId);
  const [pagedPageIndex, setPagedPageIndex] = useState(0);
  const prefetchCache = useRef(new Map());
  const pageObserverRef = useRef(/** @type {IntersectionObserver | null} */ (null));
  const pointerStartRef = useRef(/** @type {{x: number, y: number} | null} */ (null));
  const gamepadRepeatRef = useRef(0);

  const manifest = useMemo(() => sortManifest(data?.manifest?.chapters), [data?.manifest?.chapters]);
  const title = data?.title || null;
  const isPaged = layoutMode !== "webtoon";

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

  useEffect(() => {
    if (!data) {
      return;
    }
    const preferences = data.preferences || {};
    const nextLayoutMode = normalizeLayoutMode(preferences.layoutMode || (preferences.readingMode === "paged" ? "single" : "webtoon"));
    setLayoutMode(nextLayoutMode);
    setReadingDirection(DIRECTIONS.includes(preferences.readingDirection) ? preferences.readingDirection : "ltr");
    setPageFit(PAGE_FITS.includes(preferences.pageFit) ? preferences.pageFit : "width");
    setShowSidebar(preferences.showSidebar === true);
    setShowPageNumbers(preferences.showPageNumbers !== false);
    setLoadedChapters([data]);
    setChapterMap(new Map([[data.chapter.id, data]]));
    setActiveChapterId(data.chapter.id);
    setActivePageIndex(Number.isInteger(data?.progress?.bookmark?.pageIndex) ? data.progress.bookmark.pageIndex : 0);
    setPagedChapterId(data.chapter.id);
    setPagedPageIndex(Number.isInteger(data?.progress?.bookmark?.pageIndex) ? data.progress.bookmark.pageIndex : 0);
    void fetchBookmarks();
  }, [data, fetchBookmarks]);

  useEffect(() => {
    if (!title || !activeChapterId) {
      return;
    }
    const nextPath = buildReaderPath(title.libraryTypeSlug || title.mediaType || "manga", title.id, activeChapterId);
    if (window.location.pathname !== nextPath) {
      window.history.replaceState(null, "", nextPath);
    }
  }, [activeChapterId, title]);

  useEffect(() => {
    if (!title || !activeChapterId) {
      return;
    }
    const currentChapter = chapterMap.get(activeChapterId) || loadedChapters.find((entry) => entry.chapter?.id === activeChapterId);
    const pageCount = currentChapter?.pages?.length || 1;
    const pageIndex = isPaged ? pagedPageIndex : activePageIndex;
    const timer = setTimeout(() => {
      void requestJson("/api/moon-v3/user/reader/progress", {
        method: "PUT",
        json: {
          mediaId: title.id,
          chapterLabel: currentChapter?.chapter?.label || "Chapter",
          positionRatio: getPageRatio(pageIndex, currentChapter?.pages || []),
          bookmark: {
            titleId: title.id,
            chapterId: activeChapterId,
            pageIndex: Math.max(0, Math.min(pageIndex, pageCount - 1))
          }
        }
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [activeChapterId, activePageIndex, chapterMap, isPaged, loadedChapters, pagedPageIndex, title]);

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
      setActiveChapterId(target.dataset.chapterId || chapterId);
      setActivePageIndex(Number.parseInt(target.dataset.pageIndex || "0", 10) || 0);
    }, {
      rootMargin: "-20% 0px -55% 0px",
      threshold: [0.15, 0.35, 0.65]
    });

    for (const node of nodes) {
      observer.observe(node);
    }
    pageObserverRef.current = observer;
    return () => observer.disconnect();
  }, [chapterId, isPaged, loadedChapters]);

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
    const after = manifest[index + 2];
    if (after) {
      void fetchChapterPayload(after.id);
    }
    return Boolean(payload);
  }, [ensureChapter, fetchChapterPayload, loadedChapters, manifest]);

  const currentPagedChapter = chapterMap.get(pagedChapterId) || loadedChapters.find((entry) => entry.chapter.id === pagedChapterId) || data;
  const currentPagedPages = currentPagedChapter?.pages || [];
  const spreadSize = pagesPerStep(layoutMode);
  const spreadStart = layoutMode === "single" ? pagedPageIndex : Math.max(0, pagedPageIndex - (pagedPageIndex % spreadSize));
  const spreadPages = currentPagedPages.slice(spreadStart, spreadStart + spreadSize);
  const spreadDirection = layoutMode === "manga-double" || readingDirection === "rtl" ? "rtl" : "ltr";
  const visualRtl = layoutMode === "manga-double" || readingDirection === "rtl";

  const openPagedChapter = useCallback(async (nextChapterId, nextPageIndex = 0) => {
    const payload = await ensureChapter(nextChapterId);
    if (!payload || !title) {
      return;
    }
    const safePageIndex = clampIndex(nextPageIndex, payload.pages || []);
    setPagedChapterId(nextChapterId);
    setPagedPageIndex(safePageIndex);
    setActiveChapterId(nextChapterId);
    setActivePageIndex(safePageIndex);
    window.history.replaceState(null, "", buildReaderPathForTitle(title, nextChapterId));
  }, [ensureChapter, title]);

  const goPreviousPaged = useCallback(async () => {
    const step = pagesPerStep(layoutMode);
    if (pagedPageIndex > 0) {
      const nextIndex = Math.max(0, pagedPageIndex - step);
      setPagedPageIndex(nextIndex);
      setActivePageIndex(nextIndex);
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
  }, [ensureChapter, layoutMode, manifest, openPagedChapter, pagedChapterId, pagedPageIndex]);

  const goNextPaged = useCallback(async () => {
    const step = pagesPerStep(layoutMode);
    if (pagedPageIndex + step < currentPagedPages.length) {
      const nextIndex = Math.min(currentPagedPages.length - 1, pagedPageIndex + step);
      setPagedPageIndex(nextIndex);
      setActivePageIndex(nextIndex);
      return;
    }
    const index = manifest.findIndex((entry) => entry.id === pagedChapterId);
    const next = manifest[index + 1];
    if (next) {
      await openPagedChapter(next.id, 0);
    }
  }, [currentPagedPages.length, layoutMode, manifest, openPagedChapter, pagedChapterId, pagedPageIndex]);

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

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      const tagName = target instanceof HTMLElement ? target.tagName.toLowerCase() : "";
      if (tagName === "input" || tagName === "textarea" || event.defaultPrevented) {
        return;
      }
      if (["ArrowRight", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        goVisualNext();
      }
      if (["ArrowLeft", "PageUp"].includes(event.key)) {
        event.preventDefault();
        goVisualPrevious();
      }
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        void document.documentElement.requestFullscreen?.();
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        setSettingsOpen((value) => !value);
      }
      if (event.key === "Escape") {
        setSettingsOpen(false);
        if (document.fullscreenElement) {
          void document.exitFullscreen?.();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goVisualNext, goVisualPrevious]);

  useEffect(() => {
    let frame = 0;
    const pollGamepad = () => {
      const pad = navigator.getGamepads?.().find(Boolean);
      const now = Date.now();
      if (pad && now - gamepadRepeatRef.current > 260) {
        if (pad.buttons[15]?.pressed) {
          gamepadRepeatRef.current = now;
          goVisualNext();
        } else if (pad.buttons[14]?.pressed) {
          gamepadRepeatRef.current = now;
          goVisualPrevious();
        } else if (pad.buttons[12]?.pressed || pad.buttons[13]?.pressed) {
          gamepadRepeatRef.current = now;
          setSettingsOpen((value) => !value);
        }
      }
      frame = window.requestAnimationFrame(pollGamepad);
    };
    frame = window.requestAnimationFrame(pollGamepad);
    return () => window.cancelAnimationFrame(frame);
  }, [goVisualNext, goVisualPrevious]);

  useEffect(() => {
    const hideTimer = setTimeout(() => {
      if (!settingsOpen) {
        setControlsVisible(false);
      }
    }, 2600);
    return () => clearTimeout(hideTimer);
  }, [controlsVisible, settingsOpen]);

  const addBookmark = useCallback(async () => {
    if (!title) {
      return;
    }
    const currentChapter = isPaged ? currentPagedChapter : (chapterMap.get(activeChapterId) || data);
    const bookmarkPage = isPaged ? pagedPageIndex : activePageIndex;
    await requestJson("/api/moon-v3/user/reader/bookmarks", {
      method: "POST",
      json: {
        titleId: title.id,
        chapterId: currentChapter?.chapter?.id || activeChapterId,
        pageIndex: bookmarkPage,
        label: `${currentChapter?.chapter?.label || "Chapter"} - Page ${bookmarkPage + 1}`
      }
    });
    await fetchBookmarks();
  }, [activeChapterId, activePageIndex, chapterMap, currentPagedChapter, data, fetchBookmarks, isPaged, pagedPageIndex, title]);

  const onPointerDown = (event) => {
    pointerStartRef.current = {x: event.clientX, y: event.clientY};
    setControlsVisible(true);
  };

  const onPointerUp = (event) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start) {
      return;
    }
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) > 56 && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (deltaX < 0) {
        goVisualNext();
      } else {
        goVisualPrevious();
      }
    }
  };

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

  if (loading) {
    return <main className="reader-app"><div className="reader-empty-panel">Loading reader.</div></main>;
  }

  if (status === 401 && !chrome.auth) {
    return (
      <main className="reader-app reader-landing">
        <section className="reader-empty-panel">
          <span className="reader-eyebrow">Reader</span>
          <h1>Sign in to read.</h1>
          <p>Moon needs your Discord session to load chapters, progress, and bookmarks.</p>
          {chrome.loginUrl ? <a href={chrome.loginUrl}>Sign in with Discord</a> : null}
        </section>
      </main>
    );
  }

  if (error) {
    return <main className="reader-app"><div className="reader-empty-panel">{error}</div></main>;
  }

  if (!title || !data) {
    return <main className="reader-app"><div className="reader-empty-panel">Reader unavailable.</div></main>;
  }

  const activeChapter = chapterMap.get(activeChapterId)?.chapter || currentPagedChapter?.chapter || data.chapter;
  const activePages = isPaged ? currentPagedPages : (chapterMap.get(activeChapterId)?.pages || data.pages || []);
  const activePageDisplay = isPaged ? pagedPageIndex + 1 : activePageIndex + 1;

  return (
    <main
      className={`reader-app ${controlsVisible || settingsOpen ? "has-visible-controls" : ""}`.trim()}
      data-layout={layoutMode}
      data-fit={pageFit}
      data-sidebar={showSidebar}
      onMouseMove={() => setControlsVisible(true)}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="reader-tap-zone is-previous" onClick={goVisualPrevious} aria-hidden="true" />
      <div className="reader-tap-zone is-next" onClick={goVisualNext} aria-hidden="true" />

      <header className="reader-topbar">
        <a className="reader-icon-button" href={buildTitlePathForTitle(title)}>Back</a>
        <div className="reader-title-stack">
          <strong>{title.title}</strong>
          <span>{activeChapter?.label || "Chapter"} - Page {activePageDisplay} of {activePages.length || 1}</span>
        </div>
        <div className="reader-top-actions">
          <button className="reader-icon-button" type="button" onClick={addBookmark}>Bookmark</button>
          <button className="reader-icon-button" type="button" onClick={() => setSettingsOpen((value) => !value)}>Settings</button>
          <button className="reader-icon-button" type="button" onClick={() => document.documentElement.requestFullscreen?.()}>Fullscreen</button>
        </div>
      </header>

      <section className="reader-stage" aria-label={`${title.title} reader`}>
        {isPaged ? (
          <div className="reader-spread" data-direction={spreadDirection}>
            {spreadPages.length ? spreadPages.map((page) => (
              <figure className="reader-page-frame" key={`${pagedChapterId}:${page.index}`}>
                <img src={page.src} alt={page.label} draggable="false" />
                {showPageNumbers ? <figcaption>{page.index + 1}</figcaption> : null}
              </figure>
            )) : (
              <div className="reader-empty-panel">No pages are available for this chapter.</div>
            )}
          </div>
        ) : (
          <div className="reader-webtoon-flow">
            {loadedChapters.map((chapterPayload) => (
              <section className="reader-webtoon-chapter" key={chapterPayload.chapter.id}>
                {chapterPayload.chapter.id === data.chapter.id ? null : (
                  <header className="reader-chapter-divider">
                    <strong>{chapterPayload.chapter.label}</strong>
                    <span>{formatDate(chapterPayload.chapter.releaseDate)} - {chapterPayload.pages.length} pages</span>
                  </header>
                )}
                {chapterPayload.pages.map((page) => (
                  <figure
                    className="reader-page-frame"
                    data-reader-page
                    data-chapter-id={chapterPayload.chapter.id}
                    data-page-index={page.index}
                    key={`${chapterPayload.chapter.id}:${page.index}`}
                  >
                    <img src={page.src} alt={page.label} loading="lazy" draggable="false" />
                    {showPageNumbers ? <figcaption>{page.index + 1}</figcaption> : null}
                  </figure>
                ))}
              </section>
            ))}
            <ReaderLoadMore loadMore={loadMore} />
          </div>
        )}
      </section>

      <footer className="reader-bottombar">
        <button type="button" onClick={goVisualPrevious}>Previous</button>
        <input
          aria-label="Page progress"
          max={Math.max(0, activePages.length - 1)}
          min="0"
          type="range"
          value={Math.min(activePageDisplay - 1, Math.max(0, activePages.length - 1))}
          onChange={(event) => {
            const nextIndex = Number.parseInt(event.target.value, 10) || 0;
            setPagedPageIndex(nextIndex);
            setActivePageIndex(nextIndex);
            if (!isPaged) {
              const target = document.querySelector(`[data-chapter-id="${cssEscape(activeChapterId)}"][data-page-index="${nextIndex}"]`);
              target?.scrollIntoView?.({block: "center", behavior: "smooth"});
            }
          }}
        />
        <span>{formatProgress(getPageRatio(activePageDisplay - 1, activePages))}</span>
        <button type="button" onClick={goVisualNext}>Next</button>
      </footer>

      <aside className={`reader-settings ${settingsOpen || showSidebar ? "is-open" : ""}`.trim()} aria-label="Reader settings">
        <div className="reader-settings-head">
          <div>
            <span className="reader-eyebrow">{title.libraryTypeLabel || title.mediaType || "Reader"}</span>
            <h2>{title.title}</h2>
          </div>
          <button type="button" onClick={() => setSettingsOpen(false)}>Close</button>
        </div>
        <ReaderSegmented label="Layout" value={layoutMode} options={LAYOUT_MODES} onChange={updateLayoutMode} />
        <ReaderSegmented label="Direction" value={readingDirection} options={DIRECTIONS} onChange={updateReadingDirection} />
        <ReaderSegmented label="Fit" value={pageFit} options={PAGE_FITS} onChange={updatePageFit} />
        <label className="reader-check-row">
          <input
            checked={showSidebar}
            type="checkbox"
            onChange={(event) => {
              setShowSidebar(event.target.checked);
              void persistPreference({showSidebar: event.target.checked});
            }}
          />
          Pin chapter rail
        </label>
        <label className="reader-check-row">
          <input
            checked={showPageNumbers}
            type="checkbox"
            onChange={(event) => {
              setShowPageNumbers(event.target.checked);
              void persistPreference({showPageNumbers: event.target.checked});
            }}
          />
          Page numbers
        </label>
        <section className="reader-settings-section">
          <h3>Chapters</h3>
          <div className="reader-chapter-list">
            {manifest.map((chapter) => (
              <button
                className={chapter.id === activeChapterId ? "is-active" : ""}
                key={chapter.id}
                type="button"
                onClick={() => {
                  if (isPaged) {
                    void openPagedChapter(chapter.id, 0);
                  } else {
                    window.location.assign(buildReaderPathForTitle(title, chapter.id));
                  }
                }}
              >
                <strong>{chapter.label}</strong>
                <span>{formatDate(chapter.releaseDate)} - {chapter.pageCount || 0} pages</span>
              </button>
            ))}
          </div>
        </section>
        <section className="reader-settings-section">
          <h3>Bookmarks</h3>
          <div className="reader-chapter-list">
            {bookmarks.length ? bookmarks.map((bookmark) => (
              <button
                key={bookmark.id}
                type="button"
                onClick={() => {
                  if (isPaged) {
                    void openPagedChapter(bookmark.chapterId, bookmark.pageIndex || 0);
                  } else {
                    window.location.assign(buildReaderPath(title.libraryTypeSlug || title.mediaType || "manga", title.id, bookmark.chapterId));
                  }
                }}
              >
                <strong>{bookmark.label || "Bookmark"}</strong>
                <span>Page {(bookmark.pageIndex || 0) + 1}</span>
              </button>
            )) : <p>No bookmarks yet.</p>}
          </div>
        </section>
      </aside>
    </main>
  );
};

/**
 * Render the infinite-reader load sentinel.
 *
 * @param {{loadMore: () => Promise<boolean>}} props
 * @returns {import("react").ReactNode}
 */
const ReaderLoadMore = ({loadMore}) => {
  const sentinelRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [pending, setPending] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!hasMore || pending || !entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      setPending(true);
      void Promise.resolve(loadMore()).then((result) => {
        if (result === false) {
          setHasMore(false);
        }
      }).finally(() => setPending(false));
    }, {threshold: 0.35});
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore, pending]);

  return (
    <>
      <div ref={sentinelRef} className="reader-load-sentinel" aria-hidden="true" />
      {pending ? <div className="reader-loading-next">Loading next chapter.</div> : null}
    </>
  );
};

export default ReaderAppClient;
