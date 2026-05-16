"use client";

/**
 * @file Series detail page for Moon's Next user app.
 */

import {startTransition, useEffect, useMemo, useState} from "react";
import {useRouter} from "next/navigation";
import {requestJson, useMoonJson} from "../../lib/api.js";
import {buildReaderPathForTitle, buildTitlePathForTitle} from "../../lib/routes.js";
import {formatDate, formatProgress} from "../../lib/date.js";
import {Button, Flex} from "../UiPrimitives.jsx";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView, EmptyView, ErrorView, LoadingView} from "../StateView.jsx";

const normalizeString = (value) => String(value || "").trim();

const chapterNumber = (chapter) => {
  const parsed = Number.parseFloat(String(chapter?.chapterNumber || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortChapters = (chapters, sortMode = "newest") => [...(Array.isArray(chapters) ? chapters : [])].sort((left, right) => {
  const leftNumber = chapterNumber(left);
  const rightNumber = chapterNumber(right);
  if (sortMode === "number-asc") {
    return leftNumber - rightNumber;
  }
  if (sortMode === "number-desc") {
    return rightNumber - leftNumber;
  }
  const leftDate = Date.parse(String(left?.releaseDate || ""));
  const rightDate = Date.parse(String(right?.releaseDate || ""));
  if (sortMode === "oldest") {
    return leftDate - rightDate || leftNumber - rightNumber;
  }
  return rightDate - leftDate || rightNumber - leftNumber;
});

const filterChapters = (chapters, {filterMode, search}) => {
  const searchKey = normalizeString(search).toLowerCase();
  return chapters.filter((chapter) => {
    if (filterMode === "read" && chapter.read !== true) {
      return false;
    }
    if (filterMode === "unread" && chapter.read === true) {
      return false;
    }
    if (!searchKey) {
      return true;
    }
    return [
      chapter.id,
      chapter.label,
      chapter.chapterNumber,
      chapter.releaseDate
    ].some((value) => normalizeString(value).toLowerCase().includes(searchKey));
  });
};

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

/**
 * Render the title page.
 *
 * @param {{titleId: string, typeSlug?: string}} props
 * @returns {import("react").ReactNode}
 */
export const TitlePageClient = ({titleId, typeSlug = ""}) => {
  const router = useRouter();
  const {auth, loginUrl} = useMoonChrome();
  const {loading, error, status, data, refresh, setData} = useMoonJson(`/api/moon-v3/user/title/${encodeURIComponent(titleId)}`, {
    fallback: {title: null, following: false, requests: [], tagPreferences: {likedTags: [], dislikedTags: []}},
    deps: [titleId]
  });
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState("chapters");
  const [chapterFilter, setChapterFilter] = useState("all");
  const [chapterSearch, setChapterSearch] = useState("");
  const [chapterSort, setChapterSort] = useState("newest");
  const [selectedChapterIds, setSelectedChapterIds] = useState(() => new Set());
  const [lastSelectedChapterId, setLastSelectedChapterId] = useState("");
  const [notice, setNotice] = useState("");

  const title = data?.title || null;
  const chaptersNewest = useMemo(() => sortChapters(title?.chapters, "newest"), [title?.chapters]);
  const chapters = useMemo(() => sortChapters(title?.chapters, chapterSort), [chapterSort, title?.chapters]);
  const visibleChapters = useMemo(
    () => filterChapters(chapters, {filterMode: chapterFilter, search: chapterSearch}),
    [chapterFilter, chapterSearch, chapters]
  );
  const selectedIds = useMemo(() => Array.from(selectedChapterIds), [selectedChapterIds]);
  const latestChapter = chaptersNewest[0] || null;
  const bookmarkChapter = chapters.find((chapter) => chapter.id === title?.userState?.bookmark?.chapterId) || null;
  const nextUnreadChapter = chapters.find((chapter) => chapter.id === title?.userState?.nextUnreadChapterId) || null;
  const primaryChapter = bookmarkChapter || nextUnreadChapter || latestChapter;
  const readRatio = title?.userState?.totalAvailableChapters
    ? title.userState.readAvailableCount / Math.max(1, title.userState.totalAvailableChapters)
    : 0;
  const allVisibleSelected = visibleChapters.length > 0 && visibleChapters.every((chapter) => selectedChapterIds.has(chapter.id));

  useEffect(() => {
    if (title && title.libraryTypeSlug && typeSlug && typeSlug !== title.libraryTypeSlug) {
      router.replace(buildTitlePathForTitle(title));
    }
  }, [router, title, typeSlug]);

  if (loading) {
    return <LoadingView label="Moon is loading the title summary, queue context, and chapter table." />;
  }

  if (status === 401 && !auth) {
    return (
      <AuthRequiredView
        loginUrl={loginUrl}
        title="Sign in to open this title"
        detail="Connect your Discord account to browse title metadata, requests, and readable chapters."
      />
    );
  }

  if (error) {
    return <ErrorView detail={error} />;
  }

  if (!title) {
    return <EmptyView title="Title unavailable" detail="Moon could not find this series in the current library." />;
  }

  const syncTitleFromPayload = async (result) => {
    if (result.ok && result.payload?.title) {
      setData((current) => ({
        ...current,
        title: result.payload.title,
        following: current.following
      }));
      const validIds = new Set((result.payload.title.chapters || []).map((chapter) => chapter.id));
      setSelectedChapterIds((current) => new Set(Array.from(current).filter((chapterId) => validIds.has(chapterId))));
      return;
    }
    await refresh();
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
    runBusy(async () => {
      const nextResult = data.following
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
        setData((current) => ({...current, following: !current.following}));
      } else {
        await refresh();
      }
    });
  };

  const updateTagPreference = (tag, preference) => {
    runBusy(async () => {
      await requestJson("/api/moon-v3/user/tag-preferences", {
        method: "PUT",
        json: {tag, preference}
      });
      await refresh();
    });
  };

  const updateTitleReadState = (mode) => {
    runBusy(async () => {
      const result = await requestJson(`/api/moon-v3/user/title/${encodeURIComponent(title.id)}/${mode}`, {
        method: "POST"
      });
      await syncTitleFromPayload(result);
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
    runBusy(async () => {
      const result = await requestJson(
        `/api/moon-v3/user/title/${encodeURIComponent(title.id)}/chapters/${encodeURIComponent(targetChapterId)}/${mode}`,
        {method: "POST"}
      );
      await syncTitleFromPayload(result);
      setNotice(mode === "read" ? "Chapter marked read." : "Chapter marked unread.");
    });
  };

  const toggleChapterSelection = (targetChapterId, checked, event) => {
    const shiftKey = event?.shiftKey || event?.nativeEvent?.shiftKey;
    const visibleIds = visibleChapters.map((chapter) => chapter.id);
    setSelectedChapterIds((current) => {
      const next = new Set(current);
      const lastIndex = visibleIds.indexOf(lastSelectedChapterId);
      const targetIndex = visibleIds.indexOf(targetChapterId);
      if (shiftKey && lastIndex >= 0 && targetIndex >= 0) {
        const [start, end] = lastIndex < targetIndex ? [lastIndex, targetIndex] : [targetIndex, lastIndex];
        for (const chapterId of visibleIds.slice(start, end + 1)) {
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

  const toggleVisibleSelection = () => {
    setSelectedChapterIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const chapter of visibleChapters) {
          next.delete(chapter.id);
        }
      } else {
        for (const chapter of visibleChapters) {
          next.add(chapter.id);
        }
      }
      return next;
    });
  };

  const runBulkAction = (action) => {
    if (!selectedIds.length) {
      return;
    }
    if (action === "reset") {
      const confirmed = window.confirm(`Reset ${selectedIds.length} selected chapter${selectedIds.length === 1 ? "" : "s"}? This clears selected chapter read state and bookmarks, and clears title progress when it points into the selection.`);
      if (!confirmed) {
        return;
      }
    }
    runBusy(async () => {
      const result = await requestJson(`/api/moon-v3/user/title/${encodeURIComponent(title.id)}/chapters/bulk-read-state`, {
        method: "POST",
        json: {
          action,
          chapterIds: selectedIds
        }
      });
      await syncTitleFromPayload(result);
      if (result.ok) {
        setSelectedChapterIds(new Set());
        const resetDetails = action === "reset"
          ? ` Cleared ${result.payload?.clearedBookmarkCount || 0} bookmark${result.payload?.clearedBookmarkCount === 1 ? "" : "s"}${result.payload?.clearedProgress ? " and reader progress" : ""}.`
          : "";
        setNotice(`${selectedIds.length} chapter${selectedIds.length === 1 ? "" : "s"} updated.${resetDetails}`);
      }
    });
  };

  return (
    <div className="moon-title-page">
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
          <p className="moon-support-copy">{title.summary || "Moon has not matched a richer description for this title yet."}</p>
          <div className="moon-pill-row">
            <span className="moon-pill is-strong">{statePillCopy(title, data.following)}</span>
            <span className="moon-pill">{title.userState?.readAvailableCount || 0}/{title.userState?.totalAvailableChapters || chapters.length} read</span>
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
              {data.following ? "Unfollow" : "Follow"}
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
              <strong>{data.following ? "Yes" : "No"}</strong>
            </div>
          </div>
          {notice ? <p className="moon-title-notice">{notice}</p> : null}
        </div>
      </section>

      <section className="moon-title-tabs">
        {[
          {id: "chapters", label: "Chapters"},
          {id: "details", label: "Details"},
          {id: "requests", label: `Requests ${data.requests?.length ? `(${data.requests.length})` : ""}`}
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
            <button type="button" onClick={toggleVisibleSelection} disabled={!visibleChapters.length}>
              {allVisibleSelected ? "Clear visible" : "Select visible"}
            </button>
          </div>

          {selectedIds.length ? (
            <div className="moon-title-bulk-toolbar">
              <strong>{selectedIds.length} selected</strong>
              <Flex gap="8" wrap>
                <button type="button" onClick={() => runBulkAction("read")} disabled={busy}>Mark read</button>
                <button type="button" onClick={() => runBulkAction("unread")} disabled={busy}>Mark unread</button>
                <button className="is-danger" type="button" onClick={() => runBulkAction("reset")} disabled={busy}>Reset selected</button>
                <button type="button" onClick={() => setSelectedChapterIds(new Set())} disabled={busy}>Clear</button>
              </Flex>
            </div>
          ) : null}

          {visibleChapters.length ? (
            <div className="moon-title-table-wrap">
              <table className="moon-chapter-table">
                <thead>
                  <tr>
                    <th aria-label="Select" />
                    <th>Chapter</th>
                    <th>Date</th>
                    <th>Pages</th>
                    <th>State</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visibleChapters.map((chapter) => (
                    <tr key={chapter.id} className={chapter.read ? "is-read" : "is-unread"}>
                      <td>
                        <input
                          aria-label={`Select ${chapter.label || chapter.id}`}
                          checked={selectedChapterIds.has(chapter.id)}
                          type="checkbox"
                          onChange={(event) => toggleChapterSelection(chapter.id, event.target.checked, event)}
                        />
                      </td>
                      <td>
                        <a className="moon-chapter-title-link" href={buildReaderPathForTitle(title, chapter.id)}>
                          <strong>{chapter.label || `Chapter ${chapter.chapterNumber || "?"}`}</strong>
                          <span>{chapter.id}</span>
                        </a>
                      </td>
                      <td>{formatDate(chapter.releaseDate)}</td>
                      <td>{chapter.pageCount || 0}</td>
                      <td>
                        <span className={`moon-title-state-chip ${chapter.read ? "is-read" : "is-unread"}`}>
                          {chapter.read ? "Read" : "Unread"}
                        </span>
                      </td>
                      <td>
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyView title="No chapters match" detail="Adjust the chapter filters or search." />
          )}
        </section>
      ) : null}

      {activeTab === "details" ? (
        <section className="moon-title-detail-grid">
          <div className="moon-title-detail-panel">
            <span className="moon-kicker">Metadata</span>
            <dl>
              <div><dt>Status</dt><dd>{title.status || "Unknown"}</dd></div>
              <div><dt>Provider</dt><dd>{title.metadataProvider || "Unmatched"}</dd></div>
              <div><dt>Latest chapter</dt><dd>{title.latestChapter || "Unknown"}</dd></div>
              <div><dt>Coverage</dt><dd>{title.chaptersDownloaded || chapters.length}/{title.chapterCount || chapters.length}</dd></div>
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

      {activeTab === "requests" ? (
        <section className="moon-title-detail-panel">
          <span className="moon-kicker">Request history</span>
          {data.requests?.length ? (
            <div className="moon-title-request-list">
              {data.requests.map((request) => (
                <div key={request.id || `${request.title}:${request.status}`} className="moon-title-request-row">
                  <strong>{request.title || title.title}</strong>
                  <span>{request.status || "unknown"}</span>
                  <p>{request.notes || request.message || request.details?.query || "No request notes."}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="moon-muted">No Moon requests are tied to this title for your account.</p>
          )}
        </section>
      ) : null}
    </div>
  );
};

export default TitlePageClient;
