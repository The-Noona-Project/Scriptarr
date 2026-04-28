"use client";

/**
 * @file Live Raven queue board for the Next-based Moon admin foundation.
 */

import {useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {formatDate, formatEta, formatPercent, formatTransferRate, normalizeString} from "../lib/format.js";
import {useAdminToast} from "./AdminToasts.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

/**
 * Render a compact status badge.
 *
 * @param {{children: import("react").ReactNode, tone?: string}} props
 * @returns {import("react").ReactNode}
 */
const Badge = ({children, tone = "neutral"}) => (
  <span className={`admin-badge ${tone}`}>{children}</span>
);

/**
 * Render a fallback-safe cover thumbnail.
 *
 * @param {{task: Record<string, any>}} props
 * @returns {import("react").ReactNode}
 */
const QueueCover = ({task}) => {
  const title = normalizeString(task.titleName, "Untitled");
  return (
    <div className="queue-cover">
      {normalizeString(task.coverUrl) ? <img src={task.coverUrl} alt="" /> : <span>{title.slice(0, 1).toUpperCase()}</span>}
    </div>
  );
};

/**
 * Render a queue metric.
 *
 * @param {{label: string, value: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
const MetricCard = ({label, value}) => (
  <article className="admin-metric-card">
    <span>{label}</span>
    <strong>{value}</strong>
  </article>
);

/**
 * Render controls for one Raven task card.
 *
 * @param {{
 *   task: Record<string, any>,
 *   permissions: {canWrite: boolean, canRoot: boolean},
 *   onAction: (action: string, task: Record<string, any>, body?: any) => Promise<void>,
 *   onDirtyChange: (dirty: boolean) => void
 * }} props
 * @returns {import("react").ReactNode}
 */
const QueueControls = ({task, permissions, onAction, onDirtyChange}) => {
  const [priority, setPriority] = useState(normalizeString(task.priority, "normal"));
  const status = normalizeString(task.status).toLowerCase();
  const canRetry = permissions.canWrite && task.retriable === true;
  const canRemove = permissions.canWrite && task.removable === true;
  const canQueueMutate = permissions.canWrite && status === "queued";
  const canCancel = status === "running" ? permissions.canRoot : permissions.canWrite && status === "queued";

  return (
    <div className="queue-controls">
      <div className="admin-action-row">
        {canRetry ? <button className="admin-button ghost small" type="button" onClick={() => onAction("retry", task)}>Retry</button> : null}
        {canRemove ? <button className="admin-button ghost danger small" type="button" onClick={() => onAction("remove", task)}>Remove</button> : null}
        {canCancel ? <button className="admin-button ghost small" type="button" onClick={() => onAction("cancel", task)}>Cancel</button> : null}
        {canQueueMutate ? <button className="admin-button ghost small" type="button" onClick={() => onAction("move-up", task)}>Move up</button> : null}
        {canQueueMutate ? <button className="admin-button ghost small" type="button" onClick={() => onAction("move-down", task)}>Move down</button> : null}
      </div>
      {canQueueMutate ? (
        <div className="queue-priority-row">
          <label htmlFor={`queue-priority-${task.taskId}`}>Priority</label>
          <select
            id={`queue-priority-${task.taskId}`}
            value={priority}
            onBlur={() => onDirtyChange(false)}
            onChange={(event) => {
              setPriority(event.target.value);
              onDirtyChange(true);
            }}
            onFocus={() => onDirtyChange(true)}
          >
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
          <button className="admin-button solid small" type="button" onClick={() => onAction("priority", task, {priority})}>Save</button>
        </div>
      ) : null}
    </div>
  );
};

/**
 * Render one Raven task card.
 *
 * @param {{
 *   task: Record<string, any>,
 *   permissions: {canWrite: boolean, canRoot: boolean},
 *   onAction: (action: string, task: Record<string, any>, body?: any) => Promise<void>,
 *   onDirtyChange: (dirty: boolean) => void
 * }} props
 * @returns {import("react").ReactNode}
 */
const QueueTaskCard = ({task, permissions, onAction, onDirtyChange}) => {
  const selectedDownload = task.selectedDownload || {};
  const status = normalizeString(task.status, "queued");
  const active = status.toLowerCase() === "running";
  const speedSummary = active ? formatTransferRate(task.downloadSpeedBytesPerSecond) : "";
  const etaSummary = active ? formatEta(task.etaMinutes) : "";
  const metaItems = [
    `Progress ${formatPercent(task.percent)}`,
    `Priority ${normalizeString(task.priority, "normal")}`
  ];
  if (speedSummary) {
    metaItems.push(`Speed ${speedSummary}`);
  }
  if (etaSummary) {
    metaItems.push(`ETA ${etaSummary}`);
  }
  metaItems.push(`Updated ${formatDate(task.updatedAt || task.queuedAt)}`);

  return (
    <article className="queue-card">
      <QueueCover task={task} />
      <div className="queue-card-copy">
        <div className="queue-card-head">
          <div>
            <strong>{normalizeString(task.titleName, "Untitled")}</strong>
            <span>
              {normalizeString(task.libraryTypeLabel, normalizeString(task.requestType, "Manga"))}
              {" / "}
              {normalizeString(selectedDownload.providerName, normalizeString(task.providerId, "download"))}
            </span>
          </div>
          <div className="queue-badges">
            <Badge tone={status.toLowerCase()}>{status}</Badge>
            {normalizeString(task.attentionReason) ? <Badge tone="warning">{task.attentionReason}</Badge> : null}
          </div>
        </div>
        <div className="queue-progress" aria-label={`Progress ${formatPercent(task.percent)}`}>
          <span style={{width: formatPercent(task.percent)}} />
        </div>
        <div className="queue-meta">
          {metaItems.map((item) => <span key={item}>{item}</span>)}
        </div>
        <p>{normalizeString(task.message, "Queued for Raven.")}</p>
        {normalizeString(selectedDownload.titleUrl, normalizeString(task.titleUrl)) ? (
          <p className="queue-source">{normalizeString(selectedDownload.titleUrl, normalizeString(task.titleUrl))}</p>
        ) : null}
        <div className="admin-action-row">
          {normalizeString(task.titleId) ? <a className="admin-button ghost small" href={`/admin/library/${encodeURIComponent(normalizeString(task.libraryTypeSlug, normalizeString(task.requestType, "manga")))}/${encodeURIComponent(normalizeString(task.titleId))}`}>Open title</a> : null}
          {normalizeString(task.requestId) ? <a className="admin-button ghost small" href="/admin/requests">Open request</a> : null}
        </div>
        <QueueControls task={task} permissions={permissions} onAction={onAction} onDirtyChange={onDirtyChange} />
      </div>
    </article>
  );
};

/**
 * Render a named queue section.
 *
 * @param {{
 *   title: string,
 *   kicker: string,
 *   tasks: Array<Record<string, any>>,
 *   empty: string,
 *   permissions: {canWrite: boolean, canRoot: boolean},
 *   onAction: (action: string, task: Record<string, any>, body?: any) => Promise<void>,
 *   onDirtyChange: (dirty: boolean) => void,
 *   retryAll?: boolean,
 *   removeAll?: boolean,
 *   cancelAll?: boolean,
 *   cancelAllLabel?: string,
 *   onRetryAll?: () => Promise<void>,
 *   onRemoveAll?: () => Promise<void>,
 *   onCancelAll?: () => Promise<void>
 * }} props
 * @returns {import("react").ReactNode}
 */
const QueueSection = ({
  title,
  kicker,
  tasks,
  empty,
  permissions,
  onAction,
  onDirtyChange,
  retryAll = false,
  removeAll = false,
  cancelAll = false,
  cancelAllLabel = "Cancel all",
  onRetryAll,
  onRemoveAll,
  onCancelAll
}) => (
  <section className="admin-panel">
    <div className="admin-section-heading">
      <div>
        <div className="admin-kicker">{kicker}</div>
        <h2>{title}</h2>
      </div>
      <div className="admin-action-row">
        {cancelAll && permissions.canWrite && tasks.length ? <button className="admin-button ghost small" type="button" onClick={onCancelAll}>{cancelAllLabel}</button> : null}
        {retryAll && permissions.canWrite && tasks.length ? <button className="admin-button ghost small" type="button" onClick={onRetryAll}>Retry all</button> : null}
        {removeAll && permissions.canWrite && tasks.length ? <button className="admin-button ghost small" type="button" onClick={onRemoveAll}>Remove all removable</button> : null}
        <span className="admin-muted">{tasks.length} task{tasks.length === 1 ? "" : "s"}</span>
      </div>
    </div>
    {tasks.length ? (
      <div className="queue-grid">
        {tasks.map((task) => (
          <QueueTaskCard
            key={normalizeString(task.taskId, `${task.titleName}-${task.queuedAt}`)}
            task={task}
            permissions={permissions}
            onAction={onAction}
            onDirtyChange={onDirtyChange}
          />
        ))}
      </div>
    ) : (
      <div className="admin-empty">{empty}</div>
    )}
  </section>
);

/**
 * Render the live Raven queue board.
 *
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const QueuePage = ({user}) => {
  const {loading, refreshing, error, data, refresh} = useAdminJson("/api/moon/v3/admin/activity/queue", {
    fallback: {
      stats: {},
      running: [],
      queued: [],
      needsAttention: []
    }
  });
  const [flash, setFlash] = useState(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const {notify} = useAdminToast();
  const live = useAdminEventStaleness({
    domains: ["activity"],
    enabled: true,
    locked: editorDirty,
    onStale: () => {},
    onRefresh: refresh
  });
  const permissions = {
    canWrite: hasAdminGrant(user, "activity", "write"),
    canRoot: hasAdminGrant(user, "activity", "root")
  };
  const payload = data || {};
  const stats = payload.stats || {};

  const handleAction = async (action, task, body) => {
    const taskId = encodeURIComponent(normalizeString(task.taskId));
    const endpoints = {
      retry: [`/api/moon/v3/admin/activity/queue/${taskId}/retry`, undefined],
      remove: [`/api/moon/v3/admin/activity/queue/${taskId}/remove`, undefined],
      cancel: [`/api/moon/v3/admin/activity/queue/${taskId}/cancel`, undefined],
      "move-up": [`/api/moon/v3/admin/activity/queue/${taskId}/move`, {direction: "up"}],
      "move-down": [`/api/moon/v3/admin/activity/queue/${taskId}/move`, {direction: "down"}],
      priority: [`/api/moon/v3/admin/activity/queue/${taskId}/priority`, body]
    };
    const [url, json] = endpoints[action] || [];
    if (!url) {
      return;
    }
    const result = await requestJson(url, {method: "POST", json});
    setEditorDirty(false);
    setFlash({
      tone: result.ok ? "good" : "bad",
      text: result.ok ? "Queue action saved." : result.payload?.error || "Moon could not update that queue task."
    });
    notify({
      message: result.ok ? "Queue action saved." : result.payload?.error || "Moon could not update that queue task.",
      tone: result.ok ? "good" : "bad",
      category: "job"
    });
    await refresh();
  };

  const handleRetryAll = async () => {
    const result = await requestJson("/api/moon/v3/admin/activity/queue/retry-all", {method: "POST"});
    setFlash({
      tone: result.ok ? "good" : "bad",
      text: result.ok ? result.payload?.message || "Queued Raven retries." : result.payload?.error || "Unable to retry recovery tasks."
    });
    notify({
      message: result.ok ? result.payload?.message || "Queued Raven retries." : result.payload?.error || "Unable to retry recovery tasks.",
      tone: result.ok ? "good" : "bad",
      category: "job"
    });
    await refresh();
  };

  const handleBulkQueueAction = async (url, successFallback, failureFallback, confirmMessage) => {
    if (confirmMessage && typeof window !== "undefined" && !window.confirm(confirmMessage)) {
      return;
    }
    const result = await requestJson(url, {method: "POST"});
    const message = result.ok
      ? result.payload?.message || successFallback
      : result.payload?.error || failureFallback;
    setFlash({
      tone: result.ok ? "good" : "bad",
      text: message
    });
    notify({
      message,
      tone: result.ok ? "good" : "bad",
      category: "job"
    });
    await refresh();
  };

  const handleRemoveAll = () => handleBulkQueueAction(
    "/api/moon/v3/admin/activity/queue/remove-all",
    "Removed Raven recovery tasks.",
    "Unable to remove recovery tasks.",
    "Remove all removable Raven recovery tasks?"
  );

  const handleCancelQueued = () => handleBulkQueueAction(
    "/api/moon/v3/admin/activity/queue/cancel-queued",
    "Cancelled queued Raven tasks.",
    "Unable to cancel queued tasks.",
    "Cancel all queued Raven tasks?"
  );

  const handleCancelRunning = () => handleBulkQueueAction(
    "/api/moon/v3/admin/activity/queue/cancel-running",
    "Cancelled running Raven tasks.",
    "Unable to cancel running tasks.",
    "Cancel all running Raven tasks?"
  );

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">Activity</div>
        <h2>Loading queue</h2>
        <p>Moon is reading Raven task state through the same-origin admin API.</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="admin-panel admin-state-panel is-danger">
        <div className="admin-kicker">Activity</div>
        <h2>Queue unavailable</h2>
        <p>{error}</p>
      </section>
    );
  }

  return (
    <div className="queue-page">
      {flash ? <div className={`admin-flash ${flash.tone}`}>{flash.text}</div> : null}
      {live.stale && editorDirty ? (
        <div className="admin-refresh-prompt">
          Queue changed while you were editing priority. Finish the edit, then refresh when ready.
          <button
            className="admin-button solid small"
            type="button"
            onClick={() => {
              setEditorDirty(false);
              live.clearStale();
              void refresh();
            }}
          >
            Refresh
          </button>
        </div>
      ) : null}
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Activity</div>
            <h2>Live Raven queue</h2>
          </div>
          <Badge tone={live.state === "live" ? "running" : "warning"}>
            {refreshing ? "Refreshing quietly" : live.state === "live" ? "Live updates connected" : "Live updates degraded"}
          </Badge>
        </div>
        <div className="admin-metric-grid">
          <MetricCard label="Running" value={stats.runningCount ?? 0} />
          <MetricCard label="Queued" value={stats.queuedCount ?? 0} />
          <MetricCard label="Needs attention" value={stats.needsAttentionCount ?? 0} />
          <MetricCard label="Active slots" value={`${stats.activeSlots ?? 0}/${stats.totalSlots ?? 0}`} />
        </div>
      </section>
      <QueueSection
        title="Running"
        kicker="Live work"
        tasks={normalizeArray(payload.running)}
        empty="Raven is idle right now."
        permissions={{...permissions, canWrite: permissions.canRoot}}
        onAction={handleAction}
        onDirtyChange={setEditorDirty}
        cancelAll
        cancelAllLabel="Cancel all"
        onCancelAll={handleCancelRunning}
      />
      <QueueSection
        title="Queued"
        kicker="Up next"
        tasks={normalizeArray(payload.queued)}
        empty="No queued Raven downloads are waiting."
        permissions={permissions}
        onAction={handleAction}
        onDirtyChange={setEditorDirty}
        cancelAll
        cancelAllLabel="Cancel all queued"
        onCancelAll={handleCancelQueued}
      />
      <QueueSection
        title="Needs attention"
        kicker="Recovery"
        tasks={normalizeArray(payload.needsAttention)}
        empty="Failed and stale tasks will land here when they need an admin touch."
        permissions={permissions}
        onAction={handleAction}
        onDirtyChange={setEditorDirty}
        retryAll
        removeAll
        onRetryAll={handleRetryAll}
        onRemoveAll={handleRemoveAll}
      />
    </div>
  );
};

export default QueuePage;
