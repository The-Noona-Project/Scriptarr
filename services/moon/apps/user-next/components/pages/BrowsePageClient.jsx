"use client";

/**
 * @file Browse page for Moon's Once UI Next user app.
 */

import {useDeferredValue, useEffect, useMemo, useRef, useState} from "react";
import {SegmentedControl} from "@once-ui-system/core";
import {useMoonJson} from "../../lib/api.js";
import {buildBrowseLetterState, buildBrowseSections, filterBrowseTitles} from "../../lib/browse.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import TitleCard from "../TitleCard.jsx";
import {AuthRequiredView, EmptyView, ErrorView, LoadingView} from "../StateView.jsx";

/**
 * Render the browse surface.
 *
 * @returns {import("react").ReactNode}
 */
export const BrowsePageClient = () => {
  const {auth, loginUrl} = useMoonChrome();
  const {loading, error, status, data} = useMoonJson("/api/moon-v3/user/library", {fallback: {titles: []}});
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const sectionRefs = useRef(new Map());

  const filteredTitles = useMemo(() => {
    return filterBrowseTitles(data?.titles, deferredSearch);
  }, [data?.titles, deferredSearch]);

  const sections = useMemo(() => buildBrowseSections(filteredTitles), [filteredTitles]);
  const letterState = useMemo(() => buildBrowseLetterState(filteredTitles), [filteredTitles]);
  const firstEnabledLetter = useMemo(
    () => letterState.find((entry) => !entry.disabled)?.letter || "A",
    [letterState]
  );
  const [activeLetter, setActiveLetter] = useState(firstEnabledLetter);

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
    const target = sectionRefs.current.get(letter);
    if (!target) {
      return;
    }
    setActiveLetter(letter);
    target.scrollIntoView({behavior: "smooth", block: "start"});
  };

  const searchLabel = useMemo(() => {
    if (!deferredSearch.trim()) {
      return `${filteredTitles.length} title${filteredTitles.length === 1 ? "" : "s"} in the library`;
    }
    return `${filteredTitles.length} match${filteredTitles.length === 1 ? "" : "es"} for "${deferredSearch.trim()}"`;
  }, [deferredSearch, filteredTitles.length]);

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
                <div className="moon-browse-segmented-control">
                  <SegmentedControl
                    buttons={letterButtons}
                    selected={activeLetter}
                    onToggle={jumpToLetter}
                    fillWidth={false}
                    compact
                  />
                </div>
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
              <section
                key={section.letter}
                className="moon-panel moon-section moon-browse-letter-section"
                ref={(node) => {
                  if (node) {
                    sectionRefs.current.set(section.letter, node);
                  } else {
                    sectionRefs.current.delete(section.letter);
                  }
                }}
              >
                <div className="moon-section-head moon-browse-letter-head">
                  <div>
                    <span className="moon-kicker">Letter</span>
                    <h2>{section.letter}</h2>
                  </div>
                  <span className="moon-muted">
                    {section.titles.length} title{section.titles.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="moon-browse-grid">
                  {section.titles.map((title) => (
                    <TitleCard key={title.id} title={title} variant="browse" />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : (
        <EmptyView title="No titles match that search" detail="Try a broader title, alias, tag, or type filter." />
      )}
    </div>
  );
};

export default BrowsePageClient;
