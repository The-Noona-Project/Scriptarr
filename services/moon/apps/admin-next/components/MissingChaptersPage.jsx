"use client";

/**
 * @file Dedicated missing-content repair page for Moon admin wanted workflows.
 */

import {useEffect, useMemo, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {
  chapterCoveragePercent,
  filterMissingChapterRows,
  missingChapterCount,
  normalizeArray,
  normalizeString,
  resolveExistingTitleSelection,
  titleRowKey
} from "../lib/adminWanted.js";
import {formatDate, formatDisplayValue, formatPercent} from "../lib/format.js";
import {AdminActionBanner, AdminDenseTable, AdminDrawer, AdminFilterBar, AdminStatusBadge} from "./AdminUi.jsx";
import {useAdminToast} from "./AdminToasts.jsx";

const emptyPayload = Object.freeze({
  entries: [],
  counts: {}
});

const candidateKey = (entry = {}) => `${normalizeString(entry.providerId, normalizeString(entry.provider))}:${normalizeString(entry.titleUrl)}`;

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
 * Render a compact coverage bar.
 *
 * @param {{title: Record<string, unknown>}} props
 * @returns {import("react").ReactNode}
 */
const CoverageBar = ({title}) => {
  const percent = chapterCoveragePercent(title);
  return (
    <div className="queue-progress" aria-label={`Chapter coverage ${formatPercent(percent)}`}>
      <span style={{width: `${percent}%`}} />
    </div>
  );
};

/**
 * Render one replacement source candidate.
 *
 * @param {{entry: any, selected?: boolean, onPick: (entry: any) => void}} props
 * @returns {import("react").ReactNode}
 */
const RepairCandidateCard = ({entry, selected = false, onPick}) => (
  <article className={`admin-source-card${selected ? " is-selected" : ""}`}>
    <div>
      <strong>{normalizeString(entry.titleName, "Untitled source")}</strong>
      <p className="admin-muted">{normalizeString(entry.providerName, normalizeString(entry.providerId, "source"))}</p>
      <div className="admin-log-meta">
        <span>{formatDisplayValue(entry.coverageLabel, `${entry.chapterCount || 0} chapters`)}</span>
        {entry.current ? <span>Current source</span> : null}
        {Number(entry.matchScore || 0) ? <span>{entry.matchScore} score</span> : null}
      </div>
      {normalizeArray(entry.warnings).length ? (
        <div className="admin-log-meta">
          {normalizeArray(entry.warnings).map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      ) : null}
      {normalizeString(entry.titleUrl) ? <a href={entry.titleUrl} target="_blank" rel="noreferrer">Open source</a> : null}
    </div>
    <button className={selected ? "admin-button solid small" : "admin-button ghost small"} type="button" onClick={() => onPick(entry)}>
      {selected ? "Selected" : "Select"}
    </button>
  </article>
);

/**
 * Render the dedicated missing content workflow.
 *
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const MissingChaptersPage = ({user}) => {
  const canInspectRepairs = hasAdminGrant(user, "library", "read");
  const canQueueReplacement = hasAdminGrant(user, "library", "root");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [repairPayload, setRepairPayload] = useState(null);
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [busy, setBusy] = useState("");
  const [flash, setFlash] = useState(null);
  const {notify} = useAdminToast();
  const {loading, refreshing, error, data, refresh} = useAdminJson("/api/moon/v3/admin/wanted/missing-content", {
    fallback: emptyPayload
  });
  useAdminEventStaleness({
    domains: ["wanted", "library", "activity"],
    enabled: true,
    locked: Boolean(busy),
    onStale: () => {},
    onRefresh: refresh
  });

  const titles = normalizeArray(data?.entries);
  const counts = data?.counts || {};
  const visibleTitles = useMemo(() => filterMissingChapterRows(titles, {query}), [titles, query]);
  const selectedTitle = titles.find((title) => titleRowKey(title) === selectedId) || null;
  const repairOptions = normalizeArray(repairPayload?.options);

  useEffect(() => {
    setSelectedId((current) => resolveExistingTitleSelection(titles, current));
  }, [titles]);

  useEffect(() => {
    setSelectedCandidate(null);
    setRepairPayload(null);
    if (!selectedTitle || !canInspectRepairs) {
      return undefined;
    }
    let cancelled = false;
    setBusy("repair-options");
    void requestJson(`/api/moon/v3/admin/library/${encodeURIComponent(titleRowKey(selectedTitle))}/repair-options`)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setBusy("");
        if (result.ok) {
          setRepairPayload(result.payload || {});
          return;
        }
        setFlash({tone: "bad", message: result.payload?.error || "Repair options failed to load."});
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedTitle, canInspectRepairs]);

  const setResult = (ok, message, category = "action") => {
    setFlash({tone: ok ? "good" : "bad", message});
    notify({message, tone: ok ? "good" : "bad", category});
  };

  const queueReplacement = async () => {
    if (!selectedTitle || !selectedCandidate) {
      setResult(false, "Pick a repair candidate first.");
      return;
    }
    setBusy("replace-source");
    const result = await requestJson(`/api/moon/v3/admin/library/${encodeURIComponent(titleRowKey(selectedTitle))}/replace-source`, {
      method: "POST",
      json: selectedCandidate
    });
    setBusy("");
    if (!result.ok) {
      setResult(false, result.payload?.error || "Replacement queue failed.");
      return;
    }
    setResult(true, "Replacement download queued.", "job");
    await refresh();
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">Wanted</div>
        <h2>Loading Missing Content</h2>
        <p>Moon is loading title quality and coverage through Sage.</p>
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
            <h2>Missing Content</h2>
            <p className="admin-muted">Find incomplete or damaged titles and queue safe staged replacement downloads from better sources.</p>
          </div>
          <AdminStatusBadge tone={refreshing ? "warning" : "good"}>{refreshing ? "Refreshing" : "Live"}</AdminStatusBadge>
        </div>
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Affected titles</span><strong>{counts.affectedTitles || 0}</strong></article>
          <article className="admin-metric-card"><span>Missing chapters</span><strong>{counts.totalMissing || 0}</strong></article>
          <article className="admin-metric-card"><span>Bad chapters</span><strong>{counts.badChapters || 0}</strong></article>
          <article className="admin-metric-card"><span>Missing pages</span><strong>{counts.totalMissingPages || 0}</strong></article>
        </div>
        <AdminFilterBar>
          <label className="admin-filter-grow">
            <span>Search</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, provider, source, type..." />
          </label>
        </AdminFilterBar>
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Coverage</div>
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
            {key: "coverage", label: "Coverage", render: (row) => (
              <div>
                <CoverageBar title={row} />
                <span className="admin-muted">{row.chaptersDownloaded || 0} / {row.chapterCount || 0}</span>
              </div>
            )},
            {key: "missing", label: "Missing", render: (row) => missingChapterCount(row)},
            {key: "quality", label: "Quality", render: (row) => formatDisplayValue(row.qualitySummary || row.qualityStatus, "clean")},
            {key: "latest", label: "Latest", render: (row) => formatDisplayValue(row.latestChapter, "unknown")},
            {key: "source", label: "Source", render: (row) => formatDisplayValue(row.sourceUrl, "none")}
          ]}
          empty="No missing content rows match this view."
        />
      </section>

      <AdminDrawer
        open={Boolean(selectedTitle)}
        title={normalizeString(selectedTitle?.title, "Missing content")}
        kicker="Coverage"
        onClose={() => setSelectedId("")}
      >
        {selectedTitle ? (
          <div className="admin-drawer-stack">
            <div className="admin-request-hero">
              <TitleCover title={selectedTitle} />
              <div>
                <AdminStatusBadge tone="warning">{missingChapterCount(selectedTitle)} missing</AdminStatusBadge>
                <p>{formatDisplayValue(selectedTitle.summary, "No summary stored.")}</p>
                <CoverageBar title={selectedTitle} />
              </div>
            </div>
            <div className="admin-detail-grid">
              <span><strong>Downloaded</strong>{selectedTitle.chaptersDownloaded || 0}</span>
              <span><strong>Total</strong>{selectedTitle.chapterCount || 0}</span>
              <span><strong>Clean</strong>{selectedTitle.cleanChapterCount || 0}</span>
              <span><strong>Damaged</strong>{(selectedTitle.partialChapterCount || 0) + (selectedTitle.badChapterCount || 0)}</span>
              <span><strong>Missing pages</strong>{selectedTitle.missingPageCount || 0}</span>
              <span><strong>Quality</strong>{formatDisplayValue(selectedTitle.qualityStatus, "clean")}</span>
              <span><strong>Latest</strong>{formatDisplayValue(selectedTitle.latestChapter, "unknown")}</span>
              <span><strong>Type</strong>{formatDisplayValue(selectedTitle.libraryTypeLabel, selectedTitle.mediaType || "manga")}</span>
              <span><strong>Provider</strong>{formatDisplayValue(selectedTitle.metadataProvider, "missing")}</span>
              <span><strong>Matched</strong>{formatDate(selectedTitle.metadataMatchedAt)}</span>
              <span><strong>Source</strong>{formatDisplayValue(selectedTitle.sourceUrl, "none")}</span>
              <span><strong>Status</strong>{formatDisplayValue(selectedTitle.status, "unknown")}</span>
            </div>

            {normalizeArray(selectedTitle.damagedChapters).length ? (
              <section className="admin-subsection">
                <div className="admin-section-heading">
                  <div>
                    <div className="admin-kicker">Quality</div>
                    <h3>Damaged chapters</h3>
                  </div>
                </div>
                <div className="admin-log-list compact">
                  {normalizeArray(selectedTitle.damagedChapters).slice(0, 12).map((chapter) => (
                    <article className="admin-log-row" key={`${chapter.id || chapter.chapterNumber}`}>
                      <strong>{formatDisplayValue(chapter.label, `Chapter ${chapter.chapterNumber || "?"}`)}</strong>
                      <span>{formatDisplayValue(chapter.qualityStatus, "possible missing page")}</span>
                      <span>{chapter.missingPageCount || 0} missing page{Number(chapter.missingPageCount || 0) === 1 ? "" : "s"}</span>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="admin-subsection">
              <div className="admin-section-heading">
                <div>
                  <div className="admin-kicker">Repair</div>
                  <h3>Replacement candidates</h3>
                </div>
                <AdminStatusBadge tone={busy === "repair-options" ? "warning" : repairOptions.length ? "good" : ""}>
                  {busy === "repair-options" ? "Loading" : `${repairOptions.length} option${repairOptions.length === 1 ? "" : "s"}`}
                </AdminStatusBadge>
              </div>
              {!canInspectRepairs ? (
                <div className="admin-empty">Library read access is required to inspect repair candidates.</div>
              ) : repairOptions.length ? (
                <div className="admin-source-list">
                  {repairOptions.map((entry) => (
                    <RepairCandidateCard
                      entry={entry}
                      key={candidateKey(entry)}
                      selected={candidateKey(selectedCandidate || {}) === candidateKey(entry)}
                      onPick={setSelectedCandidate}
                    />
                  ))}
                </div>
              ) : (
                <div className="admin-empty">{busy === "repair-options" ? "Loading repair candidates..." : "No replacement candidates found yet."}</div>
              )}
              <button className="admin-button solid" type="button" disabled={!canQueueReplacement || !selectedCandidate || busy === "replace-source"} onClick={() => void queueReplacement()}>
                Queue staged replacement
              </button>
            </section>
          </div>
        ) : null}
      </AdminDrawer>
    </>
  );
};

export default MissingChaptersPage;
