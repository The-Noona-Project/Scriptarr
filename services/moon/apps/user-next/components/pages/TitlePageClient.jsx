"use client";

/**
 * @file Chunked series detail page for Moon's Next user app.
 */

import {startTransition, useCallback, useEffect, useMemo, useRef, useState} from "react";
import {useRouter} from "next/navigation";
import dynamic from "next/dynamic";
import {requestJson, useMoonJson} from "../../lib/api.js";
import {clearPersistentMoonJsonCache} from "../../lib/persistentJsonCache.js";
import {buildReaderPathForTitle, buildTitlePathForTitle} from "../../lib/titleRoutes.js";
import {formatDate, formatProgress} from "../../lib/date.js";
import {Button, Flex} from "../UiPrimitives.jsx";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView, EmptyView, ErrorView} from "../StateView.jsx";

const CHAPTER_PAGE_SIZE = 40;
const CHAPTER_PAGE_SIZE_MAX = 100;
const normalizeString = (value) => String(value || "").trim();
const summaryFallback = {
  title: null,
  following: false,
  tagPreferences: {likedTags: [], dislikedTags: []},
  primaryChapter: null,
  latestChapter: null
};
const OnceSkeleton = dynamic(
  () => import("@once-ui-system/core/components/Skeleton").then((module) => module.Skeleton),
  {
    ssr: false,
    loading: () => <span className="moon-once-skeleton-fallback" />
  }
);
const OnceInfiniteScroll = dynamic(
  () => import("@once-ui-system/core/components/InfiniteScroll").then((module) => module.InfiniteScroll),
  {
    ssr: false
  }
);

const statePillCopy = (title, following) => {
  const userState = title?.userState || {};
  if (userState.completed) {
    return "Completed";
  }
  if (userState.bookshelf) {
    return "On bookshelf";
  }
  if (following) {
    return "Following";
  }
  if (userState.started) {
    return "In progress";
  }
  return "Unread";
};

const chapterLabel = (chapter) => chapter?.label || `Chapter ${chapter?.chapterNumber || "?"}`;

const TitleHeroSkeleton = () => (
  <section className="moon-title-detail-hero moon-title-skeleton" aria-busy="true" aria-label="Loading title summary">
    <div className="moon-title-cover-column">
      <div className="moon-title-cover moon-title-skeleton-cover">
        <OnceSkeleton shape="block" width="xl" height="xl" />
      </div>
      <div className="moon-title-read-meter">
        <OnceSkeleton shape="line" width="m" height="xs" />
        <OnceSkeleton shape="line" width="xl" height="xs" />
      </div>
    </div>
    <div className="moon-title-hero-copy">
      <OnceSkeleton shape="line" width="s" height="xs" />
      <div className="moon-title-skeleton-heading">
        <OnceSkeleton shape="line" width="xl" height="l" />
        <OnceSkeleton shape="line" width="l" height="l" delay={1} />
      </div>
      <div className="moon-title-skeleton-copy">
        <OnceSkeleton shape="line" width="xl" height="s" delay={2} />
        <OnceSkeleton shape="line" width="xl" height="s" delay={3} />
        <OnceSkeleton shape="line" width="m" height="s" delay={4} />
      </div>
      <div className="moon-pill-row">
        {Array.from({length: 6}).map((_, index) => (
          <span className="moon-pill moon-title-skeleton-pill" key={index}>
            <OnceSkeleton shape="line" width={index % 2 ? "s" : "m"} height="xs" delay={(index % 4) + 1} />
          </span>
        ))}
      </div>
      <div className="moon-title-action-strip">
        <OnceSkeleton shape="block" width="m" height="m" />
        <OnceSkeleton shape="block" width="m" height="m" delay={2} />
        <OnceSkeleton shape="block" width="s" height="m" delay={3} />
      </div>
    </div>
  </section>
);

