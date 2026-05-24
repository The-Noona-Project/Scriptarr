"use client";

/**
 * @file Durable AVIF ingest-run summaries shared by Moon admin pages.
 */

import {formatDate, formatEta, formatPercent, normalizeString} from "../lib/format.js";
import {AdminDenseTable, AdminStatusBadge} from "./AdminUi.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const normalizeRunRows = (runs, {includeRecent = true} = {}) => {
  if (Array.isArray(runs)) {
    return runs;
  }
  const active = normalizeArray(runs?.active);
  const recent = includeRecent ? normalizeArray(runs?.recent) : [];
  return [...active, ...recent];
};

const statusTone = (status) => {
  const normalized = normalizeString(status).toLowerCase();
  if (normalized === "completed") {
    return "good";
  }
  if (normalized === "failed" || normalized === "cancelled") {
    return "bad";
  }
  return "warning";
};

const runCounts = (run) => {
  const counts = run?.counts || {};
  return {
    total: Number(counts.totalTitles || 0) || 0,
    completed: Number(counts.completedTitles || 0) || 0,
    failed: Number(counts.failedTitles || 0) || 0,
    remaining: Number(counts.remainingTitles || 0) || 0
  };
};

const RunProgress = ({run}) => {
  const counts = runCounts(run);
  const percent = Number(run?.percent || 0) || 0;
  return (
    <div>
      <div className="queue-progress" aria-label={`Progress ${formatPercent(percent)}`}>
        <span style={{width: formatPercent(percent)}} />
      </div>
      <p className="admin-muted">
        {counts.completed} done / {counts.total} titles
        {counts.failed ? `, ${counts.failed} failed` : ""}
        {counts.remaining ? `, ${counts.remaining} left` : ""}
      </p>
    </div>
  );
};

/**
 * Render durable AVIF ingest-run summaries without title-task controls.
 *
 * @param {{
 *   runs: Array<Record<string, any>> | {active?: Array<Record<string, any>>, recent?: Array<Record<string, any>>},
 *   title?: string,
 *   kicker?: string,
 *   includeRecent?: boolean,
 *   empty?: string
 * }} props
 * @returns {import("react").ReactNode}
 */
export const IngestRunsPanel = ({
  runs,
  title = "AVIF runs",
  kicker = "Library ingest",
  includeRecent = true,
  empty = "No durable AVIF ingest runs are active right now."
}) => {
  const rows = normalizeRunRows(runs, {includeRecent});

  return (
    <section className="admin-panel">
      <div className="admin-section-heading">
        <div>
          <div className="admin-kicker">{kicker}</div>
          <h2>{title}</h2>
        </div>
        <span className="admin-muted">{rows.length} run{rows.length === 1 ? "" : "s"}</span>
      </div>
      <AdminDenseTable
        rows={rows}
        empty={empty}
        getKey={(row) => normalizeString(row.runId)}
        columns={[
          {key: "type", label: "Type", render: (row) => (
            <div>
              <strong>{normalizeString(row.libraryTypeLabel, normalizeString(row.libraryTypeSlug, "Library"))}</strong>
              <p className="admin-muted">{normalizeString(row.runId)}</p>
            </div>
          )},
          {key: "status", label: "Status", render: (row) => (
            <AdminStatusBadge tone={statusTone(row.status)}>{normalizeString(row.status, "queued")}</AdminStatusBadge>
          )},
          {key: "progress", label: "Progress", render: (row) => <RunProgress run={row} />},
          {key: "eta", label: "ETA", render: (row) => formatEta(row.etaMinutes) || (normalizeString(row.status).toLowerCase() === "running" ? "measuring" : "")},
          {key: "updated", label: "Updated", render: (row) => formatDate(row.updatedAt || row.startedAt || row.createdAt)}
        ]}
      />
    </section>
  );
};

export default IngestRunsPanel;
