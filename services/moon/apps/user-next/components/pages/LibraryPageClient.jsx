"use client";

/**
 * @file Library page for Moon's Once UI Next user app.
 */

import {useMemo} from "react";
import Link from "next/link";
import {useMoonJson} from "../../lib/api.js";
import {buildLibraryPath, formatTypeLabel, getLibraryTypes} from "../../lib/routes.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import TitleCard from "../TitleCard.jsx";
import {AuthRequiredView, EmptyView, ErrorView, LoadingView} from "../StateView.jsx";

/**
 * Render the library surface, optionally scoped to a type.
 *
 * @param {{typeSlug?: string}} props
 * @returns {import("react").ReactNode}
 */
export const LibraryPageClient = ({typeSlug = ""}) => {
  const {auth, loginUrl} = useMoonChrome();
  const {loading, error, status, data} = useMoonJson("/api/moon-v3/user/library", {fallback: {titles: []}});

  const filteredTitles = useMemo(() => {
    const titles = Array.isArray(data?.titles) ? data.titles : [];
    if (!typeSlug) {
      return titles;
    }
    return titles.filter((title) => (title.libraryTypeSlug || title.mediaType) === typeSlug);
  }, [data?.titles, typeSlug]);

  if (loading) {
    return <LoadingView label="Moon is building the type-scoped library index." />;
  }

  if (status === 401 && !auth) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        title="Sign in to open your library"
        detail="Your library shelves, type views, and reading history all live behind your Moon session."
      />
    );
  }

  if (error) {
    return <ErrorView detail={error} />;
  }

  return (
    <div className="moon-page-grid">
      <section className="moon-panel moon-section">
        <div className="moon-section-head">
          <div>
            <span className="moon-kicker">Library</span>
            <h2>{typeSlug ? formatTypeLabel(typeSlug) : "All tracked types"}</h2>
          </div>
        </div>
        <div className="moon-pill-row">
          <Link className="moon-pill" href="/library">All</Link>
          {getLibraryTypes().map((entry) => (
            <Link key={entry.slug} className="moon-pill" href={buildLibraryPath(entry.slug)}>
              {entry.label}
            </Link>
          ))}
        </div>
      </section>
      {filteredTitles.length ? (
        <section className="moon-panel moon-section">
          <div className="moon-card-row">
            {filteredTitles.map((title) => (
              <TitleCard key={title.id} title={title} />
            ))}
          </div>
        </section>
      ) : (
        <EmptyView title="No titles in this shelf yet" detail="Raven will surface titles here once this type has imported chapters." />
      )}
    </div>
  );
};

export default LibraryPageClient;
