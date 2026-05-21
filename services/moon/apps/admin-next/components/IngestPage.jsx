"use client";

/**
 * @file Raven WebP ingest backlog page for Moon admin.
 */

import {useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {formatDate, normalizeString} from "../lib/format.js";
import {useAdminToast} from "./AdminToasts.jsx";
import {AdminActionBanner, AdminDenseTable, AdminStatusBadge} from "./AdminUi.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const statusTone = (status) => {
  const normalized = normalizeString(status).toLowerCase();
  if (normalized === "ready") {
    return "good";
  }
  if (normalized === "failed" || normalized === "hardware_missing") {
    return "bad";
  }
  return "warning";
};

/**
 * Render the WebP ingest backlog and retry controls.
 *
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const IngestPage = ({user}) => {
  const {loading, refreshing, error, data, refresh} = useAdminJson("/api/moon/v3/admin/ingest", {
    fallback: {summary: {}, titles: []}
  });
  const [busyTitleId, setBusyTitleId] = useState("");
  const {notify} = useAdminToast();
  const canWrite = hasAdminGrant(user, "import", "write");
  const live = useAdminEventStaleness({
    domains: ["import", "activity", "library"],
    enabled: true,
    locked: Boolean(busyTitleId),
    onStale: () => {},
    onRefresh: refresh
  });

  const retry = async (titleId) => {
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
        <div className="admin-kicker">Import</div>
        <h2>Loading ingest</h2>
        <p>Moon is reading Raven WebP ingest state.</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="admin-panel admin-state-panel is-danger">
        <div className="admin-kicker">Import</div>
        <h2>Ingest unavailable</h2>
        <p>{error}</p>
      </section>
    );
  }

  const summary = data?.summary || {};
  const hardware = summary.hardware || {};
  const titles = normalizeArray(data?.titles);

  return (
    <div className="queue-page">
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Import</div>
            <h2>WebP ingest</h2>
          </div>
          <AdminStatusBadge tone={live.state === "live" ? "good" : "warning"}>
            {refreshing ? "Refreshing quietly" : live.state === "live" ? "Live" : "Degraded"}
          </AdminStatusBadge>
        </div>
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Ready</span><strong>{summary.readyTitles ?? 0}</strong></article>
          <article className="admin-metric-card"><span>Pending</span><strong>{summary.pendingTitles ?? 0}</strong></article>
          <article className="admin-metric-card"><span>Failed</span><strong>{summary.failedTitles ?? 0}</strong></article>
          <article className="admin-metric-card"><span>Hardware</span><strong>{normalizeString(hardware.state, "unknown")}</strong></article>
        </div>
      </section>

      {normalizeString(hardware.state) === "hardware_missing" ? (
        <AdminActionBanner tone="bad">NVIDIA runtime access is missing for Raven ingest.</AdminActionBanner>
      ) : null}

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Backlog</div>
            <h2>{titles.length} title{titles.length === 1 ? "" : "s"}</h2>
          </div>
        </div>
        <AdminDenseTable
          rows={titles}
          getKey={(row) => normalizeString(row.id)}
          columns={[
            {key: "title", label: "Title", render: (row) => <strong>{normalizeString(row.title, "Untitled")}</strong>},
            {key: "type", label: "Type", render: (row) => normalizeString(row.libraryTypeLabel, "Manga")},
            {key: "status", label: "Status", render: (row) => (
              <AdminStatusBadge tone={statusTone(row.ingestStatus)}>{normalizeString(row.ingestStatus, "pending")}</AdminStatusBadge>
            )},
            {key: "pages", label: "Chapters", render: (row) => `${row.ingestedChapterCount ?? 0}/${row.chapterCount ?? 0}`},
            {key: "updated", label: "Updated", render: (row) => formatDate(row.updatedAt)},
            {key: "actions", label: "", render: (row) => canWrite && row.ingestStatus !== "ready" ? (
              <button
                className="admin-button ghost small"
                type="button"
                disabled={busyTitleId === row.id}
                onClick={() => retry(row.id)}
              >
                Retry
              </button>
            ) : null}
          ]}
        />
      </section>
    </div>
  );
};

export default IngestPage;
