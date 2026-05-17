"use client";

/**
 * @file Library page for Moon's Next user app.
 */

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import Link from "next/link";
import {requestJson, useMoonJson} from "../../lib/api.js";
import {buildLibraryPath, formatTypeLabel, getLibraryTypes} from "../../lib/navigationRoutes.js";
import {mergePagedTitleRows} from "../../lib/titleList.js";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import LibraryTitleRow from "../LibraryTitleRow.jsx";
import {AuthRequiredView, EmptyView, ErrorView} from "../StateView.jsx";
import {TitleListInfiniteScroll, TitleRowListSkeleton} from "../TitleListLoading.jsx";

/**
 * Render the library surface, optionally scoped to a type.
 *
 * @param {{typeSlug?: string}} props
 * @returns {import("react").ReactNode}
 */
export const LibraryPageClient = ({typeSlug = ""}) => {
  const {auth, branding, loginUrl, libraryTypes: chromeLibraryTypes = []} = useMoonChrome();
  const siteName = branding?.siteName || "Scriptarr";
  const libraryUrl = useMemo(() => {
    const params = new URLSearchParams({view: "card", pageSize: "100"});
    if (typeSlug) {
      params.set("type", typeSlug);
    }
    return `/api/moon-v3/user/library?${params.toString()}`;
  }, [typeSlug]);
  const {loading, refreshing, error, status, data} = useMoonJson(libraryUrl, {
    keepPreviousData: true,
    fallback: {titles: [], pageInfo: {hasMore: false, nextCursor: "", total: 0}},
    persistentCache: {userKey: auth?.discordUserId, scope: "library"}
  });
  const [titles, setTitles] = useState([]);
  const [pageInfo, setPageInfo] = useState({hasMore: false, nextCursor: "", total: 0});
  const [loadingMore, setLoadingMore] = useState(false);
  const currentRequestRef = useRef("");
  const loadMoreSeqRef = useRef(0);
  const visibleLibraryTypes = useMemo(() => {
    if (Array.isArray(chromeLibraryTypes) && chromeLibraryTypes.length) {
      return chromeLibraryTypes;
    }
    return typeSlug ? [] : getLibraryTypes(data?.counts?.byType);
  }, [chromeLibraryTypes, data?.counts?.byType, typeSlug]);

  useEffect(() => {
    currentRequestRef.current = libraryUrl;
  }, [libraryUrl]);

  useEffect(() => {
    setTitles(mergePagedTitleRows([], data?.titles, {append: false}));
    setPageInfo(data?.pageInfo || {hasMore: false, nextCursor: "", total: 0});
  }, [data?.pageInfo, data?.titles]);

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
    const params = new URLSearchParams({
      view: "card",
      pageSize: "100",
      cursor
    });
    if (typeSlug) {
      params.set("type", typeSlug);
    }
    try {
      const result = await requestJson(`/api/moon-v3/user/library?${params.toString()}`);
      if (!result.ok || requestKey !== currentRequestRef.current) {
        return Boolean(pageInfo?.hasMore);
      }
      const nextPageInfo = result.payload?.pageInfo || {hasMore: false, nextCursor: "", total: 0};
      setTitles((current) => mergePagedTitleRows(current, result.payload?.titles, {append: true}));
      setPageInfo(nextPageInfo);
      return Boolean(nextPageInfo.hasMore && nextPageInfo.nextCursor);
    } finally {
      if (requestSeq === loadMoreSeqRef.current) {
        setLoadingMore(false);
      }
    }
  }, [libraryUrl, loadingMore, pageInfo, refreshing, typeSlug]);

  if (status === 401 && !auth) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        title="Sign in to open your library"
        detail={`Your library shelves, type views, and reading history all live behind your ${siteName} session.`}
      />
    );
  }

  if (error && !titles.length) {
    return <ErrorView detail={error} />;
  }
  const showInitialSkeleton = loading && !titles.length;

  return (
    <div className="moon-page-grid">
      <section className="moon-panel moon-section">
        <div className="moon-section-head">
          <div>
            <span className="moon-kicker">Library</span>
            <h2>{typeSlug ? formatTypeLabel(typeSlug) : "All tracked types"}</h2>
          </div>
          <span className="moon-muted">{refreshing ? "Updating loaded titles" : `${pageInfo?.total || titles.length} title${(pageInfo?.total || titles.length) === 1 ? "" : "s"}`}</span>
        </div>
        <div className="moon-pill-row">
          <Link className="moon-pill" href="/library">All</Link>
          {visibleLibraryTypes.map((entry) => (
            <Link key={entry.slug} className="moon-pill" href={buildLibraryPath(entry.slug)}>
              {entry.label}
            </Link>
          ))}
        </div>
      </section>
      <section className={`moon-panel moon-section ${refreshing ? "is-refreshing" : ""}`.trim()}>
        {error ? <div className="moon-inline-error" role="status">{error}</div> : null}
        {showInitialSkeleton ? (
          <TitleRowListSkeleton count={8} />
        ) : titles.length ? (
          <>
            <div className="moon-library-title-list">
              <TitleListInfiniteScroll
                key={libraryUrl}
                items={titles}
                loading={loadingMore}
                threshold={360}
                className="moon-infinite-list-sentinel"
                loadMore={loadMore}
                renderItem={(title) => (
                  <LibraryTitleRow key={title.id} title={title} />
                )}
              />
            </div>
            {loadingMore ? <TitleRowListSkeleton count={3} /> : null}
            {pageInfo?.hasMore ? (
              <div className="moon-browse-load-more">
                <button type="button" className="moon-button" onClick={loadMore} disabled={loadingMore || refreshing}>
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyView title="No titles in this shelf yet" detail="Imported titles will appear here once this type has readable chapters." />
        )}
      </section>
    </div>
  );
};

export default LibraryPageClient;