const ChapterRowsSkeleton = () => (
  <div className="moon-title-chapter-list" aria-busy="true" aria-label="Loading chapters">
    {Array.from({length: 8}).map((_, index) => (
      <div className="moon-title-chapter-row moon-title-chapter-row-skeleton" key={index}>
        <OnceSkeleton shape="circle" width="s" height="s" delay={(index % 4) + 1} />
        <div className="moon-title-chapter-main">
          <OnceSkeleton shape="line" width="l" height="s" delay={(index % 4) + 1} />
          <OnceSkeleton shape="line" width="m" height="xs" delay={(index % 4) + 2} />
        </div>
        <div className="moon-title-chapter-meta">
          <OnceSkeleton shape="line" width="s" height="xs" delay={(index % 4) + 1} />
          <OnceSkeleton shape="line" width="s" height="xs" delay={(index % 4) + 2} />
        </div>
      </div>
    ))}
  </div>
);

/**
 * Render the title page.
 *
 * @param {{titleId: string, typeSlug?: string}} props
 * @returns {import("react").ReactNode}
 */
export const TitlePageClient = ({titleId, typeSlug = ""}) => {
  const router = useRouter();
  const {auth, branding, loginUrl} = useMoonChrome();
  const siteName = branding?.siteName || "Scriptarr";
  const {
    loading: summaryLoading,
    error: summaryError,
    status: summaryStatus,
    data: summaryData,
    refresh: refreshSummary,
    setData: setSummaryData
  } = useMoonJson(`/api/moon-v3/user/title/${encodeURIComponent(titleId)}/summary`, {
    fallback: summaryFallback,
    deps: [titleId]
  });
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState("chapters");
  const [chapterFilter, setChapterFilter] = useState("all");
  const [chapterSearch, setChapterSearch] = useState("");
  const [debouncedChapterSearch, setDebouncedChapterSearch] = useState("");
  const [chapterSort, setChapterSort] = useState("newest");
  const [loadedChapters, setLoadedChapters] = useState([]);
  const [chapterPageInfo, setChapterPageInfo] = useState({
    cursor: "0",
    nextCursor: "",
    hasMore: false,
    pageSize: CHAPTER_PAGE_SIZE,
    total: 0
  });
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [chaptersLoaded, setChaptersLoaded] = useState(false);
  const [chaptersError, setChaptersError] = useState("");
  const [requestsData, setRequestsData] = useState({requests: []});
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestsLoaded, setRequestsLoaded] = useState(false);
  const [requestsError, setRequestsError] = useState("");
  const [selectedChapterIds, setSelectedChapterIds] = useState(() => new Set());
  const [lastSelectedChapterId, setLastSelectedChapterId] = useState("");
  const [notice, setNotice] = useState("");
  const chapterRequestSeqRef = useRef(0);
  const requestsSeqRef = useRef(0);

  const title = summaryData?.title || null;
  const following = Boolean(summaryData?.following);
  const latestChapter = summaryData?.latestChapter || null;
  const primaryChapter = summaryData?.primaryChapter || latestChapter;
  const readRatio = title?.userState?.totalAvailableChapters
    ? title.userState.readAvailableCount / Math.max(1, title.userState.totalAvailableChapters)
    : 0;
  const selectedIds = useMemo(() => Array.from(selectedChapterIds), [selectedChapterIds]);
  const allLoadedSelected = loadedChapters.length > 0 && loadedChapters.every((chapter) => selectedChapterIds.has(chapter.id));
  const chapterQueryKey = [
    title?.id || titleId,
    chapterSort,
    chapterFilter,
    debouncedChapterSearch
  ].join(":");

  const clearCachedCardPayloads = () => auth?.discordUserId
    ? clearPersistentMoonJsonCache(auth.discordUserId)
    : Promise.resolve(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedChapterSearch(chapterSearch);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [chapterSearch]);

  useEffect(() => {
    if (title && title.libraryTypeSlug && typeSlug && typeSlug !== title.libraryTypeSlug) {
      router.replace(buildTitlePathForTitle(title));
    }
  }, [router, title, typeSlug]);

  const fetchChapterPage = useCallback(async ({cursor = "", append = false, pageSize = CHAPTER_PAGE_SIZE} = {}) => {
    if (!title?.id) {
      return false;
    }
    const requestSeq = chapterRequestSeqRef.current + 1;
    chapterRequestSeqRef.current = requestSeq;
    setChaptersLoading(true);
    setChaptersError("");
    const params = new URLSearchParams({
      pageSize: String(Math.min(CHAPTER_PAGE_SIZE_MAX, Math.max(1, pageSize))),
      sort: chapterSort,
      filter: chapterFilter
    });
    if (cursor) {
      params.set("cursor", cursor);
    }
    if (normalizeString(debouncedChapterSearch)) {
      params.set("q", debouncedChapterSearch);
    }
    const result = await requestJson(`/api/moon-v3/user/title/${encodeURIComponent(title.id)}/chapters?${params.toString()}`);
    if (requestSeq !== chapterRequestSeqRef.current) {
      return false;
    }
    setChaptersLoading(false);
    setChaptersLoaded(true);
    if (!result.ok) {
      setChaptersError(result.payload?.error || `${siteName} could not load chapters for this title.`);
      return false;
    }
    const nextRows = Array.isArray(result.payload?.chapters) ? result.payload.chapters : [];
    const nextPageInfo = result.payload?.pageInfo || {
      cursor: "0",
      nextCursor: "",
      hasMore: false,
      pageSize,
      total: nextRows.length
    };
    setLoadedChapters((current) => {
      const merged = append ? [...current, ...nextRows] : nextRows;
      const validIds = new Set(merged.map((chapter) => chapter.id));
      setSelectedChapterIds((selected) => new Set(Array.from(selected).filter((chapterId) => validIds.has(chapterId))));
      return merged;
    });
    setChapterPageInfo(nextPageInfo);
    return Boolean(nextPageInfo.hasMore);
  }, [chapterFilter, chapterSort, debouncedChapterSearch, siteName, title?.id]);

  const refreshLoadedChapters = useCallback(async () => {
    const targetPageSize = Math.min(CHAPTER_PAGE_SIZE_MAX, Math.max(CHAPTER_PAGE_SIZE, loadedChapters.length || 0));
    await fetchChapterPage({cursor: "", append: false, pageSize: targetPageSize});
  }, [fetchChapterPage, loadedChapters.length]);

  useEffect(() => {
    setLoadedChapters([]);
    setChapterPageInfo({
      cursor: "0",
      nextCursor: "",
      hasMore: false,
      pageSize: CHAPTER_PAGE_SIZE,
      total: 0
    });
    setChaptersLoaded(false);
    setChaptersError("");
    setSelectedChapterIds(new Set());
    setLastSelectedChapterId("");
    chapterRequestSeqRef.current += 1;
    if (title?.id) {
      void fetchChapterPage({cursor: "", append: false});
    }
  }, [chapterQueryKey, fetchChapterPage, title?.id]);

  const fetchRequests = useCallback(async () => {
    if (!title?.id || requestsLoading || requestsLoaded) {
      return;
    }
    const requestSeq = requestsSeqRef.current + 1;
    requestsSeqRef.current = requestSeq;
    setRequestsLoading(true);
    setRequestsError("");
    const result = await requestJson(`/api/moon-v3/user/title/${encodeURIComponent(title.id)}/requests`);
    if (requestSeq !== requestsSeqRef.current) {
      return;
    }
    setRequestsLoading(false);
    setRequestsLoaded(true);
    if (!result.ok) {
      setRequestsError(result.payload?.error || `${siteName} could not load request history for this title.`);
      return;
    }
    setRequestsData({requests: Array.isArray(result.payload?.requests) ? result.payload.requests : []});
  }, [requestsLoaded, requestsLoading, siteName, title?.id]);

  useEffect(() => {
    if (activeTab === "requests") {
      void fetchRequests();
    }
  }, [activeTab, fetchRequests]);

  if (summaryStatus === 401 && !auth) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        title="Sign in to open this title"
        detail="Connect your Discord account to browse title metadata, requests, and readable chapters."
      />
    );
  }

  if (summaryError) {
    return <ErrorView detail={summaryError} />;
  }

  if (!title && !summaryLoading) {
    return <EmptyView title="Title unavailable" detail={`${siteName} could not find this series in the current library.`} />;
  }

  const syncSummaryFromPayload = async (result) => {
    if (result.ok && result.payload?.title) {
      setSummaryData((current) => ({
        ...current,
        title: result.payload.title,
        following: result.payload.following ?? current.following,
        tagPreferences: result.payload.tagPreferences || current.tagPreferences,
        primaryChapter: result.payload.primaryChapter ?? current.primaryChapter,
        latestChapter: result.payload.latestChapter ?? current.latestChapter
      }));
      return;
    }
    await refreshSummary();
  };

  const runBusy = (task) => {
    setBusy(true);
    setNotice("");
    startTransition(() => {
      void (async () => {
        try {
          await task();
        } finally {
          setBusy(false);
        }
      })();
    });
  };

  const toggleFollow = () => {
    if (!title) {
      return;
    }
    runBusy(async () => {
      const nextResult = following
        ? await requestJson(`/api/moon-v3/user/following/${encodeURIComponent(title.id)}`, {method: "DELETE"})
        : await requestJson("/api/moon-v3/user/following", {
          method: "POST",
          json: {
            titleId: title.id,
            title: title.title,
            latestChapter: title.latestChapter,
            mediaType: title.mediaType,
            libraryTypeLabel: title.libraryTypeLabel,
            libraryTypeSlug: title.libraryTypeSlug
          }
        });
      if (nextResult.ok) {
        await clearCachedCardPayloads();
        setSummaryData((current) => ({
          ...current,
          following: !following,
          title: current.title ? {
            ...current.title,
            userState: {
              ...(current.title.userState || {}),
              following: !following
            }
          } : current.title
        }));
      } else {
        await refreshSummary();
      }
    });
  };

  const updateTagPreference = (tag, preference) => {
    runBusy(async () => {
      const result = await requestJson("/api/moon-v3/user/tag-preferences", {
        method: "PUT",
        json: {tag, preference}
      });
      if (result.ok) {
        await clearCachedCardPayloads();
      }
      await refreshSummary();
    });
  };

  const updateTitleReadState = (mode) => {
    if (!title) {
      return;
    }
    runBusy(async () => {
      const result = await requestJson(`/api/moon-v3/user/title/${encodeURIComponent(title.id)}/${mode}?view=compact`, {
        method: "POST"
      });
      if (result.ok) {
        await clearCachedCardPayloads();
      }
      await syncSummaryFromPayload(result);
      await refreshLoadedChapters();
      setNotice(mode === "read" ? "Title marked read." : "Title reset off your bookshelf.");
    });
  };

  const resetTitleOffShelf = () => {
    const confirmed = window.confirm("Reset this title off your bookshelf? This clears title read state, chapter read state, reader progress, and title bookmarks. Follows stay.");
    if (confirmed) {
      updateTitleReadState("unread");
    }
  };

  const updateChapterReadState = (targetChapterId, mode) => {
    if (!title) {
      return;
    }
    runBusy(async () => {
      const result = await requestJson(
        `/api/moon-v3/user/title/${encodeURIComponent(title.id)}/chapters/${encodeURIComponent(targetChapterId)}/${mode}?view=compact`,
        {method: "POST"}
      );
      if (result.ok) {
        await clearCachedCardPayloads();
      }
      await syncSummaryFromPayload(result);
      await refreshLoadedChapters();
      setNotice(mode === "read" ? "Chapter marked read." : "Chapter marked unread.");
    });
  };

  const toggleChapterSelection = (targetChapterId, checked, event) => {
    const shiftKey = event?.shiftKey || event?.nativeEvent?.shiftKey;
    const loadedIds = loadedChapters.map((chapter) => chapter.id);
    setSelectedChapterIds((current) => {
      const next = new Set(current);
      const lastIndex = loadedIds.indexOf(lastSelectedChapterId);
      const targetIndex = loadedIds.indexOf(targetChapterId);
      if (shiftKey && lastIndex >= 0 && targetIndex >= 0) {
        const [start, end] = lastIndex < targetIndex ? [lastIndex, targetIndex] : [targetIndex, lastIndex];
        for (const chapterId of loadedIds.slice(start, end + 1)) {
          if (checked) {
            next.add(chapterId);
          } else {
            next.delete(chapterId);
          }
        }
      } else if (checked) {
        next.add(targetChapterId);
      } else {
        next.delete(targetChapterId);
      }
      return next;
    });
    setLastSelectedChapterId(targetChapterId);
  };

  const toggleLoadedSelection = () => {
    setSelectedChapterIds((current) => {
      const next = new Set(current);
      if (allLoadedSelected) {
        for (const chapter of loadedChapters) {
          next.delete(chapter.id);
        }
      } else {
        for (const chapter of loadedChapters) {
          next.add(chapter.id);
        }
      }
      return next;
    });
  };

  const runBulkAction = (action) => {
    if (!title || !selectedIds.length) {
      return;
    }
    if (action === "reset") {
      const confirmed = window.confirm(`Reset ${selectedIds.length} selected chapter${selectedIds.length === 1 ? "" : "s"}? This clears selected chapter read state and bookmarks, and clears title progress when it points into the selection.`);
      if (!confirmed) {
        return;
      }
    }
    runBusy(async () => {
      const result = await requestJson(`/api/moon-v3/user/title/${encodeURIComponent(title.id)}/chapters/bulk-read-state?view=compact`, {
        method: "POST",
        json: {
          action,
          chapterIds: selectedIds
        }
      });
      if (result.ok) {
        await clearCachedCardPayloads();
      }
      await syncSummaryFromPayload(result);
      await refreshLoadedChapters();
      if (result.ok) {
        setSelectedChapterIds(new Set());
        const resetDetails = action === "reset"
          ? ` Cleared ${result.payload?.clearedBookmarkCount || 0} bookmark${result.payload?.clearedBookmarkCount === 1 ? "" : "s"}${result.payload?.clearedProgress ? " and reader progress" : ""}.`
          : "";
        setNotice(`${selectedIds.length} loaded chapter${selectedIds.length === 1 ? "" : "s"} updated.${resetDetails}`);
      }
    });
  };

  const renderChapterRow = (chapter) => (
    <div key={chapter.id} className={`moon-title-chapter-row ${chapter.read ? "is-read" : "is-unread"}`}>
      <input
        aria-label={`Select ${chapterLabel(chapter)}`}
        checked={selectedChapterIds.has(chapter.id)}
        type="checkbox"
        onChange={(event) => toggleChapterSelection(chapter.id, event.target.checked, event)}
      />
      <a className="moon-chapter-title-link moon-title-chapter-main" href={buildReaderPathForTitle(title, chapter.id)}>
        <strong>{chapterLabel(chapter)}</strong>
        <span>{chapter.id}</span>
      </a>
      <div className="moon-title-chapter-meta">
        <span>{formatDate(chapter.releaseDate)}</span>
        <span>{chapter.pageCount || 0} pages</span>
      </div>
      <span className={`moon-title-state-chip ${chapter.read ? "is-read" : "is-unread"}`}>
        {chapter.read ? "Read" : "Unread"}
      </span>
      <div className="moon-chapter-actions">
        <a className="moon-chapter-open-link" href={buildReaderPathForTitle(title, chapter.id)}>Open</a>
        <button
          type="button"
          onClick={() => updateChapterReadState(chapter.id, chapter.read ? "unread" : "read")}
          disabled={busy}
        >
          {chapter.read ? "Mark unread" : "Mark read"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="moon-title-page">
      {title ? (
        <section className="moon-title-detail-hero">
          <div className="moon-title-cover-column">
            <div className="moon-title-cover">
              {title.coverUrl ? (
                <img src={title.coverUrl} alt={`${title.title} cover`} loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <div className="moon-title-card-fallback"><span>{title.title.charAt(0)}</span></div>
              )}
            </div>
            <div className="moon-title-read-meter">
              <span>{formatProgress(readRatio)}</span>
              <div><i style={{width: `${Math.round(readRatio * 100)}%`}} /></div>
            </div>
          </div>

          <div className="moon-title-hero-copy">
            <span className="moon-kicker">{title.libraryTypeLabel || title.mediaType || "Title"}</span>
            <h1>{title.title}</h1>
            <p className="moon-support-copy">{title.summary || "A richer description has not been matched for this title yet."}</p>
            <div className="moon-pill-row">
              <span className="moon-pill is-strong">{statePillCopy(title, following)}</span>
              <span className="moon-pill">{title.userState?.readAvailableCount || 0}/{title.userState?.totalAvailableChapters || 0} read</span>
              <span className="moon-pill">{title.status || "active"}</span>
              <span className="moon-pill">{title.metadataProvider || "Metadata gap"}</span>
              <span className="moon-pill">{title.releaseLabel || "Release date unknown"}</span>
              <span className="moon-pill">{title.latestChapter || "No chapter summary yet"}</span>
            </div>

            <div className="moon-title-action-strip">
              {primaryChapter ? (
                <Button href={buildReaderPathForTitle(title, primaryChapter.id)} variant="primary" size="l">
                  {title.userState?.started && !title.userState?.completed ? "Continue" : "Read next"}
                </Button>
              ) : null}
              {latestChapter && latestChapter.id !== primaryChapter?.id ? (
                <Button href={buildReaderPathForTitle(title, latestChapter.id)} variant="secondary" size="l">
                  Read latest
                </Button>
              ) : null}
              <Button variant="secondary" size="l" onClick={toggleFollow} disabled={busy}>
                {following ? "Unfollow" : "Follow"}
              </Button>
              <Button
                variant="secondary"
                size="l"
                onClick={() => updateTitleReadState("read")}
                disabled={busy || title.userState?.completed}
              >
                Mark title read
              </Button>
              <button className="moon-title-danger-button" type="button" onClick={resetTitleOffShelf} disabled={busy || !title.userState?.started}>
                Reset off shelf
              </button>
            </div>

            <div className="moon-title-status-grid">
              <div>
                <span className="moon-kicker">Next up</span>
                <strong>{primaryChapter?.label || title.userState?.chapterLabel || "No readable chapters"}</strong>
              </div>
              <div>
                <span className="moon-kicker">Unread</span>
                <strong>{title.userState?.unreadAvailableCount || 0}</strong>
              </div>
              <div>
                <span className="moon-kicker">Following</span>
                <strong>{following ? "Yes" : "No"}</strong>
              </div>
            </div>
            {notice ? <p className="moon-title-notice">{notice}</p> : null}
          </div>
        </section>
      ) : (
        <TitleHeroSkeleton />
      )}

      <section className="moon-title-tabs">
        {[
          {id: "chapters", label: "Chapters"},
          {id: "details", label: "Details"},
          {id: "requests", label: `Requests ${requestsLoaded && requestsData.requests.length ? `(${requestsData.requests.length})` : ""}`}
        ].map((tab) => (
          <button
            className={activeTab === tab.id ? "is-active" : ""}
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </section>

      {activeTab === "chapters" ? (
        <section className="moon-title-chapter-surface">
          <div className="moon-title-chapter-tools">
            <label>
              <span>Search</span>
              <input
                value={chapterSearch}
                placeholder="Chapter, number, date"
                onChange={(event) => setChapterSearch(event.target.value)}
              />
            </label>
            <label>
              <span>Filter</span>
              <select value={chapterFilter} onChange={(event) => setChapterFilter(event.target.value)}>
                <option value="all">All</option>
                <option value="unread">Unread</option>
                <option value="read">Read</option>
              </select>
            </label>
            <label>
              <span>Sort</span>
              <select value={chapterSort} onChange={(event) => setChapterSort(event.target.value)}>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="number-desc">Chapter desc</option>
                <option value="number-asc">Chapter asc</option>
              </select>
            </label>
            <button type="button" onClick={toggleLoadedSelection} disabled={!loadedChapters.length}>
              {allLoadedSelected ? "Clear loaded" : "Select loaded"}
            </button>
          </div>

          {selectedIds.length ? (
            <div className="moon-title-bulk-toolbar">
              <strong>{selectedIds.length} loaded selected</strong>
              <Flex gap="8" wrap>
                <button type="button" onClick={() => runBulkAction("read")} disabled={busy}>Mark read</button>
                <button type="button" onClick={() => runBulkAction("unread")} disabled={busy}>Mark unread</button>
                <button className="is-danger" type="button" onClick={() => runBulkAction("reset")} disabled={busy}>Reset selected</button>
                <button type="button" onClick={() => setSelectedChapterIds(new Set())} disabled={busy}>Clear</button>
              </Flex>
            </div>
          ) : null}

          {chaptersError ? <ErrorView detail={chaptersError} /> : null}

          {!chaptersLoaded && chaptersLoading ? (
            <ChapterRowsSkeleton />
          ) : loadedChapters.length ? (
            <>
              <div className="moon-title-chapter-list" data-total={chapterPageInfo.total}>
                <OnceInfiniteScroll
                  key={chapterQueryKey}
                  items={loadedChapters}
                  loading={chaptersLoading}
                  threshold={320}
                  loadMore={() => fetchChapterPage({
                    cursor: chapterPageInfo.nextCursor,
                    append: true
                  })}
                  renderItem={renderChapterRow}
                />
              </div>
              <div className="moon-title-chapter-page-foot">
                <span>{loadedChapters.length}/{chapterPageInfo.total || loadedChapters.length} loaded</span>
                {chaptersLoading ? <span>Loading more...</span> : null}
              </div>
            </>
          ) : chaptersLoaded ? (
            <EmptyView title="No chapters match" detail="Adjust the chapter filters or search." />
          ) : (
            <ChapterRowsSkeleton />
          )}
        </section>
      ) : null}

      {activeTab === "details" && title ? (
        <section className="moon-title-detail-grid">
          <div className="moon-title-detail-panel">
            <span className="moon-kicker">Metadata</span>
            <dl>
              <div><dt>Status</dt><dd>{title.status || "Unknown"}</dd></div>
              <div><dt>Provider</dt><dd>{title.metadataProvider || "Unmatched"}</dd></div>
              <div><dt>Latest chapter</dt><dd>{title.latestChapter || "Unknown"}</dd></div>
              <div><dt>Coverage</dt><dd>{title.chaptersDownloaded || 0}/{title.chapterCount || 0}</dd></div>
            </dl>
          </div>
          <div className="moon-title-detail-panel">
            <span className="moon-kicker">Tag preferences</span>
            {Array.isArray(title.tagPreferences) && title.tagPreferences.length ? (
              <div className="moon-tag-preference-list">
                {title.tagPreferences.map((entry) => (
                  <div key={entry.tag} className={`moon-tag-preference-chip is-${entry.preference || "neutral"}`}>
                    <span className="moon-pill">{entry.tag}</span>
                    <div className="moon-tag-preference-actions">
                      <button type="button" onClick={() => updateTagPreference(entry.tag, "like")} disabled={busy}>Like</button>
                      <button type="button" onClick={() => updateTagPreference(entry.tag, "dislike")} disabled={busy}>Hide</button>
                      {entry.preference ? (
                        <button type="button" onClick={() => updateTagPreference(entry.tag, "clear")} disabled={busy}>Clear</button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="moon-muted">No tag preferences are available for this title.</p>
            )}
          </div>
        </section>
      ) : null}

      {activeTab === "requests" && title ? (
        <section className="moon-title-detail-panel">
          <span className="moon-kicker">Request history</span>
          {requestsLoading ? (
            <div className="moon-title-request-list" aria-busy="true">
              {Array.from({length: 3}).map((_, index) => (
                <div key={index} className="moon-title-request-row moon-title-request-row-skeleton">
                  <OnceSkeleton shape="line" width="m" height="s" delay={index + 1} />
                  <OnceSkeleton shape="line" width="s" height="xs" delay={index + 2} />
                  <OnceSkeleton shape="line" width="xl" height="xs" delay={index + 3} />
                </div>
              ))}
            </div>
          ) : requestsError ? (
            <ErrorView detail={requestsError} />
          ) : requestsData.requests.length ? (
            <div className="moon-title-request-list">
              {requestsData.requests.map((request) => (
                <div key={request.id || `${request.title}:${request.status}`} className="moon-title-request-row">
                  <strong>{request.title || title.title}</strong>
                  <span>{request.status || "unknown"}</span>
                  <p>{request.notes || request.message || request.details?.query || "No request notes."}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="moon-muted">No {siteName} requests are tied to this title for your account.</p>
          )}
        </section>
      ) : null}
    </div>
  );
};

export default TitlePageClient;
