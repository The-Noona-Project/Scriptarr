"use client";

/**
 * @file Unified catalogue page for Moon's Next user app.
 */

import {useCallback, useDeferredValue, useEffect, useMemo, useRef, useState} from "react";
import {requestJson, useMoonJson} from "../../lib/api.js";
import {
  CATALOGUE_VIEW_STORAGE_KEY,
  buildBrowseLetterState,
  buildCatalogueApiUrl,
  buildCataloguePageUrl,
  normalizeBrowseType,
  normalizeCataloguePageSize,
  normalizeCatalogueSearchParams,
  normalizeCatalogueView
} from "../../lib/browse.js";
import {formatTypeLabel, getLibraryTypeCount, getLibraryTypes} from "../../lib/navigationRoutes.js";
import {mergePagedTitleRows} from "../../lib/titleList.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView, EmptyView, ErrorView} from "../StateView.jsx";
import {TitleCardGridSkeleton, TitleListInfiniteScroll, TitleRowListSkeleton} from "../TitleListLoading.jsx";
import LibraryTitleRow from "../LibraryTitleRow.jsx";
import TitleCard from "../TitleCard.jsx";

const CATALOGUE_VIEWS = Object.freeze(["grid", "rows"]);

const readSavedCatalogueView = () => {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    const value = String(window.localStorage?.getItem(CATALOGUE_VIEW_STORAGE_KEY) || "").trim().toLowerCase();
    return CATALOGUE_VIEWS.includes(value) ? value : "";
  } catch {
    return "";
  }
};

const saveCatalogueView = (view) => {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage?.setItem(CATALOGUE_VIEW_STORAGE_KEY, normalizeCatalogueView(view));
  } catch {
    // Local storage can be disabled; the URL still carries the current view.
  }
};

const defaultPageSizeForView = (view) => normalizeCataloguePageSize(null, normalizeCatalogueView(view));

const routeFallbackView = (entry) => entry === "browse" ? "grid" : "rows";

