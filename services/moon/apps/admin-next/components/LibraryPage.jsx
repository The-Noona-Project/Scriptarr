"use client";

/**
 * @file Dedicated compact Library admin page.
 */

import {useDeferredValue, useMemo, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {formatDate, normalizeString} from "../lib/format.js";
import {buildAdminLibraryTitlePath} from "../lib/routes.js";
import {useAdminToast} from "./AdminToasts.jsx";
import {AdminActionBanner, AdminDenseTable, AdminFilterBar, AdminStatusBadge} from "./AdminUi.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = {}) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;

const PAGE_SIZES = [25, 50, 100];
const INGEST_STATUSES = ["", "ready", "pending", "running", "failed", "missing"];

const statusTone = (status) => {
  const normalized = normalizeString(status).toLowerCase();
  if (normalized === "ready") {
    return "good";
  }
  if (normalized === "failed" || normalized === "missing") {
    return "bad";
  }
  return "warning";
};

const typeLabel = (slug) => normalizeString(slug)
  .replace(/-/g, " ")
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const titleCover = (title = {}) => {
  const name = normalizeString(title.title, "Untitled");
  const coverUrl = normalizeString(title.coverThumbUrl, normalizeString(title.coverUrl));
  return (
    <div className="admin-result-cover compact">
      {coverUrl ? <img src={coverUrl} alt="" /> : <span>{name.slice(0, 1).toUpperCase()}</span>}
    </div>
  );
};

/**
 * Render the Library admin tool surface.
 *
 * @param {{user: Record<string, any>}} props
 * @returns {import("react").ReactNode}
 */
export const LibraryPage = ({user}) => {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [ingestStatus, setIngestStatus] = useState("");
  const [sort, setSort] = useState("title");
  const [pageSize, setPageSize] = useState(50);
  const [cursor, setCursor] = useState("");
  const [busyTitleId, setBusyTitleId] = useState("");
  const deferredQuery = useDeferredValue(query);
  const {notify} = useAdminToast();
  const canIngest = hasAdminGrant(user, "import", "write");

  const endpoint = useMemo(() => {
    const params = new URLSearchParams();
    if (deferredQuery.trim()) {
      params.set("q", deferredQuery.trim());
    }
    if (type) {
      params.set("type", type);
    }
    if (cursor) {
      params.set("cursor", cursor);
    }
    params.set("pageSize", String(pageSize));
    params.set("sort", sort);
    return `/api/moon/v3/admin/library?${params.toString()}`;
  }, [cursor, deferredQuery, pageSize, sort, type]);

  const {loading, refreshing, error, data, refresh} = useAdminJson(endpoint, {
    fallback: {
      titles: [],
      counts: {},
      pageInfo: {},
      summary: {}
    }
  });

  const live = useAdminEventStaleness({
    domains: ["library", "import", "activity"],
    enabled: true,
    locked: Boolean(busyTitleId),
    onStale: () => {},
    onRefresh: refresh
  });

  const counts = normalizeObject(data?.counts);
  const byType = normalizeObject(counts.byType);
  const pageInfo = normalizeObject(data?.pageInfo);
  const summary = normalizeObject(data?.summary);
  const titles = normalizeArray(data?.titles);
  const visibleTitles = ingestStatus
    ? titles.filter((title) => normalizeString(title.ingestStatus, "pending") === ingestStatus)
    : titles;
  const typeOptions = useMemo(() => Object.keys(byType).sort(), [byType]);

  const resetFirstPage = () => setCursor("");
  const retryIngest = async (titleId) => {
    setBusyTitleId(titleId);
    const result = await requestJson(`/api/moon/v3/admin/ingest/${encodeURIComponent(titleId)}/retry`, {method: "POST"});
    notify({
      message: result.ok ? "Ingest retry queued." : result.payload?.error || "Moon could not retry ingest.",
      tone: result.ok ? "good" : "bad",
      category: "job"
    });
    setBusyTitleId("");
    await refresh();
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">Manage</div>
        <h2>Loading library</h2>
        <p>Moon is reading compact catalog rows through Sage.</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="admin-panel admin-state-panel is-danger">
        <div className="admin-kicker">Manage</div>
        <h2>Library unavailable</h2>
        <p>{error}</p>
      </section>
    );
  }

  return (
    <div className="queue-page">
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Manage</div>
            <h2>Library</h2>
          </div>
          <AdminStatusBadge tone={live.state === "live" ? "good" : "warning"}>
            {refreshing ? "Refreshing quietly" : live.state === "live" ? "Live" : "Degraded"}
          </AdminStatusBadge>
        </div>
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Titles</span><strong>{summary.totalTitles ?? counts.total ?? titles.length}</strong></article>
          <article className="admin-metric-card"><span>Visible</span><strong>{visibleTitles.length}</strong></article>
          <article className="admin-metric-card"><span>Ingest ready</span><strong>{summary.readyTitles ?? 0}</strong></article>
          <article className="admin-metric-card"><span>Failed ingest</span><strong>{summary.failedTitles ?? 0}</strong></article>
        </div>
      </section>

      {data?.degraded?.ingest ? <AdminActionBanner tone="warning">Ingest summary unavailable: {data.degraded.ingest}</AdminActionBanner> : null}

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Tools</div>
            <h2>Catalog tools</h2>
          </div>
          <div className="admin-action-row">
            <a className="admin-button solid" href="/admin/ingest">Open ingest</a>
            <a className="admin-button ghost" href="/admin/import">Open import</a>
            <a className="admin-button ghost" href="/admin/add">Add title</a>
            <button className="admin-button ghost" type="button" onClick={() => void refresh()}>Refresh</button>
          </div>
        </div>
        <AdminFilterBar>
          <label className="admin-filter-grow">
            <span>Search</span>
            <input value={query} onChange={(event) => { setQuery(event.target.value); resetFirstPage(); }} placeholder="Title, alias, author, tag" />
          </label>
          <label>
            <span>Type</span>
            <select value={type} onChange={(event) => { setType(event.target.value); resetFirstPage(); }}>
              <option value="">All</option>
              {typeOptions.map((entry) => <option value={entry} key={entry}>{typeLabel(entry)} ({byType[entry]})</option>)}
            </select>
          </label>
          <label>
            <span>Ingest</span>
            <select value={ingestStatus} onChange={(event) => setIngestStatus(event.target.value)}>
              {INGEST_STATUSES.map((entry) => <option value={entry} key={entry || "all"}>{entry ? typeLabel(entry) : "All"}</option>)}
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select value={sort} onChange={(event) => { setSort(event.target.value); resetFirstPage(); }}>
              <option value="title">Title</option>
              <option value="recent">Recent</option>
            </select>
          </label>
          <label>
            <span>Page size</span>
            <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); resetFirstPage(); }}>
              {PAGE_SIZES.map((entry) => <option value={entry} key={entry}>{entry}</option>)}
            </select>
          </label>
        </AdminFilterBar>
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Records</div>
            <h2>{visibleTitles.length} title{visibleTitles.length === 1 ? "" : "s"}</h2>
          </div>
          <div className="admin-action-row">
            {cursor ? <button className="admin-button ghost small" type="button" onClick={() => setCursor("")}>First page</button> : null}
            <button className="admin-button ghost small" type="button" disabled={!pageInfo.hasMore} onClick={() => setCursor(normalizeString(pageInfo.nextCursor))}>Next page</button>
          </div>
        </div>
        <AdminDenseTable
          rows={visibleTitles}
          empty="No library titles match those filters."
          getKey={(row) => normalizeString(row.id)}
          columns={[
            {key: "title", label: "Title", render: (row) => (
              <div className="admin-library-title-cell">
                {titleCover(row)}
                <div>
                  <strong>{normalizeString(row.title, "Untitled")}</strong>
                  <span>{normalizeString(row.author, "Unknown author")}</span>
                </div>
              </div>
            )},
            {key: "type", label: "Type", render: (row) => normalizeString(row.libraryTypeLabel, typeLabel(row.libraryTypeSlug))},
            {key: "chapters", label: "Chapters", render: (row) => `${row.ingestedChapterCount ?? 0}/${row.chapterCount ?? 0}`},
            {key: "ingest", label: "Ingest", render: (row) => (
              <AdminStatusBadge tone={statusTone(row.ingestStatus)}>{normalizeString(row.ingestStatus, "pending")}</AdminStatusBadge>
            )},
            {key: "updated", label: "Updated", render: (row) => formatDate(row.updatedAt)},
            {key: "actions", label: "", className: "is-tight", render: (row) => {
              const titleId = normalizeString(row.id);
              const href = buildAdminLibraryTitlePath(row.libraryTypeSlug || row.mediaType || "manga", titleId);
              const retryable = canIngest && titleId && normalizeString(row.ingestStatus, "pending") !== "ready";
              return (
                <div className="admin-table-actions">
                  <a className="admin-button ghost small" href={href}>Open</a>
                  {retryable ? (
                    <button className="admin-button ghost small" type="button" disabled={busyTitleId === titleId} onClick={() => retryIngest(titleId)}>
                      {busyTitleId === titleId ? "Retrying" : "Retry ingest"}
                    </button>
                  ) : null}
                </div>
              );
            }}
          ]}
        />
      </section>
    </div>
  );
};

export default LibraryPage;
