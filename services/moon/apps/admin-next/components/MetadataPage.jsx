"use client";

/**
 * @file Dedicated metadata repair page for Moon admin wanted workflows.
 */

import {useEffect, useMemo, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {
  filterMetadataRows,
  metadataGapLabels,
  metadataGapText,
  normalizeArray,
  normalizeString,
  resolveExistingTitleSelection,
  titleRowKey
} from "../lib/adminWanted.js";
import {formatDate, formatDisplayValue} from "../lib/format.js";
import {AdminActionBanner, AdminDenseTable, AdminDrawer, AdminFilterBar, AdminStatusBadge} from "./AdminUi.jsx";
import {useAdminToast} from "./AdminToasts.jsx";

const emptyPayload = Object.freeze({
  entries: [],
  counts: {}
});

const gapOptions = Object.freeze([
  {id: "all", label: "All gaps"},
  ...Object.entries(metadataGapLabels).map(([id, label]) => ({id, label}))
]);

/**
 * Render cover art or a stable title mark.
 *
 * @param {{title: Record<string, unknown>}} props
 * @returns {import("react").ReactNode}
 */
const TitleCover = ({title}) => {
  const coverUrl = normalizeString(title.coverUrl);
  const name = normalizeString(title.title, "Title");
  return (
    <div className="admin-result-cover compact">
      {coverUrl ? <img src={coverUrl} alt="" /> : <span>{name.slice(0, 1).toUpperCase()}</span>}
    </div>
  );
};

/**
 * Render a selectable metadata provider result.
 *
 * @param {{entry: any, selected?: boolean, onPick: (entry: any) => void}} props
 * @returns {import("react").ReactNode}
 */
const MetadataResultCard = ({entry, selected = false, onPick}) => (
  <article className={`admin-source-card${selected ? " is-selected" : ""}`}>
    <div>
      <strong>{normalizeString(entry.title, "Untitled")}</strong>
      <p className="admin-muted">{normalizeString(entry.providerName, normalizeString(entry.provider, "metadata"))}</p>
      {normalizeString(entry.summary) ? <p>{entry.summary}</p> : null}
      <div className="admin-log-meta">
        {normalizeString(entry.status) ? <span>{entry.status}</span> : null}
        {normalizeString(entry.type) ? <span>{entry.type}</span> : null}
        {normalizeArray(entry.tags).slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}
      </div>
      {normalizeString(entry.url) ? <a href={entry.url} target="_blank" rel="noreferrer">Open metadata</a> : null}
    </div>
    <button className={selected ? "admin-button solid small" : "admin-button ghost small"} type="button" onClick={() => onPick(entry)}>
      {selected ? "Selected" : "Select"}
    </button>
  </article>
);

/**
 * Render the dedicated wanted metadata workflow.
 *
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const MetadataPage = ({user}) => {
  const canWrite = hasAdminGrant(user, "wanted", "write");
  const [query, setQuery] = useState("");
  const [gap, setGap] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [metadataResults, setMetadataResults] = useState([]);
  const [selectedMetadata, setSelectedMetadata] = useState(null);
  const [busy, setBusy] = useState("");
  const [flash, setFlash] = useState(null);
  const {notify} = useAdminToast();
  const {loading, refreshing, error, data, refresh} = useAdminJson("/api/moon/v3/admin/wanted/metadata", {
    fallback: emptyPayload
  });
  useAdminEventStaleness({
    domains: ["wanted", "library"],
    enabled: true,
    locked: Boolean(busy),
    onStale: () => {},
    onRefresh: refresh
  });

  const titles = normalizeArray(data?.entries);
  const counts = data?.counts || {};
  const visibleTitles = useMemo(() => filterMetadataRows(titles, {query, gap}), [titles, query, gap]);
  const selectedTitle = titles.find((title) => titleRowKey(title) === selectedId) || null;

  useEffect(() => {
    setSelectedId((current) => resolveExistingTitleSelection(titles, current));
  }, [titles]);

  useEffect(() => {
    if (!selectedTitle) {
      setSearchQuery("");
      setMetadataResults([]);
      setSelectedMetadata(null);
      return;
    }
    setSearchQuery(normalizeString(selectedTitle.title));
    setMetadataResults([]);
    setSelectedMetadata(null);
  }, [selectedId, selectedTitle]);

  const setResult = (ok, message) => {
    setFlash({tone: ok ? "good" : "bad", message});
    notify({message, tone: ok ? "good" : "bad", category: "action"});
  };

  const searchMetadata = async () => {
    if (!selectedTitle) {
      return;
    }
    const normalizedQuery = normalizeString(searchQuery, selectedTitle.title);
    if (!normalizedQuery) {
      setResult(false, "Enter a title before searching metadata.");
      return;
    }
    setBusy("search");
    const result = await requestJson(`/api/moon/v3/admin/wanted/metadata/${encodeURIComponent(titleRowKey(selectedTitle))}/search?query=${encodeURIComponent(normalizedQuery)}`);
    setBusy("");
    if (!result.ok) {
      setMetadataResults([]);
      setResult(false, result.payload?.error || "Metadata search failed.");
      return;
    }
    const results = normalizeArray(result.payload?.results);
    setMetadataResults(results);
    setResult(true, `Found ${results.length} metadata result${results.length === 1 ? "" : "s"}.`);
  };

  const applyMetadata = async () => {
    if (!selectedTitle || !selectedMetadata) {
      setResult(false, "Pick a metadata result before applying.");
      return;
    }
    setBusy("apply");
    const result = await requestJson(`/api/moon/v3/admin/wanted/metadata/${encodeURIComponent(titleRowKey(selectedTitle))}/identify`, {
      method: "POST",
      json: {selectedMetadata}
    });
    setBusy("");
    if (!result.ok) {
      setResult(false, result.payload?.error || "Metadata apply failed.");
      return;
    }
    setResult(true, "Metadata match applied.");
    await refresh();
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">Wanted</div>
        <h2>Loading Metadata</h2>
        <p>Moon is loading title metadata gaps through Sage.</p>
      </section>
    );
  }

  return (
    <>
      {error ? <AdminActionBanner tone="bad">{error}</AdminActionBanner> : null}
      {flash ? <AdminActionBanner tone={flash.tone}>{flash.message}</AdminActionBanner> : null}
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Wanted</div>
            <h2>Metadata</h2>
            <p className="admin-muted">Repair provider matches, summaries, aliases, tags, and covers for tracked titles.</p>
          </div>
          <AdminStatusBadge tone={refreshing ? "warning" : "good"}>{refreshing ? "Refreshing" : "Live"}</AdminStatusBadge>
        </div>
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Titles with gaps</span><strong>{counts.total || 0}</strong></article>
          <article className="admin-metric-card"><span>Provider</span><strong>{counts.missingProvider || 0}</strong></article>
          <article className="admin-metric-card"><span>Summary</span><strong>{counts.missingSummary || 0}</strong></article>
          <article className="admin-metric-card"><span>Tags</span><strong>{counts.missingTags || 0}</strong></article>
        </div>
        <AdminFilterBar>
          <label className="admin-filter-grow">
            <span>Search</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, provider, alias, tag..." />
          </label>
          <label>
            <span>Gap</span>
            <select value={gap} onChange={(event) => setGap(event.target.value)}>
              {gapOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
        </AdminFilterBar>
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Titles</div>
            <h2>{visibleTitles.length} visible</h2>
          </div>
        </div>
        <AdminDenseTable
          rows={visibleTitles}
          getKey={(row) => titleRowKey(row)}
          selectedKey={selectedId}
          onRowClick={(row) => setSelectedId(titleRowKey(row))}
          columns={[
            {key: "title", label: "Title", render: (row) => (
              <div className="admin-inline-record">
                <TitleCover title={row} />
                <div>
                  <strong>{row.title}</strong>
                  <span>{formatDisplayValue(row.libraryTypeLabel, row.mediaType || "manga")}</span>
                </div>
              </div>
            )},
            {key: "gaps", label: "Gaps", render: (row) => metadataGapText(row.gaps) || "none"},
            {key: "provider", label: "Provider", render: (row) => formatDisplayValue(row.metadataProvider, "missing")},
            {key: "matched", label: "Matched", render: (row) => formatDate(row.metadataMatchedAt)},
            {key: "updated", label: "Updated", render: (row) => formatDate(row.updatedAt)}
          ]}
          empty="No metadata gaps match this view."
        />
      </section>

      <AdminDrawer
        open={Boolean(selectedTitle)}
        title={normalizeString(selectedTitle?.title, "Metadata detail")}
        kicker="Metadata"
        onClose={() => setSelectedId("")}
      >
        {selectedTitle ? (
          <div className="admin-drawer-stack">
            <div className="admin-request-hero">
              <TitleCover title={selectedTitle} />
              <div>
                <AdminStatusBadge tone={selectedTitle.gaps?.length ? "warning" : "good"}>
                  {selectedTitle.gaps?.length ? `${selectedTitle.gaps.length} gap${selectedTitle.gaps.length === 1 ? "" : "s"}` : "Complete"}
                </AdminStatusBadge>
                <p>{formatDisplayValue(selectedTitle.summary, "No summary stored.")}</p>
                <div className="admin-log-meta">
                  {normalizeArray(selectedTitle.gaps).map((entry) => <span key={entry}>{metadataGapLabels[entry] || entry}</span>)}
                </div>
              </div>
            </div>
            <div className="admin-detail-grid">
              <span><strong>Provider</strong>{formatDisplayValue(selectedTitle.metadataProvider, "missing")}</span>
              <span><strong>Matched</strong>{formatDate(selectedTitle.metadataMatchedAt)}</span>
              <span><strong>Type</strong>{formatDisplayValue(selectedTitle.libraryTypeLabel, selectedTitle.mediaType || "manga")}</span>
              <span><strong>Status</strong>{formatDisplayValue(selectedTitle.status, "unknown")}</span>
              <span><strong>Aliases</strong>{formatDisplayValue(selectedTitle.aliases, "none")}</span>
              <span><strong>Tags</strong>{formatDisplayValue(selectedTitle.tags, "none")}</span>
              <span><strong>Source</strong>{formatDisplayValue(selectedTitle.sourceUrl, "none")}</span>
              <span><strong>Cover</strong>{selectedTitle.coverUrl ? "configured" : "missing"}</span>
            </div>

            <section className="admin-subsection">
              <div className="admin-section-heading">
                <div>
                  <div className="admin-kicker">Search</div>
                  <h3>Provider match</h3>
                </div>
              </div>
              <div className="admin-task-form">
                <label>
                  <span>Search title</span>
                  <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
                </label>
                <button className="admin-button solid" type="button" disabled={busy === "search"} onClick={() => void searchMetadata()}>Search metadata</button>
              </div>
              {metadataResults.length ? (
                <div className="admin-source-list">
                  {metadataResults.map((entry) => (
                    <MetadataResultCard
                      entry={entry}
                      key={`${entry.provider}:${entry.providerSeriesId}`}
                      selected={selectedMetadata?.provider === entry.provider && selectedMetadata?.providerSeriesId === entry.providerSeriesId}
                      onPick={setSelectedMetadata}
                    />
                  ))}
                </div>
              ) : <div className="admin-empty">Search metadata providers to pick a durable match.</div>}
              <button className="admin-button solid" type="button" disabled={!canWrite || !selectedMetadata || busy === "apply"} onClick={() => void applyMetadata()}>
                Apply metadata match
              </button>
            </section>
          </div>
        ) : null}
      </AdminDrawer>
    </>
  );
};

export default MetadataPage;
