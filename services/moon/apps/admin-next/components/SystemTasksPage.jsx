"use client";

/**
 * @file Purpose-built Radarr-style maintenance task scheduler.
 */

import {useEffect, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {formatDate, normalizeString} from "../lib/format.js";
import {AdminActionBanner, AdminDenseTable, AdminStatusBadge} from "./AdminUi.jsx";
import {useAdminToast} from "./AdminToasts.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const runTone = (status) => {
  const normalized = normalizeString(status).toLowerCase();
  if (normalized === "completed") {
    return "good";
  }
  if (normalized === "failed") {
    return "bad";
  }
  if (normalized === "running") {
    return "running";
  }
  return "queued";
};

/**
 * @param {{task: any, user: any, draft: any, onDraft: (taskId: string, patch: Record<string, unknown>) => void, onRun: Function, onSave: Function, onPreview: Function}} props
 * @returns {import("react").ReactNode}
 */
const TaskCard = ({task, user, draft, onDraft, onRun, onSave, onPreview}) => {
  const canMutate = hasAdminGrant(user, "system", "root");
  const lastRun = task.lastRun || {};
  const recentRuns = normalizeArray(task.recentRuns);
  return (
    <article className="admin-task-card">
      <div className="admin-record-head">
        <div>
          <h3>{task.label}</h3>
          <p className="admin-muted">{task.description}</p>
        </div>
        <AdminStatusBadge tone={task.running ? "running" : draft.enabled ? "good" : "queued"}>
          {task.running ? "running" : draft.enabled ? "enabled" : "disabled"}
        </AdminStatusBadge>
      </div>
      <div className="admin-task-form">
        <label>
          <span>Enabled</span>
          <select
            disabled={!canMutate}
            value={draft.enabled ? "true" : "false"}
            onChange={(event) => onDraft(task.taskId, {enabled: event.target.value === "true"})}
          >
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </label>
        <label>
          <span>Cron</span>
          <input
            disabled={!canMutate}
            value={draft.cronExpression}
            onChange={(event) => onDraft(task.taskId, {cronExpression: event.target.value})}
            placeholder="*/15 * * * *"
          />
        </label>
        <label>
          <span>Timezone</span>
          <input
            disabled={!canMutate}
            value={draft.timezone}
            onChange={(event) => onDraft(task.taskId, {timezone: event.target.value})}
            placeholder="America/Los_Angeles"
          />
        </label>
      </div>
      {!task.valid ? <AdminActionBanner tone="bad">{task.error}</AdminActionBanner> : null}
      <div className="admin-detail-grid">
        <span><strong>Next run</strong>{normalizeArray(task.nextRuns)[0] ? formatDate(task.nextRuns[0]) : "No preview"}</span>
        <span><strong>Last run</strong>{lastRun.status ? `${lastRun.status} · ${formatDate(lastRun.updatedAt || lastRun.createdAt)}` : "Never"}</span>
        <span><strong>Last message</strong>{lastRun.message || "No run history yet."}</span>
        <span><strong>Task id</strong><code>{task.taskId}</code></span>
      </div>
      <div className="admin-action-row">
        <button className="admin-button solid" type="button" disabled={!canMutate || task.running} onClick={() => onRun(task.taskId)}>
          Run now
        </button>
        <button className="admin-button ghost" type="button" disabled={!canMutate} onClick={() => onPreview(task.taskId)}>
          Preview
        </button>
        <button className="admin-button ghost" type="button" disabled={!canMutate} onClick={() => onSave(task.taskId)}>
          Save schedule
        </button>
      </div>
      <AdminDenseTable
        columns={[
          {key: "status", label: "Recent", className: "is-tight", render: (row) => <AdminStatusBadge tone={runTone(row.status)}>{row.status}</AdminStatusBadge>},
          {key: "message", label: "Message", render: (row) => row.message || row.label || "Task run"},
          {key: "updatedAt", label: "Updated", className: "is-nowrap", render: (row) => formatDate(row.updatedAt || row.createdAt)}
        ]}
        rows={recentRuns.slice(0, 4)}
        empty="No recent runs for this task."
        getKey={(row, index) => normalizeString(row.jobId, `${task.taskId}-${index}`)}
      />
    </article>
  );
};

