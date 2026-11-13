"use client";

/** @file Selected chapter repair controls on the existing Missing Content surface. */
import {useRef, useState} from "react";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {repairRequest, selectableRepairChapters} from "../lib/chapterRepair.js";
import {AdminActionBanner, AdminStatusBadge} from "./AdminUi.jsx";

const emptyTasks = Object.freeze({tasks: []});

/**
 * Queue a frozen selection while keeping the current reader version until publication succeeds.
 * @param {{title: any, canRead: boolean, canRepair: boolean}} props
 * @returns {import("react").ReactNode}
 */
export const ChapterRepairPanel = ({title, canRead, canRepair}) => {
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const receipt = useRef(null);
  const path = `/api/moon/v3/admin/library/${encodeURIComponent(title.id)}/repair-chapters`;
  const {data, error, refresh} = useAdminJson(path, {enabled: canRead, fallback: emptyTasks});
  useAdminEventStaleness({domains: ["wanted", "library", "activity"], enabled: canRead, locked: busy,
    onStale: () => {}, onRefresh: refresh});
  const chapters = selectableRepairChapters(title.damagedChapters);
  const queue = async () => {
    setBusy(true);
    try {
      receipt.current = repairRequest(receipt.current, title.id, selected);
      const result = await requestJson(path, {method: "POST", json: receipt.current.body});
      setMessage({tone: result.ok ? "good" : "bad", text: result.ok
        ? `Selected chapter repair accepted. Task ${result.payload.taskId}.`
        : result.payload?.error || "Repair could not be queued. Retry keeps the same request identity."});
      if (result.ok) await refresh();
    } catch {
      setMessage({tone: "bad", text: "Repair acknowledgement was interrupted. Retry uses the same request identity."});
    } finally { setBusy(false); }
  };
  return <section className="admin-subsection">
    <div className="admin-kicker">Repair</div>
    <h3>Selected chapters</h3>
    <p className="admin-muted">Retry up to 50 damaged chapters from their saved source. Existing readable pages stay published until a complete repair is verified.</p>
    {message ? <AdminActionBanner tone={message.tone}>{message.text}</AdminActionBanner> : null}
    {error ? <AdminActionBanner tone="bad">{error}</AdminActionBanner> : null}
    <div className="admin-log-list compact">
      {chapters.map(chapter => <label className="admin-log-row" key={chapter.id}>
        <input type="checkbox" checked={selected.includes(chapter.id)} disabled={!canRepair || busy || (!selected.includes(chapter.id) && selected.length >= 50)}
          onChange={event => setSelected(current => event.target.checked ? [...current, chapter.id] : current.filter(id => id !== chapter.id))} />
        <strong>{chapter.label || `Chapter ${chapter.chapterNumber}`}</strong>
        <span>{chapter.qualityStatus || "missing content"} · {chapter.missingPageCount || 0} known missing pages</span>
      </label>)}
    </div>
    {!chapters.length ? <p className="admin-muted">No damaged chapters with verified source identities are available for selected repair.</p> : null}
    <button className="admin-button solid" type="button" disabled={!canRepair || busy || !selected.length} onClick={() => void queue()}>
      {busy ? "Queueing repair..." : `Repair ${selected.length} selected chapter${selected.length === 1 ? "" : "s"}`}
    </button>
    <a className="admin-button ghost" href="/admin/activity/queue">Open queue and retry controls</a>
    {(data?.tasks || []).map(task => <article className="admin-log-row" key={task.taskId}>
      <AdminStatusBadge tone={task.status === "completed" ? "good" : task.status === "failed" ? "bad" : "warning"}>{task.status}</AdminStatusBadge>
      <strong>Chapters {(task.chapterNumbers || []).join(", ")}</strong>
      <span>{task.percent || 0}% · {task.message}</span>
      {(task.problems || []).map((problem, index) => <p key={`${problem.chapterNumber}:${index}`}>{problem.message}</p>)}
    </article>)}
  </section>;
};
