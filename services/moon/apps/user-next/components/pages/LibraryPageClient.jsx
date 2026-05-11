"use client";

/**
 * @file Library page for Moon's Next user app.
 */

import {useEffect, useMemo, useState} from "react";
import Link from "next/link";
import {requestJson, useMoonJson} from "../../lib/api.js";
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
  const libraryUrl = useMemo(() => {
    const params = new URLSearchParams({view: "card", pageSize: "100"});
    if (typeSlug) {
      params.set("type", typeSlug);
    }
    return `/api/moon-v3/user/library?${params.toString()}`;
  }, [typeSlug]);
  const {loading, error, status, data} = useMoonJson(libraryUrl, {
    fallback: {titles: [], pageInfo: {hasMore: false, nextCursor: "", total: 0}}
  });
  const [titles, setTitles] = useState([]);
  const [pageInfo, setPageInfo] = useState({hasMore: false, nextCursor: "", total: 0});
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setTitles(Array.isArray(data?.titles) ? data.titles : []);
    setPageInfo(data?.pageInfo || {hasMore: false, nextCursor: "", total: 0});
  }, [data?.pageInfo, data?.titles]);

  const loadMore = async () => {
    if (!pageInfo?.hasMore || loadingMore) {
      return;
    }
    setLoadingMore(true);
    const params = new URLSearchParams({
      view: "card",
      pageSize: "100",
      cursor: String(pageInfo.nextCursor || "")
    });
    if (typeSlug) {
      params.set("type", typeSlug);
    }
    const result = await requestJson(`/api/moon-v3/user/library?${params.toString()}`);
    if (result.ok) {
      setTitles((current) => [...current, ...(Array.isArray(result.payload?.titles) ? result.payload.titles : [])]);
      setPageInfo(result.payload?.pageInfo || {hasMore: false, nextCursor: "", total: 0});
    }
    setLoadingMore(false);
  };

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
      {titles.length ? (
        <section className="moon-panel moon-section">
          <div className="moon-card-row">
            {titles.map((title) => (
              <TitleCard key={title.id} title={title} />
            ))}
          </div>
          {pageInfo?.hasMore ? (
            <button type="button" className="moon-button" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          ) : null}
        </section>
      ) : (
        <EmptyView title="No titles in this shelf yet" detail="Raven will surface titles here once this type has imported chapters." />
      )}
    </div>
  );
};

export default LibraryPageClient;