const typeFromLegacyLibraryPath = (pathname) => {
  const match = String(pathname || "").match(/^\/library\/([^/?#]+)/);
  if (!match) {
    return "";
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1] || "";
  }
};

const resultTitle = ({query, type, letter}) => {
  if (query) {
    return letter ? `Search results in ${letter}` : "Search results";
  }
  if (letter) {
    return `Titles under ${letter}`;
  }
  if (type && type !== "all") {
    return `${formatTypeLabel(type)} titles`;
  }
  return "All titles";
};

/**
 * Render the canonical catalogue with card-grid and dense-row modes.
 *
 * @param {{
 *   initialSearchParams?: Record<string, string | string[] | undefined>,
 *   initialTypeSlug?: string,
 *   entry?: "browse" | "library"
 * }} props
 * @returns {import("react").ReactNode}
 */
export const CataloguePageClient = ({initialSearchParams = {}, initialTypeSlug = "", entry = "library"} = {}) => {
  const {auth, branding, loginUrl, libraryTypes: chromeLibraryTypes = []} = useMoonChrome();
  const siteName = branding?.siteName || "Scriptarr";
  const initialFilters = useMemo(() => normalizeCatalogueSearchParams(initialSearchParams, {
    fallbackType: initialTypeSlug,
    fallbackView: routeFallbackView(entry)
  }), [entry, initialSearchParams, initialTypeSlug]);
  const hasInitialExplicitView = CATALOGUE_VIEWS.includes(initialFilters.explicitView);
  const [search, setSearch] = useState(initialFilters.query);
  const [activeType, setActiveType] = useState(initialFilters.type);
  const [activeLetter, setActiveLetter] = useState(initialFilters.letter);
  const [activeView, setActiveView] = useState(initialFilters.view);
  const [pageSize, setPageSize] = useState(initialFilters.pageSize);
  const deferredSearch = useDeferredValue(search);
  const [pageTitles, setPageTitles] = useState([]);
  const [pageInfo, setPageInfo] = useState({hasMore: false, nextCursor: "", total: 0});
  const [loadingMore, setLoadingMore] = useState(false);
  const currentRequestRef = useRef("");
  const loadMoreSeqRef = useRef(0);
  const activeQuery = deferredSearch.trim();
  const libraryUrl = useMemo(() => buildCatalogueApiUrl({
    query: activeQuery,
    type: activeType,
    letter: activeLetter,
    pageSize,
    view: activeView
  }), [activeLetter, activeQuery, activeType, activeView, pageSize]);
  const {loading, refreshing, error, status, data} = useMoonJson(libraryUrl, {
    keepPreviousData: true,
    persistentCache: {userKey: auth?.discordUserId, scope: "library"},
    fallback: {titles: [], counts: {total: 0, byLetter: {}, byType: {}}, pageInfo: {total: 0}}
  });

  useEffect(() => {
    if (hasInitialExplicitView) {
      return;
    }
    const savedView = readSavedCatalogueView();
    if (savedView && savedView !== activeView) {
      setActiveView(savedView);
      setPageSize(defaultPageSizeForView(savedView));
    }
  }, [activeView, hasInitialExplicitView]);

  useEffect(() => {
    currentRequestRef.current = libraryUrl;
  }, [libraryUrl]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      const nextUrl = buildCataloguePageUrl({
        query: activeQuery,
        type: activeType,
        letter: activeLetter,
        view: activeView,
        pageSize
      });
      const currentUrl = `${window.location.pathname}${window.location.search}`;
      if (nextUrl !== currentUrl) {
        window.history.replaceState(window.history.state, "", nextUrl);
      }
    }, 250);

    return () => {
      clearTimeout(timeout);
    };
  }, [activeLetter, activeQuery, activeType, activeView, pageSize]);

  useEffect(() => {
    const handlePopState = () => {
      const next = normalizeCatalogueSearchParams(new URLSearchParams(window.location.search), {
        fallbackType: typeFromLegacyLibraryPath(window.location.pathname),
        fallbackView: window.location.pathname.startsWith("/browse") ? "grid" : "rows"
      });
      const savedView = next.explicitView ? "" : readSavedCatalogueView();
      const nextView = savedView || next.view;
      setSearch(next.query);
      setActiveType(next.type);
      setActiveLetter(next.letter);
      setActiveView(nextView);
      setPageSize(next.explicitView ? next.pageSize : defaultPageSizeForView(nextView));
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    setPageTitles(mergePagedTitleRows([], data?.titles, {append: false}));
    setPageInfo(data?.pageInfo || {hasMore: false, nextCursor: "", total: 0});
  }, [data?.pageInfo, data?.titles]);

  const letterState = useMemo(() => buildBrowseLetterState(data?.counts?.byLetter), [data?.counts?.byLetter]);
  const typeCounts = data?.counts?.byType && typeof data.counts.byType === "object" ? data.counts.byType : {};
  const visibleTotal = Number.parseInt(String(data?.pageInfo?.total ?? 0), 10) || 0;
  const catalogueTotal = Number.parseInt(String(data?.counts?.total ?? visibleTotal), 10) || 0;
  const libraryTypes = useMemo(() => {
    const counted = getLibraryTypes(typeCounts);
    return counted.length ? counted : chromeLibraryTypes;
  }, [chromeLibraryTypes, typeCounts]);
  const typeOptions = useMemo(() => [
    {slug: "all", label: "All", count: catalogueTotal},
    ...libraryTypes
  ], [catalogueTotal, libraryTypes]);

  useEffect(() => {
    if (loading || refreshing || activeType === "all") {
      return;
    }
    if (getLibraryTypeCount(typeCounts, activeType) <= 0) {
      setActiveType("all");
    }
  }, [activeType, loading, refreshing, typeCounts]);

  const loadMore = useCallback(async () => {
    if (loadingMore || refreshing) {
      return Boolean(pageInfo?.hasMore);
    }
    const cursor = String(pageInfo?.nextCursor || "").trim();
    if (!pageInfo?.hasMore || !cursor) {
      return false;
    }
    setLoadingMore(true);
    const requestKey = libraryUrl;
    const requestSeq = loadMoreSeqRef.current + 1;
    loadMoreSeqRef.current = requestSeq;
    try {
      const result = await requestJson(buildCatalogueApiUrl({
        query: activeQuery,
        type: activeType,
        letter: activeLetter,
        pageSize,
        view: activeView,
        cursor
      }));
      if (!result.ok || requestKey !== currentRequestRef.current) {
        return Boolean(pageInfo?.hasMore);
      }
      const nextPageInfo = result.payload?.pageInfo || {hasMore: false, nextCursor: "", total: 0};
      setPageTitles((current) => mergePagedTitleRows(current, result.payload?.titles, {append: true}));
      setPageInfo(nextPageInfo);
      return Boolean(nextPageInfo.hasMore && nextPageInfo.nextCursor);
    } finally {
      if (requestSeq === loadMoreSeqRef.current) {
        setLoadingMore(false);
      }
    }
  }, [activeLetter, activeQuery, activeType, activeView, libraryUrl, loadingMore, pageInfo, pageSize, refreshing]);

  const searchLabel = useMemo(() => {
    if (!activeQuery) {
      return `${visibleTotal} visible of ${catalogueTotal} title${catalogueTotal === 1 ? "" : "s"}`;
    }
    return `${visibleTotal} match${visibleTotal === 1 ? "" : "es"} for "${activeQuery}"`;
  }, [activeQuery, catalogueTotal, visibleTotal]);

  const updateSearch = (value) => {
    setSearch(value);
  };

  const updateType = (type) => {
    setActiveType(normalizeBrowseType(type));
  };

  const updateLetter = (letter) => {
    setActiveLetter(letter);
  };

  const updateView = (view) => {
    const nextView = normalizeCatalogueView(view, activeView);
    setActiveView(nextView);
    setPageSize(defaultPageSizeForView(nextView));
    saveCatalogueView(nextView);
  };

  if (status === 401 && !auth) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        title="Sign in to open the library"
        detail={`${siteName} keeps the full catalogue, type views, and reading history behind your Discord session.`}
      />
    );
  }

  if (error && !pageTitles.length) {
    return <ErrorView detail={error} />;
  }

  const showInitialSkeleton = loading && !pageTitles.length;
  const isGrid = activeView === "grid";
  const resultCountLabel = refreshing ? "Updating loaded results" : `${visibleTotal} result${visibleTotal === 1 ? "" : "s"}`;

  return (
    <div className="moon-page-grid moon-browse-page moon-catalogue-page">
      <section className="moon-panel moon-section moon-browse-hero">
        <div className="moon-section-head moon-browse-hero-head">
          <div>
            <span className="moon-kicker">Catalogue</span>
            <h2>Library</h2>
          </div>
          <span className="moon-muted">{searchLabel}</span>
        </div>
        <div className="moon-catalogue-toolbar">
          <div className="moon-browse-search-shell">
            <input
              className="moon-search-bar"
              type="search"
              value={search}
              onChange={(event) => updateSearch(event.target.value)}
              placeholder="Search titles, aliases, tags, creators, or type"
              aria-label="Search the full catalogue"
            />
            {refreshing ? <span className="moon-browse-refresh-dot" aria-live="polite">Refreshing</span> : null}
          </div>
          <div className="moon-catalogue-view-toggle" aria-label="Catalogue view">
            <button
              type="button"
              className={`moon-segment-button ${isGrid ? "is-active" : ""}`.trim()}
              aria-pressed={isGrid}
              onClick={() => updateView("grid")}
            >
              Grid
            </button>
            <button
              type="button"
              className={`moon-segment-button ${!isGrid ? "is-active" : ""}`.trim()}
              aria-pressed={!isGrid}
              onClick={() => updateView("rows")}
            >
              Rows
            </button>
          </div>
        </div>
        <div className="moon-browse-filter-row" aria-label="Filter by media type">
          {typeOptions.map((entry) => {
            const selected = entry.slug === activeType || (entry.slug === "all" && activeType === "all");
            const count = Math.max(0, Number.parseInt(String(entry.count || 0), 10) || 0);
            return (
              <button
                key={entry.slug}
                type="button"
                className={`moon-pill moon-filter-pill ${selected ? "is-active" : ""}`.trim()}
                aria-pressed={selected}
                onClick={() => updateType(entry.slug)}
              >
                <span>{entry.label}</span>
                {count > 0 ? <small>{count}</small> : null}
              </button>
            );
          })}
        </div>
      </section>
      <div className="moon-browse-layout">
        <aside className="moon-browse-rail">
          <div className="moon-browse-rail-stick">
            <span className="moon-kicker">Jump to</span>
            <nav className="moon-browse-letter-index" aria-label="Browse by letter">
              <button
                type="button"
                className={`moon-browse-letter-button ${activeLetter ? "" : "is-active"}`.trim()}
                aria-current={activeLetter ? undefined : "true"}
                onClick={() => updateLetter("")}
              >
                All
              </button>
              {letterState.map((entry) => (
                <button
                  key={entry.letter}
                  type="button"
                  className={`moon-browse-letter-button ${entry.letter === activeLetter ? "is-active" : ""}`.trim()}
                  disabled={entry.disabled}
                  aria-current={entry.letter === activeLetter ? "true" : undefined}
                  onClick={() => updateLetter(entry.letter)}
                >
                  {entry.letter}
                </button>
              ))}
            </nav>
          </div>
        </aside>
        <section className={`moon-panel moon-section moon-browse-results ${refreshing ? "is-refreshing" : ""}`.trim()}>
          <div className="moon-section-head moon-browse-results-head">
            <div>
              <span className="moon-kicker">{activeType === "all" ? "Catalogue" : formatTypeLabel(activeType)}</span>
              <h2>{resultTitle({query: activeQuery, type: activeType, letter: activeLetter})}</h2>
            </div>
            <span className="moon-muted">{resultCountLabel}</span>
          </div>
          {error ? <div className="moon-inline-error" role="status">{error}</div> : null}
          {showInitialSkeleton ? (
            isGrid ? <TitleCardGridSkeleton count={12} /> : <TitleRowListSkeleton count={8} />
          ) : pageTitles.length ? (
            <>
              <div className={isGrid ? "moon-browse-grid" : "moon-library-title-list"}>
                <TitleListInfiniteScroll
                  key={libraryUrl}
                  items={pageTitles}
                  loading={loadingMore}
                  threshold={360}
                  className="moon-infinite-list-sentinel"
                  loadMore={loadMore}
                  renderItem={(title, index) => isGrid
                    ? <TitleCard key={title.id} title={title} priority={index < 8} variant="browse" />
                    : <LibraryTitleRow key={title.id} title={title} priority={index < 8} />}
                />
              </div>
              {loadingMore ? (isGrid ? <TitleCardGridSkeleton count={4} /> : <TitleRowListSkeleton count={3} />) : null}
              {pageInfo?.hasMore ? (
                <div className="moon-browse-load-more">
                  <button type="button" className="moon-button" onClick={loadMore} disabled={loadingMore || refreshing}>
                    {loadingMore ? "Loading..." : "Load more"}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyView title="No titles match these filters" detail="Try a broader title, alias, tag, or type filter." />
          )}
        </section>
      </div>
    </div>
  );
};

export default CataloguePageClient;
