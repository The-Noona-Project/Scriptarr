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

const schedulerState = (run) => normalizeString(run?.runtime?.schedulerState, normalizeString(run?.status, "queued")).toLowerCase();

const schedulerCopy = (run) => {
  const state = schedulerState(run);
  if (state === "running") {
    return "Running current title";
  }
  if (state === "waiting") {
    const position = Number(run?.runtime?.queuedPosition || 0) || 0;
    return position > 0 ? `Waiting for worker slot ${position}` : "Waiting for worker slot";
  }
  if (state === "needs-recovery") {
    return "Needs recovery";
  }
  if (state === "detached") {
    return "Waiting to resume";
  }
  if (state === "cancelling") {
    return "Cancelling";
  }
  return normalizeString(run?.status, "queued");
};

const schedulerTone = (run) => {
  const state = schedulerState(run);
  if (state === "running") {
    return "good";
  }
  if (state === "needs-recovery" || state === "detached") {
    return "bad";
  }
  return statusTone(run?.status);
};

const etaCopy = (run) => {
  const eta = formatEta(run?.etaMinutes);
  if (eta) {
    return eta;
  }
  const state = schedulerState(run);
  if (state === "running") {
    return "measuring";
  }
  if (state === "waiting") {
    return "waiting";
  }
  if (state === "needs-recovery") {
    return "needs recovery";
  }
  return "";
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
 *   empty?: string,
 *   canWrite?: boolean,
 *   busyRunId?: string,
 *   onResume?: (run: Record<string, any>) => Promise<void>,
 *   onCancel?: (run: Record<string, any>) => Promise<void>
 * }} props
 * @returns {import("react").ReactNode}
 */
export const IngestRunsPanel = ({
  runs,
  title = "AVIF runs",
  kicker = "Library ingest",
  includeRecent = true,
  empty = "No durable AVIF ingest runs are active right now.",
  canWrite = false,
  busyRunId = "",
  onResume,
  onCancel
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
            <div>
              <AdminStatusBadge tone={schedulerTone(row)}>{schedulerCopy(row)}</AdminStatusBadge>
              {normalizeString(row.message) ? <p className="admin-muted">{normalizeString(row.message)}</p> : null}
            </div>
          )},
          {key: "current", label: "Current", render: (row) => (
            normalizeString(row.current?.titleName)
              ? <span>{normalizeString(row.current.titleName)}</span>
              : <span className="admin-muted">{schedulerState(row) === "waiting" ? "waiting" : "none"}</span>
          )},
          {key: "progress", label: "Progress", render: (row) => <RunProgress run={row} />},
          {key: "eta", label: "ETA", render: (row) => etaCopy(row)},
          {key: "updated", label: "Updated", render: (row) => formatDate(row.runtime?.lastProgressAt || row.updatedAt || row.startedAt || row.createdAt)},
          {key: "actions", label: "", render: (row) => {
            const busy = busyRunId === normalizeString(row.runId);
            const canResume = canWrite && row.actions?.resume === true && typeof onResume === "function";
            const canCancel = canWrite && row.actions?.cancel === true && typeof onCancel === "function";
            return canResume || canCancel ? (
              <div className="admin-action-row">
                {canResume ? (
                  <button className="admin-button ghost small" type="button" disabled={busy} onClick={() => onResume(row)}>
                    {busy ? "Working" : "Resume"}
                  </button>
                ) : null}
                {canCancel ? (
                  <button className="admin-button ghost danger small" type="button" disabled={busy} onClick={() => onCancel(row)}>
                    {busy ? "Working" : "Cancel"}
                  </button>
                ) : null}
              </div>
            ) : null;
          }}
        ]}
      />
    </section>
  );
};

export default IngestRunsPanel;
