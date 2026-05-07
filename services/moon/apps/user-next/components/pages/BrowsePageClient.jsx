"use client";

/**
 * @file Browse page for Moon's Once UI Next user app.
 */

import {useDeferredValue, useEffect, useMemo, useRef, useState} from "react";
import {SegmentedControl} from "@once-ui-system/core";
import {requestJson, useMoonJson} from "../../lib/api.js";
import {BROWSE_LETTERS, buildBrowseSections} from "../../lib/browse.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import BrowseLetterRow from "../browse/BrowseLetterRow.jsx";
import {AuthRequiredView, EmptyView, ErrorView, LoadingView} from "../StateView.jsx";

/**
 * Render the browse surface.
 *
 * @returns {import("react").ReactNode}
 */
export const BrowsePageClient = () => {
  const {auth, loginUrl} = useMoonChrome();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const sectionRefs = useRef(new Map());
  const [activeLetter, setActiveLetter] = useState("A");
  const [pageTitles, setPageTitles] = useState([]);
  const [pageInfo, setPageInfo] = useState({hasMore: false, nextCursor: "", total: 0});
  const [loadingMore, setLoadingMore] = useState(false);
  const libraryUrl = useMemo(() => {
    const params = new URLSearchParams({
      view: "card",
      pageSize: "60",
      letter: activeLetter
    });
    const query = deferredSearch.trim();
    if (query) {
      params.set("q", query);
    }
    return `/api/moon-v3/user/library?${params.toString()}`;
  }, [activeLetter, deferredSearch]);
  const {loading, error, status, data} = useMoonJson(libraryUrl, {
    fallback: {titles: [], counts: {total: 0, byLetter: {}}, pageInfo: {total: 0}}
  });

  useEffect(() => {
    setPageTitles(Array.isArray(data?.titles) ? data.titles : []);
    setPageInfo(data?.pageInfo || {hasMore: false, nextCursor: "", total: 0});
  }, [data?.pageInfo, data?.titles]);

  const sections = useMemo(() => buildBrowseSections(pageTitles), [pageTitles]);
  const letterState = useMemo(() => {
    const counts = data?.counts?.byLetter && typeof data.counts.byLetter === "object" ? data.counts.byLetter : {};
    return BROWSE_LETTERS.map((letter) => {
      const count = Number.parseInt(String(counts[letter] || 0), 10) || 0;
      return {letter, count, disabled: count === 0};
    });
  }, [data?.counts?.byLetter]);
  const firstEnabledLetter = useMemo(
    () => letterState.find((entry) => !entry.disabled)?.letter || "A",
    [letterState]
  );

  useEffect(() => {
    if (!letterState.some((entry) => entry.letter === activeLetter && !entry.disabled)) {
      setActiveLetter(firstEnabledLetter);
    }
  }, [activeLetter, firstEnabledLetter, letterState]);

  const letterButtons = useMemo(() => letterState.map((entry) => ({
    label: entry.letter,
    value: entry.letter,
    size: "s",
    disabled: entry.disabled
  })), [letterState]);

  const jumpToLetter = (letter) => {
    setActiveLetter(letter);
    const target = sectionRefs.current.get(letter);
    if (!target) {
      return;
    }
    target.scrollIntoView({behavior: "smooth", block: "start"});
  };

  const loadMore = async () => {
    if (!pageInfo?.hasMore || loadingMore) {
      return;
    }
    setLoadingMore(true);
    const params = new URLSearchParams({
      view: "card",
      pageSize: "60",
      letter: activeLetter,
      cursor: String(pageInfo.nextCursor || "")
    });
    const query = deferredSearch.trim();
    if (query) {
      params.set("q", query);
    }
    const result = await requestJson(`/api/moon-v3/user/library?${params.toString()}`);
    if (result.ok) {
      setPageTitles((current) => [...current, ...(Array.isArray(result.payload?.titles) ? result.payload.titles : [])]);
      setPageInfo(result.payload?.pageInfo || {hasMore: false, nextCursor: "", total: 0});
    }
    setLoadingMore(false);
  };

  const searchLabel = useMemo(() => {
    const count = Number.parseInt(String(data?.counts?.total ?? data?.pageInfo?.total ?? 0), 10) || 0;
    if (!deferredSearch.trim()) {
      return `${count} title${count === 1 ? "" : "s"} in the library`;
    }
    return `${count} match${count === 1 ? "" : "es"} for "${deferredSearch.trim()}"`;
  }, [data?.counts?.total, data?.pageInfo?.total, deferredSearch]);

  if (loading) {
    return <LoadingView label="Moon is indexing every title so browse can stay fast while you search." />;
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

  if (error) {
    return <ErrorView detail={error} />;
  }

  return (
    <div className="moon-page-grid moon-browse-page">
      <section className="moon-panel moon-section">
        <div className="moon-section-head">
          <div>
            <span className="moon-kicker">Browse</span>
            <h2>Browse every title from A to Z</h2>
          </div>
          <span className="moon-muted">{searchLabel}</span>
        </div>
        <input
          className="moon-search-bar"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search titles, aliases, tags, or type"
        />
      </section>
      {sections.length ? (
        <div className="moon-browse-layout">
          <aside className="moon-browse-rail">
            <div className="moon-browse-rail-stick">
              <span className="moon-kicker">Jump to</span>
              <div className="moon-browse-rail-desktop">
                <nav className="moon-browse-letter-index" aria-label="Browse by letter">
                  {letterState.map((entry) => (
                    <button
                      key={entry.letter}
                      type="button"
                      className={`moon-browse-letter-button ${entry.letter === activeLetter ? "is-active" : ""}`.trim()}
                      disabled={entry.disabled}
                      aria-current={entry.letter === activeLetter ? "true" : undefined}
                      onClick={() => jumpToLetter(entry.letter)}
                    >
                      {entry.letter}
                    </button>
                  ))}
                </nav>
              </div>
              <div className="moon-browse-rail-mobile">
                <SegmentedControl
                  buttons={letterButtons}
                  selected={activeLetter}
                  onToggle={jumpToLetter}
                  fillWidth={false}
                  compact
                />
              </div>
            </div>
          </aside>
          <div className="moon-browse-content">
            {sections.map((section) => (
              <BrowseLetterRow
                key={section.letter}
                section={section}
                sectionRef={(node) => {
                  if (node) {
                    sectionRefs.current.set(section.letter, node);
                  } else {
                    sectionRefs.current.delete(section.letter);
                  }
                }}
              />
            ))}
            {pageInfo?.hasMore ? (
              <section className="moon-panel moon-section">
                <button type="button" className="moon-button" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              </section>
            ) : null}
          </div>
        </div>
      ) : (
        <EmptyView title="No titles match that search" detail="Try a broader title, alias, tag, or type filter." />
      )}
    </div>
  );
};

export default BrowsePageClient;
