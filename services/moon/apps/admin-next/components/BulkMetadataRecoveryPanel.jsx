"use client";

/** @file Owner-only rechecking of saved metadata skips without starting a bulk run. */
import {useRef, useState} from "react";
import {requestJson} from "../lib/api.js";

/**
 * Inspect a captured paused run and recheck its terminal metadata skips exactly once.
 * @returns {import("react").ReactNode} Bulk metadata recovery controls.
 */
export const BulkMetadataRecoveryPanel = () => {
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const requestId = useRef("");
  const inspectedApproval = useRef("");
  const inspect = async () => {
    setBusy(true);
    const result = await requestJson(`/api/moon/v3/admin/activity/bulk-runs/${encodeURIComponent(runId.trim())}`);
    if (result.ok && result.payload.approvalId !== inspectedApproval.current) {
      requestId.current = "";
      inspectedApproval.current = result.payload.approvalId || "";
    }
    setRun(result.ok ? result.payload : null);
    setMessage(result.ok ? `Run ${result.payload.status}. Metadata skips: ${(result.payload.counts?.skippedNoMetadataCount || 0) + (result.payload.counts?.skippedAmbiguousMetadataCount || 0)}.` : result.payload?.error || "Run inspection failed.");
    setBusy(false);
  };
  const recheck = async () => {
    requestId.current ||= run.metadataRecheckPending?.requestId || crypto.randomUUID();
    setBusy(true);
    const result = await requestJson(`/api/moon/v3/admin/activity/bulk-runs/${encodeURIComponent(runId.trim())}/recheck-metadata`, {method: "POST", json: {approvalId: run.approvalId, requestId: requestId.current}});
    setMessage(result.ok ? `${result.payload.recheckedPlanIds?.length || 0} metadata plans prepared for rechecking. Continue the existing run through Noona.` : result.payload?.error || "Recheck failed. Retry preserves the same request identity.");
    setBusy(false);
  };
  return <section className="admin-panel">
    <h2>Bulk metadata recovery</h2>
    <p className="admin-muted">Recheck metadata skips in an existing paused run. Accepted downloads and completed files stay intact. Continue through Noona after repair.</p>
    <div className="admin-task-form">
      <label><span>Run ID from Noona</span><input value={runId} disabled={busy} onChange={(event) => {setRunId(event.target.value); setRun(null); requestId.current = "";}} /></label>
      <button className="admin-button ghost" disabled={busy || !runId.trim()} onClick={() => void inspect()}>Inspect run</button>
      <button className="admin-button solid" disabled={busy || run?.status !== "paused"} onClick={() => void recheck()}>Recheck metadata skips</button>
    </div>
    {message ? <p role="status">{message}</p> : null}
  </section>;
};
