"use client";

/**
 * @file Raven reader-page ingest backlog page for Moon admin.
 */

import {useCallback, useEffect, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {formatDate, normalizeString} from "../lib/format.js";
import {useAdminToast} from "./AdminToasts.jsx";
import {AdminActionBanner, AdminDenseTable, AdminStatusBadge} from "./AdminUi.jsx";
import {IngestRunsPanel} from "./IngestRunsPanel.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const ACTIVE_INGEST_POLL_INTERVAL_MS = 5_000;
const IDLE_INGEST_POLL_INTERVAL_MS = 30_000;

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
 * Render the reader-page ingest backlog and retry controls.
 *
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const IngestPage = ({user}) => {
  const {loading, refreshing, error, data, lastLoadedAt, lastRefreshError, refresh, setData} = useAdminJson("/api/moon/v3/admin/ingest", {
    fallback: {summary: {}, titles: []}
  });
  const [busyTitleId, setBusyTitleId] = useState("");
  const [overviewRefreshing, setOverviewRefreshing] = useState(false);
  const [overviewLoadedAt, setOverviewLoadedAt] = useState("");
  const {notify} = useAdminToast();
  const canWrite = hasAdminGrant(user, "import", "write");
  const live = useAdminEventStaleness({
    domains: ["import", "activity", "library"],
    enabled: true,
    locked: Boolean(busyTitleId),
    onStale: () => {},
    onRefresh: refresh
  });
  const summary = data?.summary || {};
  const hardware = summary.hardware || {};
  const titles = normalizeArray(data?.titles);
  const activeRuns = normalizeArray(data?.runs?.active);
  const hasActiveRuns = activeRuns.length > 0;
  const retryableTitleCount = titles.filter((title) => normalizeString(title.ingestStatus, "pending").toLowerCase() !== "ready").length;
  const retryAllBusy = busyTitleId === "__all__";
  const lastSeenAt = overviewLoadedAt || lastLoadedAt;
  const refreshLabel = (() => {
    if (refreshing || overviewRefreshing) {
      return "Updating";
    }
    if (live.state === "live") {
      return "Live";
    }
    if (lastRefreshError && lastSeenAt) {
      return `Showing data from ${formatDate(lastSeenAt)}`;
    }
    return "Backup refresh";
  })();
  const refreshTone = live.state === "live" && !lastRefreshError ? "good" : "warning";

  const refreshOverview = useCallback(async () => {
    setOverviewRefreshing(true);
    const result = await requestJson("/api/moon/v3/admin/ingest/overview");
    if (result.ok) {
      setData((current) => ({
        ...(current || {}),
        summary: {
          ...(current?.summary || {}),
          hardware: result.payload?.summary?.hardware || current?.summary?.hardware || {}
        },
        runs: result.payload?.runs || current?.runs || {}
      }));
      setOverviewLoadedAt(new Date().toISOString());
    } else if (!hasActiveRuns) {
      await refresh();
    }
    setOverviewRefreshing(false);
  }, [hasActiveRuns, refresh, setData]);

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

  const retryAll = async () => {
    setBusyTitleId("__all__");
    const result = await requestJson("/api/moon/v3/admin/ingest/retry-all", {method: "POST"});
    notify({
      message: result.ok ? result.payload?.message || "AVIF rebuilds started." : result.payload?.error || "Moon could not start AVIF rebuilds.",
      tone: result.ok && Number(result.payload?.failedCount || 0) === 0 ? "good" : "bad",
      category: "job"
    });
    setBusyTitleId("");
    await refresh();
  };

  const runAction = async (action, run) => {
    const runId = normalizeString(run.runId);
    if (!runId) {
      return;
    }
    setBusyTitleId(`${action}:${runId}`);
    const result = await requestJson(`/api/moon/v3/admin/ingest/runs/${encodeURIComponent(runId)}/${action}`, {method: "POST"});
    notify({
      message: result.ok
        ? `${action === "cancel" ? "Cancelled" : "Resumed"} AVIF run.`
        : result.payload?.error || `Moon could not ${action} that AVIF run.`,
      tone: result.ok ? "good" : "bad",
      category: "job"
    });
    setBusyTitleId("");
    await refresh();
  };

  useEffect(() => {
    if (busyTitleId || typeof window === "undefined") {
      return undefined;
    }
    const interval = window.setInterval(
      () => void (hasActiveRuns ? refreshOverview() : refresh()),
      hasActiveRuns ? ACTIVE_INGEST_POLL_INTERVAL_MS : IDLE_INGEST_POLL_INTERVAL_MS
    );
    return () => window.clearInterval(interval);
  }, [busyTitleId, hasActiveRuns, refresh, refreshOverview]);

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">Import</div>
        <h2>Loading ingest</h2>
        <p>Moon is reading Raven reader-page ingest state.</p>
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

  return (
    <div className="queue-page">
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Import</div>
            <h2>AVIF ingest</h2>
          </div>
          <AdminStatusBadge tone={refreshTone}>
            {refreshLabel}
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

      <IngestRunsPanel
        runs={data?.runs || {}}
        title="AVIF runs"
        kicker="Library ingest"
        empty="No durable AVIF ingest runs are active right now."
        canWrite={canWrite}
        busyRunId={busyTitleId.includes(":") ? busyTitleId.split(":").pop() : ""}
        onResume={(run) => runAction("resume", run)}
        onCancel={(run) => runAction("cancel", run)}
      />

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Backlog</div>
            <h2>{titles.length} title{titles.length === 1 ? "" : "s"}</h2>
          </div>
          <div className="admin-action-row">
            {canWrite && retryableTitleCount ? (
              <button
                className="admin-button solid small"
                type="button"
                disabled={retryAllBusy}
                onClick={retryAll}
              >
                {retryAllBusy ? "Starting rebuild" : "Start / rebuild all"}
              </button>
            ) : null}
            <span className="admin-muted">{retryableTitleCount} retryable</span>
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
                disabled={Boolean(busyTitleId)}
                onClick={() => retry(row.id)}
              >
                {busyTitleId === row.id ? "Retrying" : "Retry"}
              </button>
            ) : null}
          ]}
        />
      </section>
    </div>
  );
};

export default IngestPage;
