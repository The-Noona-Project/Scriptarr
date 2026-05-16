"use client";

/**
 * @file Browse page for Moon's Next user app.
 */

import {useDeferredValue, useEffect, useMemo, useRef, useState} from "react";
import {requestJson, useMoonJson} from "../../lib/api.js";
import {
  BROWSE_PAGE_SIZE,
  buildBrowseApiUrl,
  buildBrowseLetterState,
  buildBrowsePageUrl,
  normalizeBrowseSearchParams
} from "../../lib/browse.js";
import {getLibraryTypes} from "../../lib/navigationRoutes.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView, ErrorView, LoadingView} from "../StateView.jsx";
import TitleCard from "../TitleCard.jsx";

const ALL_TYPES = [{slug: "all", label: "All"}, ...getLibraryTypes()];

/**
 * Resolve the browse result heading for the active filters.
 *
 * @param {{query?: string, type?: string, letter?: string}} filters
 * @returns {string}
 */
const resultTitle = ({query, type, letter}) => {
  if (query) {
    return letter ? `Search results in ${letter}` : "Search results";
  }
  if (letter) {
    return `Titles under ${letter}`;
  }
  return type && type !== "all" ? "Filtered catalogue" : "Full catalogue";
};

/**
 * Render the browse surface.
 *
 * @param {{initialSearchParams?: Record<string, string | string[] | undefined>}} props
 * @returns {import("react").ReactNode}
 */
export const BrowsePageClient = ({initialSearchParams = {}} = {}) => {
  const {auth, loginUrl} = useMoonChrome();
  const initialFilters = useMemo(() => normalizeBrowseSearchParams(initialSearchParams), [initialSearchParams]);
  const [search, setSearch] = useState(initialFilters.query);
  const [activeType, setActiveType] = useState(initialFilters.type);
  const [activeLetter, setActiveLetter] = useState(initialFilters.letter);
  const deferredSearch = useDeferredValue(search);
  const [pageTitles, setPageTitles] = useState([]);
  const [pageInfo, setPageInfo] = useState({hasMore: false, nextCursor: "", total: 0});
  const [loadingMore, setLoadingMore] = useState(false);
  const currentRequestRef = useRef("");
  const activeQuery = deferredSearch.trim();
  const libraryUrl = useMemo(() => buildBrowseApiUrl({
    query: activeQuery,
    type: activeType,
    letter: activeLetter,
    pageSize: BROWSE_PAGE_SIZE
  }), [activeLetter, activeQuery, activeType]);
  const {loading, refreshing, error, status, data} = useMoonJson(libraryUrl, {
    keepPreviousData: true,
    persistentCache: {userKey: auth?.discordUserId, scope: "library"},
    fallback: {titles: [], counts: {total: 0, byLetter: {}}, pageInfo: {total: 0}}
  });

  useEffect(() => {
    currentRequestRef.current = libraryUrl;
  }, [libraryUrl]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      const nextUrl = buildBrowsePageUrl({
        query: activeQuery,
        type: activeType,
        letter: activeLetter
      });
      const currentUrl = `${window.location.pathname}${window.location.search}`;
      if (nextUrl !== currentUrl) {
        window.history.replaceState(window.history.state, "", nextUrl);
      }
    }, 180);

    return () => {
      clearTimeout(timeout);
    };
  }, [activeLetter, activeQuery, activeType]);

  useEffect(() => {
    const handlePopState = () => {
      const next = normalizeBrowseSearchParams(new URLSearchParams(window.location.search));
      setSearch(next.query);
      setActiveType(next.type);
      setActiveLetter(next.letter);
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    setPageTitles(Array.isArray(data?.titles) ? data.titles : []);
    setPageInfo(data?.pageInfo || {hasMore: false, nextCursor: "", total: 0});
  }, [data?.pageInfo, data?.titles]);

  const letterState = useMemo(() => buildBrowseLetterState(data?.counts?.byLetter), [data?.counts?.byLetter]);
  const typeCounts = data?.counts?.byType && typeof data.counts.byType === "object" ? data.counts.byType : {};
  const visibleTotal = Number.parseInt(String(data?.pageInfo?.total ?? 0), 10) || 0;
  const catalogueTotal = Number.parseInt(String(data?.counts?.total ?? visibleTotal), 10) || 0;

  const loadMore = async () => {
    if (!pageInfo?.hasMore || loadingMore) {
      return;
    }
    setLoadingMore(true);
    const requestKey = libraryUrl;
    const result = await requestJson(buildBrowseApiUrl({
      query: activeQuery,
      type: activeType,
      letter: activeLetter,
      pageSize: BROWSE_PAGE_SIZE,
      cursor: String(pageInfo.nextCursor || "")
    }));
    if (result.ok && requestKey === currentRequestRef.current) {
      setPageTitles((current) => [...current, ...(Array.isArray(result.payload?.titles) ? result.payload.titles : [])]);
      setPageInfo(result.payload?.pageInfo || {hasMore: false, nextCursor: "", total: 0});
    }
    setLoadingMore(false);
  };

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
    setActiveType(type);
  };

  const updateLetter = (letter) => {
    setActiveLetter(letter);
  };

  if (loading && !pageTitles.length) {
    return <LoadingView label="Moon is loading the compact browse catalogue." />;
  }

  if (status === 401 && !auth) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        title="Sign in to browse the library"
        detail="Moon keeps the full library and metadata surfaces behind your Discord session."
      />
    );
  }

  if (error && !pageTitles.length) {
    return <ErrorView detail={error} />;
  }

  return (
    <div className="moon-page-grid moon-browse-page">
      <section className="moon-panel moon-section moon-browse-hero">
        <div className="moon-section-head moon-browse-hero-head">
          <div>
            <span className="moon-kicker">Browse</span>
            <h2>Fast catalogue search</h2>
          </div>
          <span className="moon-muted">{searchLabel}</span>
        </div>
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
        <div className="moon-browse-filter-row" aria-label="Filter by media type">
          {ALL_TYPES.map((entry) => {
            const selected = entry.slug === activeType || (entry.slug === "all" && activeType === "all");
            const count = entry.slug === "all" ? catalogueTotal : Number.parseInt(String(typeCounts[entry.slug] || 0), 10) || 0;
            return (
              <button
                key={entry.slug}
                type="button"
                className={`moon-pill moon-filter-pill ${selected ? "is-active" : ""}`.trim()}
                aria-pressed={selected}
                onClick={() => updateType(entry.slug)}
              >
                <span>{entry.label}</span>
                <small>{count}</small>
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
              <span className="moon-kicker">{activeType === "all" ? "Catalogue" : activeType}</span>
              <h2>{resultTitle({query: activeQuery, type: activeType, letter: activeLetter})}</h2>
            </div>
            <span className="moon-muted">{refreshing ? "Updating loaded results" : `${visibleTotal} result${visibleTotal === 1 ? "" : "s"}`}</span>
          </div>
          {error ? <div className="moon-inline-error" role="status">{error}</div> : null}
          {pageTitles.length ? (
            <>
              <div className="moon-browse-grid">
                {pageTitles.map((title) => (
                  <TitleCard key={title.id} title={title} variant="browse" />
                ))}
              </div>
              {pageInfo?.hasMore ? (
                <div className="moon-browse-load-more">
                  <button type="button" className="moon-button" onClick={loadMore} disabled={loadingMore || refreshing}>
                    {loadingMore ? "Loading..." : "Load more"}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="moon-browse-empty">
              <h3>No titles match these filters</h3>
              <p>Try a broader title, alias, tag, or type filter.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default BrowsePageClient;