/**
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const SystemTasksPage = ({user}) => {
  const canMutate = hasAdminGrant(user, "system", "root");
  const [drafts, setDrafts] = useState({});
  const [flash, setFlash] = useState("");
  const [flashTone, setFlashTone] = useState("");
  const {notify} = useAdminToast();
  const {loading, refreshing, error, data, refresh} = useAdminJson("/api/moon/v3/admin/system/tasks", {
    fallback: {
      tasks: []
    }
  });
  const tasks = normalizeArray(data?.tasks);
  const live = useAdminEventStaleness({
    domains: ["system"],
    enabled: true,
    locked: Object.keys(drafts).some((taskId) => drafts[taskId]?.dirty),
    onStale: () => {},
    onRefresh: refresh
  });

  useEffect(() => {
    setDrafts((current) => {
      const next = {...current};
      for (const task of tasks) {
        if (!next[task.taskId] || !next[task.taskId].dirty) {
          next[task.taskId] = {
            enabled: Boolean(task.enabled),
            cronExpression: normalizeString(task.cronExpression),
            timezone: normalizeString(task.timezone),
            dirty: false
          };
        }
      }
      return next;
    });
  }, [tasks]);

  const patchDraft = (taskId, patch) => {
    setDrafts((current) => ({
      ...current,
      [taskId]: {
        ...(current[taskId] || {}),
        ...patch,
        dirty: true
      }
    }));
  };

  const runTaskAction = async (taskId, action) => {
    setFlash("");
    const draft = drafts[taskId] || {};
    const url = action === "run"
      ? `/api/moon/v3/admin/system/tasks/${encodeURIComponent(taskId)}/run`
      : action === "preview"
        ? `/api/moon/v3/admin/system/tasks/${encodeURIComponent(taskId)}/preview`
        : `/api/moon/v3/admin/system/tasks/${encodeURIComponent(taskId)}`;
    const result = await requestJson(url, {
      method: action === "save" ? "PATCH" : "POST",
      json: {
        enabled: Boolean(draft.enabled),
        cronExpression: draft.cronExpression,
        timezone: draft.timezone
      }
    });
    if (!result.ok) {
      setFlash(result.payload?.error || "Moon could not complete that task action.");
      setFlashTone("bad");
      notify({message: result.payload?.error || "Moon could not complete that task action.", tone: "bad", category: "job"});
      return;
    }
    if (action === "preview") {
      setFlash(`Next runs: ${normalizeArray(result.payload?.nextRuns).slice(0, 3).map(formatDate).join(", ") || "none"}`);
      setFlashTone("good");
      notify({message: "Task preview generated.", tone: "good", category: "action"});
      return;
    }
    if (action === "save") {
      setDrafts((current) => ({
        ...current,
        [taskId]: {
          ...(current[taskId] || {}),
          dirty: false
        }
      }));
    }
    setFlash(action === "run" ? "Task run accepted." : "Schedule saved.");
    setFlashTone("good");
    notify({message: action === "run" ? "Task run accepted." : "Schedule saved.", tone: "good", category: action === "run" ? "job" : "action"});
    void refresh();
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">System</div>
        <h2>Loading tasks</h2>
        <p>Moon is reading Sage scheduler definitions.</p>
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
            <div className="admin-kicker">System</div>
            <h2>Tasks</h2>
            <p className="admin-muted">Cron schedules for Scriptarr-defined maintenance jobs. No arbitrary shell commands here, just the safe levers.</p>
          </div>
          <AdminStatusBadge tone={live.state === "live" ? "running" : "warning"}>
            {refreshing ? "Refreshing quietly" : live.state === "live" ? "Live" : "Degraded"}
          </AdminStatusBadge>
        </div>
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Total</span><strong>{tasks.length}</strong></article>
          <article className="admin-metric-card"><span>Enabled</span><strong>{tasks.filter((task) => task.enabled).length}</strong></article>
          <article className="admin-metric-card"><span>Running</span><strong>{tasks.filter((task) => task.running).length}</strong></article>
          <article className="admin-metric-card"><span>Timezone</span><strong>{data?.timezone || "server"}</strong></article>
        </div>
        {!canMutate ? <p className="admin-muted">Viewing is allowed with system.read. Schedule edits and manual runs require system.root.</p> : null}
      </section>
      <section className="admin-task-grid">
        {tasks.map((task) => (
          <TaskCard
            draft={drafts[task.taskId] || task}
            key={task.taskId}
            task={task}
            user={user}
            onDraft={patchDraft}
            onRun={(taskId) => runTaskAction(taskId, "run")}
            onSave={(taskId) => runTaskAction(taskId, "save")}
            onPreview={(taskId) => runTaskAction(taskId, "preview")}
          />
        ))}
      </section>
    </>
  );
};

export default SystemTasksPage;
