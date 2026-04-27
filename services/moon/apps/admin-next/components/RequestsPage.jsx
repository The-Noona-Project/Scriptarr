"use client";

/**
 * @file Purpose-built request moderation inbox for Moon admin.
 */

import {useEffect, useMemo, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {
  bulkDenyCandidates,
  bulkRefreshCandidates,
  buildRequestCounts,
  filterRequests,
  normalizeArray,
  normalizeString,
  requestActionState,
  requestCoverUrl,
  requestRowKey,
  resolveExistingRequestSelection,
  requestTabs
} from "../lib/adminRequests.js";
import {formatDate, formatDisplayValue} from "../lib/format.js";
import {AdminActionBanner, AdminDenseTable, AdminDrawer, AdminFilterBar, AdminStatusBadge} from "./AdminUi.jsx";
import {useAdminToast} from "./AdminToasts.jsx";

const emptyPayload = Object.freeze({
  requests: [],
  counts: {}
});

const sourceKey = (entry) => `${normalizeString(entry.providerId, normalizeString(entry.provider))}:${normalizeString(entry.titleUrl, normalizeString(entry.providerSeriesId))}`;

const statusTone = (status) => {
  const normalized = normalizeString(status).toLowerCase();
  if (["completed", "queued", "downloading"].includes(normalized)) {
    return "good";
  }
  if (["pending", "unavailable", "failed"].includes(normalized)) {
    return "warning";
  }
  if (["denied", "blocked", "expired", "cancelled"].includes(normalized)) {
    return "bad";
  }
  return "";
};

/**
 * Render request cover art or a stable fallback mark.
 *
 * @param {{request: any}} props
 * @returns {import("react").ReactNode}
 */
const RequestCover = ({request}) => {
  const coverUrl = requestCoverUrl(request);
  const title = normalizeString(request.title, "Request");
  return (
    <div className="admin-result-cover compact">
      {coverUrl ? <img src={coverUrl} alt="" /> : <span>{title.slice(0, 1).toUpperCase()}</span>}
    </div>
  );
};

/**
 * Render one metadata or download source card.
 *
 * @param {{entry: any, selected?: boolean, kind?: string, onPick: (entry: any) => void}} props
 * @returns {import("react").ReactNode}
 */
const SourceCard = ({entry, selected = false, kind = "source", onPick}) => (
  <article className={`admin-source-card${selected ? " is-selected" : ""}`}>
    <div>
      <strong>{normalizeString(entry.titleName, normalizeString(entry.title, "Untitled"))}</strong>
      <p className="admin-muted">{normalizeString(entry.providerName, normalizeString(entry.providerId, normalizeString(entry.provider, kind)))}</p>
      {normalizeString(entry.titleUrl, normalizeString(entry.url)) ? (
        <a href={normalizeString(entry.titleUrl, normalizeString(entry.url))} target="_blank" rel="noreferrer">Open source</a>
      ) : null}
    </div>
    <button className={selected ? "admin-button solid small" : "admin-button ghost small"} type="button" onClick={() => onPick(entry)}>
      {selected ? "Selected" : "Select"}
    </button>
  </article>
);

/**
 * Render a compact request detail pair grid.
 *
 * @param {{request: any}} props
 * @returns {import("react").ReactNode}
 */
const RequestDetailGrid = ({request}) => (
  <div className="admin-detail-grid">
    <span><strong>Status</strong>{request.status}</span>
    <span><strong>Type</strong>{request.requestType}</span>
    <span><strong>Requester</strong>{formatDisplayValue(request.requestedBy?.username, request.requestedBy?.discordUserId || "unknown")}</span>
    <span><strong>Source</strong>{request.source}</span>
    <span><strong>Created</strong>{formatDate(request.createdAt)}</span>
    <span><strong>Updated</strong>{formatDate(request.updatedAt)}</span>
    <span><strong>Job</strong>{formatDisplayValue(request.jobId || request.details?.jobId, "none")}</span>
    <span><strong>Task</strong>{formatDisplayValue(request.taskId || request.details?.taskId, "none")}</span>
  </div>
);

/**
 * Render the Moon admin request moderation inbox.
 *
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const RequestsPage = ({user}) => {
  const canWrite = hasAdminGrant(user, "requests", "write");
  const canRoot = hasAdminGrant(user, "requests", "root");
  const [tab, setTab] = useState("needsReview");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selectedBulkIds, setSelectedBulkIds] = useState([]);
  const [bulkDenyComment, setBulkDenyComment] = useState("");
  const [denyComment, setDenyComment] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [metadataResults, setMetadataResults] = useState([]);
  const [selectedMetadata, setSelectedMetadata] = useState(null);
  const [downloadOptions, setDownloadOptions] = useState([]);
  const [selectedDownload, setSelectedDownload] = useState(null);
  const [busy, setBusy] = useState("");
  const [flash, setFlash] = useState("");
  const [flashTone, setFlashTone] = useState("");
  const {notify} = useAdminToast();
  const {loading, refreshing, error, data, refresh} = useAdminJson("/api/moon/v3/admin/requests", {
    fallback: emptyPayload
  });
  useAdminEventStaleness({
    domains: ["requests", "activity"],
    enabled: true,
    locked: Boolean(busy),
    onStale: () => {},
    onRefresh: refresh
  });

  const requests = normalizeArray(data?.requests);
  const counts = data?.counts || buildRequestCounts(requests);
  const visibleRequests = useMemo(() => filterRequests(requests, {tab, query}), [requests, tab, query]);
  const selectedRequest = requests.find((request) => requestRowKey(request) === selectedId) || null;
  const selectedBulkRequests = useMemo(() => {
    const selected = new Set(selectedBulkIds);
    return requests.filter((request) => selected.has(requestRowKey(request)));
  }, [requests, selectedBulkIds]);
  const bulkRefreshable = useMemo(() => bulkRefreshCandidates(selectedBulkRequests, {canWrite}), [selectedBulkRequests, canWrite]);
  const bulkDeniable = useMemo(() => bulkDenyCandidates(selectedBulkRequests, {canWrite}), [selectedBulkRequests, canWrite]);
  const allVisibleSelected = visibleRequests.length > 0 && visibleRequests.every((request) => selectedBulkIds.includes(requestRowKey(request)));
  const actions = requestActionState(selectedRequest || {}, {canWrite, canRoot});

  useEffect(() => {
    setSelectedId((current) => resolveExistingRequestSelection(requests, current));
  }, [requests]);

  useEffect(() => {
    const existing = new Set(requests.map((request) => requestRowKey(request)));
    setSelectedBulkIds((current) => current.filter((id) => existing.has(id)));
  }, [requests]);

  useEffect(() => {
    if (!selectedRequest) {
      return;
    }
    setDenyComment("");
    setSourceQuery(normalizeString(selectedRequest.details?.query, selectedRequest.title));
    setMetadataResults([]);
    setSelectedMetadata(selectedRequest.details?.selectedMetadata || null);
    setDownloadOptions(normalizeArray(selectedRequest.details?.sourceFoundOptions));
    setSelectedDownload(selectedRequest.details?.selectedDownload || null);
  }, [selectedId, selectedRequest]);

  const setResult = (ok, message, category = "action") => {
    setFlash(message);
    setFlashTone(ok ? "good" : "bad");
    notify({message, tone: ok ? "good" : "bad", category});
  };

  const runRequestAction = async (label, path, options = {}, category = "action") => {
    if (!selectedRequest) {
      return null;
    }
    setBusy(label);
    const result = await requestJson(`/api/moon/v3/admin/requests/${encodeURIComponent(requestRowKey(selectedRequest))}${path}`, options);
    setBusy("");
    setResult(result.ok, result.ok ? `${label} complete.` : result.payload?.error || `Moon could not ${label.toLowerCase()}.`, category);
    if (result.ok) {
      await refresh();
    }
    return result;
  };

  const toggleBulkRequest = (requestId) => {
    setSelectedBulkIds((current) =>
      current.includes(requestId) ? current.filter((entry) => entry !== requestId) : [...current, requestId]
    );
  };

  const toggleAllVisible = () => {
    const visibleIds = visibleRequests.map((request) => requestRowKey(request)).filter(Boolean);
    setSelectedBulkIds((current) => {
      if (visibleIds.length && visibleIds.every((id) => current.includes(id))) {
        return current.filter((id) => !visibleIds.includes(id));
      }
      return [...new Set([...current, ...visibleIds])];
    });
  };

  const runBulkAction = async (label, rows, path, optionsForRow, category = "action") => {
    if (!rows.length) {
      setResult(false, `No selected requests can ${label.toLowerCase()}.`);
      return;
    }
    setBusy(label);
    let okCount = 0;
    let lastError = "";
    for (const request of rows) {
      const result = await requestJson(`/api/moon/v3/admin/requests/${encodeURIComponent(requestRowKey(request))}${path}`, optionsForRow(request));
      if (result.ok) {
        okCount += 1;
      } else {
        lastError = result.payload?.error || `Could not ${label.toLowerCase()} ${request.title || "request"}.`;
      }
    }
    setBusy("");
    const ok = okCount === rows.length;
    setResult(ok, ok
      ? `${label} complete for ${okCount} request${okCount === 1 ? "" : "s"}.`
      : `${label} completed for ${okCount}/${rows.length}. ${lastError}`, category);
    await refresh();
  };

  const refreshSelectedSources = async () => {
    await runBulkAction("Refresh sources", bulkRefreshable, "/refresh-sources", () => ({method: "POST"}));
  };

  const denySelectedRequests = async () => {
    const comment = normalizeString(bulkDenyComment);
    if (!comment) {
      setResult(false, "Enter a bulk denial comment first.");
      return;
    }
    await runBulkAction("Deny", bulkDeniable, "/deny", () => ({
      method: "POST",
      json: {comment}
    }));
    setBulkDenyComment("");
  };

  const searchMetadata = async () => {
    const normalizedQuery = normalizeString(sourceQuery, selectedRequest?.title || "");
    if (!normalizedQuery) {
      setResult(false, "Enter a title before searching metadata.");
      return;
    }
    setBusy("metadata-search");
    const result = await requestJson(`/api/moon/v3/admin/requests/metadata-search?query=${encodeURIComponent(normalizedQuery)}`);
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

  const loadDownloadOptions = async (metadata) => {
    setSelectedMetadata(metadata);
    setSelectedDownload(null);
    setBusy("source-search");
    const result = await requestJson("/api/moon/v3/admin/requests/download-options", {
      method: "POST",
      json: {
        query: sourceQuery || selectedRequest?.title || "",
        selectedMetadata: metadata
      }
    });
    setBusy("");
    if (!result.ok) {
      setDownloadOptions([]);
      setResult(false, result.payload?.error || "Source lookup failed.");
      return;
    }
    const results = normalizeArray(result.payload?.results);
    setDownloadOptions(results);
    setResult(Boolean(results.length), results.length ? `Found ${results.length} source option${results.length === 1 ? "" : "s"}.` : "No enabled download source matched this metadata.");
  };

  const approveSelected = async () => {
    await runRequestAction("Approve", "/approve", {
      method: "POST",
      json: {
        query: sourceQuery,
        comment: "Approved from Moon admin.",
        selectedMetadata: selectedMetadata || selectedRequest?.details?.selectedMetadata,
        selectedDownload: selectedDownload || selectedRequest?.details?.selectedDownload
      }
    }, "job");
  };

  const resolveSelected = async () => {
    await runRequestAction("Resolve", "/resolve", {
      method: "POST",
      json: {
        query: sourceQuery,
        selectedMetadata: selectedMetadata || selectedRequest?.details?.selectedMetadata,
        selectedDownload
      }
    }, "job");
  };

  const overrideSelected = async () => {
    await runRequestAction("Override", "/override", {
      method: "POST",
      json: {
        query: sourceQuery,
        notes: selectedRequest?.notes || "",
        selectedMetadata: selectedMetadata || selectedRequest?.details?.selectedMetadata,
        selectedDownload: selectedDownload || null
      }
    });
  };

  const denySelected = async () => {
    await runRequestAction("Deny", "/deny", {
      method: "POST",
      json: {comment: denyComment}
    });
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">Community</div>
        <h2>Loading Requests</h2>
        <p>Moon is loading the moderation inbox and saved request snapshots.</p>
      </section>
    );
  }

  return (
    <>
      {error ? <AdminActionBanner tone="bad">{error}</AdminActionBanner> : null}
      {flash ? <AdminActionBanner tone={flashTone}>{flash}</AdminActionBanner> : null}
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Community</div>
            <h2>Requests</h2>
            <p className="admin-muted">Review saved metadata, pick Raven sources, resolve unavailable requests, and close bad matches.</p>
          </div>
          <AdminStatusBadge tone={refreshing ? "warning" : "good"}>{refreshing ? "Refreshing" : "Live"}</AdminStatusBadge>
        </div>
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Needs review</span><strong>{counts.needsReview || 0}</strong></article>
          <article className="admin-metric-card"><span>Queued</span><strong>{counts.queued || 0}</strong></article>
          <article className="admin-metric-card"><span>Failed</span><strong>{counts.failed || 0}</strong></article>
          <article className="admin-metric-card"><span>Waitlisted</span><strong>{counts.waitlisted || 0}</strong></article>
        </div>
        <div className="admin-tab-row" role="tablist" aria-label="Request inbox tabs">
          {requestTabs.map((entry) => (
            <button className={`admin-tab ${tab === entry.id ? "is-active" : ""}`} key={entry.id} type="button" onClick={() => setTab(entry.id)}>
              {entry.label}
              <span>{entry.id === "all" ? counts.total || 0 : counts[entry.id] || 0}</span>
            </button>
          ))}
        </div>
        <AdminFilterBar>
          <label className="admin-filter-grow">
            <span>Search</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, requester, provider, status..." />
          </label>
        </AdminFilterBar>
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Inbox</div>
            <h2>{visibleRequests.length} request{visibleRequests.length === 1 ? "" : "s"}</h2>
          </div>
        </div>
        {selectedBulkIds.length ? (
          <div className="admin-confirm-panel">
            <div>
              <div className="admin-kicker">Bulk moderation</div>
              <strong>{selectedBulkIds.length} selected</strong>
              <p className="admin-muted">{bulkRefreshable.length} can refresh sources. {bulkDeniable.length} can be denied.</p>
            </div>
            <input
              aria-label="Bulk denial comment"
              value={bulkDenyComment}
              onChange={(event) => setBulkDenyComment(event.target.value)}
              placeholder="Required for bulk deny"
            />
            <button className="admin-button ghost" type="button" disabled={!bulkRefreshable.length || busy === "Refresh sources"} onClick={() => void refreshSelectedSources()}>Refresh selected sources</button>
            <button className="admin-button ghost danger" type="button" disabled={!bulkDeniable.length || !normalizeString(bulkDenyComment) || busy === "Deny"} onClick={() => void denySelectedRequests()}>Deny selected</button>
          </div>
        ) : null}
        <AdminDenseTable
          rows={visibleRequests}
          getKey={(row) => requestRowKey(row)}
          selectedKey={selectedId}
          onRowClick={(row) => setSelectedId(requestRowKey(row))}
          columns={[
            {key: "select", label: "", render: (row) => (
              <input
                aria-label={`Select ${normalizeString(row.title, "request")}`}
                checked={selectedBulkIds.includes(requestRowKey(row))}
                onChange={() => toggleBulkRequest(requestRowKey(row))}
                onClick={(event) => event.stopPropagation()}
                type="checkbox"
              />
            )},
            {key: "title", label: "Request", render: (row) => (
              <div className="admin-inline-record">
                <RequestCover request={row} />
                <div>
                  <strong>{row.title}</strong>
                  <span>{formatDisplayValue(row.requestedBy?.username, row.requestedBy?.discordUserId || "unknown")}</span>
                </div>
              </div>
            )},
            {key: "status", label: "Status", render: (row) => <AdminStatusBadge tone={statusTone(row.status)}>{row.status}</AdminStatusBadge>},
            {key: "metadata", label: "Metadata", render: (row) => formatDisplayValue(row.details?.selectedMetadata?.providerName, row.details?.selectedMetadata?.provider || "pending")},
            {key: "source", label: "Source", render: (row) => formatDisplayValue(row.details?.selectedDownload?.providerName, row.details?.selectedDownload?.providerId || row.availability)},
            {key: "updatedAt", label: "Updated", render: (row) => formatDate(row.updatedAt)}
          ]}
          empty="No requests match this view."
        />
        {visibleRequests.length ? (
          <button className="admin-button ghost small" type="button" onClick={toggleAllVisible}>
            {allVisibleSelected ? "Clear visible selection" : "Select visible"}
          </button>
        ) : null}
      </section>

      <AdminDrawer
        open={Boolean(selectedRequest)}
        title={normalizeString(selectedRequest?.title, "Request detail")}
        kicker="Moderation"
        onClose={() => setSelectedId("")}
      >
        {selectedRequest ? (
          <div className="admin-drawer-stack">
            <div className="admin-request-hero">
              <RequestCover request={selectedRequest} />
              <div>
                <AdminStatusBadge tone={statusTone(selectedRequest.status)}>{selectedRequest.status}</AdminStatusBadge>
                <p>{formatDisplayValue(selectedRequest.notes, "No requester notes.")}</p>
                {selectedRequest.moderatorComment ? <p className="admin-muted">Moderator: {selectedRequest.moderatorComment}</p> : null}
              </div>
            </div>
            <RequestDetailGrid request={selectedRequest} />

            <section className="admin-subsection">
              <div className="admin-section-heading">
                <div>
                  <div className="admin-kicker">Source resolver</div>
                  <h3>Metadata and download source</h3>
                </div>
                <button className="admin-button ghost small" type="button" disabled={!actions.canRefreshSources || busy === "Refresh sources"} onClick={() => void runRequestAction("Refresh sources", "/refresh-sources", {method: "POST"})}>Refresh sources</button>
              </div>
              <div className="admin-task-form">
                <label>
                  <span>Search title</span>
                  <input value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} />
                </label>
                <button className="admin-button solid" type="button" disabled={!canWrite || busy === "metadata-search"} onClick={() => void searchMetadata()}>Search metadata</button>
              </div>
              {metadataResults.length ? (
                <div className="admin-source-list">
                  {metadataResults.map((entry) => (
                    <SourceCard
                      entry={entry}
                      kind="metadata"
                      key={`${entry.provider}:${entry.providerSeriesId}`}
                      selected={selectedMetadata?.provider === entry.provider && selectedMetadata?.providerSeriesId === entry.providerSeriesId}
                      onPick={(metadata) => void loadDownloadOptions(metadata)}
                    />
                  ))}
                </div>
              ) : null}
              <div className="admin-source-list">
                {downloadOptions.map((entry) => (
                  <SourceCard
                    entry={entry}
                    key={sourceKey(entry)}
                    selected={sourceKey(selectedDownload || {}) === sourceKey(entry)}
                    onPick={setSelectedDownload}
                  />
                ))}
              </div>
            </section>

            <section className="admin-subsection">
              <div className="admin-section-heading">
                <div>
                  <div className="admin-kicker">Snapshots</div>
                  <h3>Saved metadata and source</h3>
                </div>
              </div>
              <div className="admin-json-columns">
                <pre>{JSON.stringify(selectedRequest.details?.selectedMetadata || {}, null, 2)}</pre>
                <pre>{JSON.stringify(selectedRequest.details?.selectedDownload || {}, null, 2)}</pre>
              </div>
            </section>

            {normalizeArray(selectedRequest.details?.waitlist).length ? (
              <section className="admin-subsection">
                <div className="admin-kicker">Waitlist</div>
                <div className="admin-log-meta">
                  {normalizeArray(selectedRequest.details.waitlist).map((entry) => (
                    <span key={entry.discordUserId}>{formatDisplayValue(entry.username, entry.discordUserId)}</span>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="admin-subsection">
              <div className="admin-kicker">Timeline</div>
              <div className="admin-event-list">
                {normalizeArray(selectedRequest.timeline).map((entry, index) => (
                  <article key={`${entry.type}-${entry.at}-${index}`}>
                    <strong>{entry.type}</strong>
                    <span>{formatDate(entry.at)} by {formatDisplayValue(entry.actor, "system")}</span>
                    <p>{entry.message}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="admin-subsection">
              <div className="admin-kicker">Moderation actions</div>
              <div className="admin-action-row">
                <button className="admin-button solid" type="button" disabled={!actions.canApprove || busy === "Approve"} onClick={() => void approveSelected()}>Approve source</button>
                <button className="admin-button solid" type="button" disabled={!actions.canResolve || !selectedDownload || busy === "Resolve"} onClick={() => void resolveSelected()}>Resolve unavailable</button>
                <button className="admin-button ghost" type="button" disabled={!actions.canOverride || busy === "Override"} onClick={() => void overrideSelected()}>Override snapshot</button>
              </div>
              <label className="admin-full-field">
                <span>Denial comment</span>
                <textarea rows={3} value={denyComment} onChange={(event) => setDenyComment(event.target.value)} placeholder="Required before denying a request" />
              </label>
              <button className="admin-button ghost danger" type="button" disabled={!actions.canDeny || !normalizeString(denyComment) || busy === "Deny"} onClick={() => void denySelected()}>Deny request</button>
            </section>
          </div>
        ) : null}
      </AdminDrawer>
    </>
  );
};

export default RequestsPage;
