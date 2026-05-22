"use client";

/**
 * @file Purpose-built admin system logs page.
 */

import {useDeferredValue, useEffect, useMemo, useState} from "react";
import {useAdminJson} from "../lib/api.js";
import {formatDate, normalizeString} from "../lib/format.js";
import {AdminActionBanner, AdminDenseTable, AdminFilterBar, AdminStatusBadge} from "./AdminUi.jsx";

const LEVELS = ["all", "debug", "info", "warn", "error"];
const TAIL_COUNTS = [100, 250, 500, 1000];

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const logLevelTone = (level) => {
  const normalized = normalizeString(level).toLowerCase();
  if (normalized === "error") {
    return "bad";
  }
  if (normalized === "warn") {
    return "warning";
  }
  if (normalized === "debug") {
    return "queued";
  }
  return "good";
};

/**
 * @returns {import("react").ReactNode}
 */
export const SystemLogsPage = () => {
  const [service, setService] = useState("");
  const [level, setLevel] = useState("all");
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState(250);
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const deferredQuery = useDeferredValue(query);

  const endpoint = useMemo(() => {
    const params = new URLSearchParams();
    if (service) {
      params.set("service", service);
    }
    params.set("level", level);
    params.set("lines", String(lines));
    if (deferredQuery.trim()) {
      params.set("q", deferredQuery.trim());
    }
    return `/api/moon/v3/admin/system/logs?${params.toString()}`;
  }, [deferredQuery, level, lines, service]);

  const {loading, refreshing, error, data, refresh} = useAdminJson(endpoint, {
    fallback: {
      services: [],
      entries: []
    }
  });

  const services = normalizeArray(data?.services);
  const entries = normalizeArray(data?.entries);

  useEffect(() => {
    if (paused) {
      return undefined;
    }
    let cancelled = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await refresh();
        if (!cancelled) {
          schedule();
        }
      }, 5000);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [paused, refresh]);

  const copyVisibleLines = async () => {
    const text = entries
      .map((entry) => `${entry.timestamp || ""} ${entry.level || "info"} ${entry.message || ""}`.trim())
      .join("\n");
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">System</div>
        <h2>Loading logs</h2>
        <p>Moon is asking Warden for a redacted Docker log tail.</p>
      </section>
    );
  }

  return (
    <>
      {error ? <AdminActionBanner tone="bad">{error}</AdminActionBanner> : null}
      {copied ? <AdminActionBanner tone="good">Visible log lines copied.</AdminActionBanner> : null}
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">System</div>
            <h2>Logs</h2>
            <p className="admin-muted">Server-redacted Docker logs from managed Scriptarr services.</p>
          </div>
          <AdminStatusBadge tone={paused ? "warning" : "running"}>
            {paused ? "Paused" : refreshing ? "Refreshing" : "Auto tailing"}
          </AdminStatusBadge>
        </div>
        <AdminFilterBar>
          <label>
            <span>Service</span>
            <select value={service || normalizeString(data?.selectedService)} onChange={(event) => setService(event.target.value)}>
              {services.map((option) => (
                <option key={option.name} value={option.name}>{option.label || option.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Level</span>
            <select value={level} onChange={(event) => setLevel(event.target.value)}>
              {LEVELS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label>
            <span>Lines</span>
            <select value={String(lines)} onChange={(event) => setLines(Number(event.target.value))}>
              {TAIL_COUNTS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="admin-filter-grow">
            <span>Search</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter visible log text" />
          </label>
          <button className="admin-button ghost" type="button" onClick={() => setPaused((value) => !value)}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button className="admin-button ghost" type="button" onClick={() => void refresh()}>Refresh</button>
          <button className="admin-button ghost" type="button" onClick={copyVisibleLines} disabled={!entries.length}>Copy visible</button>
        </AdminFilterBar>
        <div className="admin-log-meta">
          <span>Container: {normalizeString(data?.selectedContainer, "unknown")}</span>
          <span>Generated: {formatDate(data?.generatedAt)}</span>
          <span>{data?.redacted ? "Secrets redacted by Warden" : "Redaction status unknown"}</span>
          <span>{entries.length} line{entries.length === 1 ? "" : "s"}</span>
        </div>
      </section>
      <section className="admin-panel">
        <AdminDenseTable
          columns={[
            {key: "time", label: "Time", className: "is-nowrap", render: (row) => row.timestamp ? formatDate(row.timestamp) : "No timestamp"},
            {key: "level", label: "Level", className: "is-tight", render: (row) => <AdminStatusBadge tone={logLevelTone(row.level)}>{row.level || "info"}</AdminStatusBadge>},
            {key: "message", label: "Message", render: (row) => <code className="admin-log-line">{row.message}</code>}
          ]}
          rows={entries}
          empty="No log lines match the current filters."
          getKey={(row, index) => normalizeString(row.id, `log-${index}`)}
        />
      </section>
    </>
  );
};

export default SystemLogsPage;
