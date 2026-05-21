"use client";

/**
 * @file Purpose-built durable event explorer for Moon admin.
 */

import {useDeferredValue, useMemo, useState} from "react";
import {useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {formatDate, normalizeString} from "../lib/format.js";
import {AdminActionBanner, AdminDenseTable, AdminDrawer, AdminFilterBar, AdminStatusBadge} from "./AdminUi.jsx";

const COMMON_DOMAINS = ["", "auth", "users", "access", "requests", "library", "reader", "activity", "system", "settings", "discord", "ai"];
const SEVERITIES = ["", "info", "warning", "warn", "error"];
const LIMITS = [50, 100, 250, 500];

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeNumber = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const formatMs = (value) => {
  const normalized = normalizeNumber(value, 0);
  return normalized > 0 ? `${normalized} ms` : "n/a";
};

const formatPage = (value) => {
  const normalized = normalizeNumber(value, -1);
  return normalized >= 0 ? `p${normalized + 1}` : "chapter";
};

const severityTone = (severity) => {
  const normalized = normalizeString(severity).toLowerCase();
  if (normalized === "error" || normalized === "critical") {
    return "bad";
  }
  if (normalized === "warning" || normalized === "warn") {
    return "warning";
  }
  return "good";
};

/**
 * @returns {import("react").ReactNode}
 */
export const SystemEventsPage = () => {
  const [domain, setDomain] = useState("");
  const [severity, setSeverity] = useState("");
  const [eventType, setEventType] = useState("");
  const [actor, setActor] = useState("");
  const [target, setTarget] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(100);
  const [selectedEventId, setSelectedEventId] = useState("");
  const deferredQuery = useDeferredValue(query);
  const deferredActor = useDeferredValue(actor);
  const deferredTarget = useDeferredValue(target);
  const deferredEventType = useDeferredValue(eventType);

  const endpoint = useMemo(() => {
    const params = new URLSearchParams();
    if (domain) {
      params.set("domain", domain);
    }
    if (severity) {
      params.set("severity", severity);
    }
    if (deferredEventType.trim()) {
      params.set("eventType", deferredEventType.trim());
    }
    if (deferredActor.trim()) {
      params.set("actorId", deferredActor.trim());
    }
    if (deferredTarget.trim()) {
      params.set("targetId", deferredTarget.trim());
    }
    if (deferredQuery.trim()) {
      params.set("q", deferredQuery.trim());
    }
    params.set("limit", String(limit));
    return `/api/moon/v3/admin/system/events?${params.toString()}`;
  }, [deferredActor, deferredEventType, deferredQuery, deferredTarget, domain, limit, severity]);

  const {loading, refreshing, error, data, refresh} = useAdminJson(endpoint, {
    fallback: {
      events: []
    }
  });
  const {
    loading: readerReportLoading,
    refreshing: readerReportRefreshing,
    error: readerReportError,
    data: readerReport,
    refresh: refreshReaderReport
  } = useAdminJson("/api/moon/v3/admin/system/reader-telemetry?hours=24&limit=500", {
    fallback: {
      summary: {},
      caughtBuffer: {topTargets: []},
      slowEvents: {topTargets: [], byType: []},
      retries: {spikes: [], topTargets: []},
      recommendations: []
    }
  });
  const events = normalizeArray(data?.events);
  const selectedEvent = events.find((event) => normalizeString(event.eventId) === selectedEventId) || null;
  const readerSummary = readerReport?.summary || {};
  const readerHotspots = useMemo(() => {
    const retryRows = normalizeArray(readerReport?.retries?.spikes).length
      ? normalizeArray(readerReport?.retries?.spikes)
      : normalizeArray(readerReport?.retries?.topTargets);
    return [
      ...normalizeArray(readerReport?.caughtBuffer?.topTargets).map((row) => ({...row, signal: "Caught buffer"})),
      ...normalizeArray(readerReport?.slowEvents?.topTargets).map((row) => ({...row, signal: "Slow load/decode"})),
      ...retryRows.map((row) => ({...row, signal: "Retry spike"}))
    ].slice(0, 10);
  }, [readerReport]);
  const live = useAdminEventStaleness({
    domains: domain ? [domain] : [],
    enabled: true,
    onStale: () => {},
    onRefresh: () => {
      void refresh();
      void refreshReaderReport();
    }
  });

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">System</div>
        <h2>Loading events</h2>
        <p>Moon is reading the durable Vault event log.</p>
      </section>
    );
  }

  return (
    <>
      {error ? (
        <section className="admin-panel admin-state-panel is-danger">
          <div className="admin-kicker">Events</div>
          <h2>Event explorer unavailable</h2>
          <p>{error}</p>
        </section>
      ) : null}
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">System</div>
            <h2>Events</h2>
            <p className="admin-muted">Search and inspect immutable Scriptarr activity from Vault.</p>
          </div>
          <AdminStatusBadge tone={live.state === "live" ? "running" : "warning"}>
            {refreshing ? "Refreshing quietly" : live.state === "live" ? "Live" : "Degraded"}
          </AdminStatusBadge>
        </div>
        <AdminFilterBar>
          <label>
            <span>Domain</span>
            <select value={domain} onChange={(event) => setDomain(event.target.value)}>
              {COMMON_DOMAINS.map((option) => (
                <option key={option || "all"} value={option}>{option || "all"}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Severity</span>
            <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
              {SEVERITIES.map((option) => (
                <option key={option || "all"} value={option}>{option || "all"}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Type</span>
            <input value={eventType} onChange={(event) => setEventType(event.target.value)} placeholder="event type" />
          </label>
          <label>
            <span>Actor</span>
            <input value={actor} onChange={(event) => setActor(event.target.value)} placeholder="actor id" />
          </label>
          <label>
            <span>Target</span>
            <input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="target id" />
          </label>
          <label className="admin-filter-grow">
            <span>Search</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="message, domain, actor, target" />
          </label>
          <label>
            <span>Limit</span>
            <select value={String(limit)} onChange={(event) => setLimit(Number(event.target.value))}>
              {LIMITS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <button className="admin-button ghost" type="button" onClick={() => void refresh()}>Refresh</button>
        </AdminFilterBar>
      </section>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Reader</div>
            <h2>Telemetry report</h2>
            <p className="admin-muted">Redacted 24 hour view of caught-buffer waits, slow reader loads, and retry clusters.</p>
          </div>
          <AdminStatusBadge tone={readerReportError ? "bad" : readerReportRefreshing ? "queued" : "good"}>
            {readerReportLoading ? "Loading" : readerReportRefreshing ? "Refreshing" : readerReportError ? "Unavailable" : "Ready"}
          </AdminStatusBadge>
        </div>
        {readerReportError ? <AdminActionBanner tone="warning">{readerReportError}</AdminActionBanner> : null}
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Caught buffer</span><strong>{readerSummary.caughtBufferWaits || 0}</strong></article>
          <article className="admin-metric-card"><span>Slow events</span><strong>{readerSummary.slowEvents || 0}</strong></article>
          <article className="admin-metric-card"><span>Retry attempts</span><strong>{readerSummary.retryAttempts || 0}</strong></article>
          <article className="admin-metric-card"><span>Targets</span><strong>{readerSummary.problemTargets || 0}</strong></article>
        </div>
        <AdminDenseTable
          columns={[
            {key: "signal", label: "Signal", className: "is-tight"},
            {key: "targetId", label: "Target", render: (row) => normalizeString(row.targetId, "unknown")},
            {key: "pageIndex", label: "Page", className: "is-tight", render: (row) => formatPage(row.pageIndex)},
            {key: "count", label: "Events", className: "is-tight"},
            {key: "p95DurationMs", label: "P95", className: "is-tight", render: (row) => formatMs(row.p95DurationMs)},
            {key: "maxDurationMs", label: "Max", className: "is-tight", render: (row) => formatMs(row.maxDurationMs)},
            {key: "retryAttempts", label: "Retries", className: "is-tight", render: (row) => row.retryAttempts || 0},
            {key: "reasons", label: "Reason", render: (row) => normalizeArray(row.reasons).join(", ") || normalizeArray(row.eventTypes).join(", ") || "n/a"}
          ]}
          rows={readerHotspots}
          empty="No caught-buffer, slow, or retry reader clusters in the selected window."
          getKey={(row, index) => `${row.signal}-${row.targetId || "unknown"}-${row.pageIndex ?? "chapter"}-${index}`}
        />
        <div className="admin-drawer-stack">
          {normalizeArray(readerReport?.recommendations).map((item) => (
            <AdminActionBanner key={normalizeString(item.id, item.title)} tone={item.severity === "warning" ? "warning" : ""}>
              <strong>{item.title}</strong> {item.action}
            </AdminActionBanner>
          ))}
        </div>
      </section>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Durable log</div>
            <h2>{events.length} event{events.length === 1 ? "" : "s"}</h2>
          </div>
        </div>
        <AdminDenseTable
          columns={[
            {key: "createdAt", label: "Time", className: "is-nowrap", render: (row) => formatDate(row.createdAt)},
            {key: "severity", label: "Severity", className: "is-tight", render: (row) => <AdminStatusBadge tone={severityTone(row.severity)}>{row.severity || "info"}</AdminStatusBadge>},
            {key: "domain", label: "Domain", className: "is-tight"},
            {key: "eventType", label: "Type"},
            {key: "actor", label: "Actor", render: (row) => normalizeString(row.actorLabel, normalizeString(row.actorId, row.actorType || "system"))},
            {key: "target", label: "Target", render: (row) => [row.targetType, row.targetId].filter(Boolean).join(": ") || "none"},
            {key: "message", label: "Message", render: (row) => <span className="admin-table-message">{row.message}</span>}
          ]}
          rows={events}
          empty="No events match the current filters."
          getKey={(row, index) => normalizeString(row.eventId, `event-${index}`)}
          onRowClick={(row) => setSelectedEventId(normalizeString(row.eventId))}
          selectedKey={selectedEventId}
        />
      </section>
      <AdminDrawer
        open={Boolean(selectedEvent)}
        title={normalizeString(selectedEvent?.eventType, "Event detail")}
        kicker={normalizeString(selectedEvent?.domain, "event")}
        onClose={() => setSelectedEventId("")}
      >
        {selectedEvent ? (
          <div className="admin-drawer-stack">
            <div className="admin-detail-grid">
              <span><strong>Severity</strong>{selectedEvent.severity}</span>
              <span><strong>Actor</strong>{normalizeString(selectedEvent.actorLabel, selectedEvent.actorId || selectedEvent.actorType)}</span>
              <span><strong>Target</strong>{[selectedEvent.targetType, selectedEvent.targetId].filter(Boolean).join(": ") || "none"}</span>
              <span><strong>Created</strong>{formatDate(selectedEvent.createdAt)}</span>
            </div>
            <p>{selectedEvent.message}</p>
            <details className="admin-json-details" open>
              <summary>Metadata</summary>
              <pre>{JSON.stringify(selectedEvent.metadata || {}, null, 2)}</pre>
            </details>
            <details className="admin-json-details">
              <summary>Raw event</summary>
              <pre>{JSON.stringify(selectedEvent, null, 2)}</pre>
            </details>
          </div>
        ) : null}
      </AdminDrawer>
    </>
  );
};

export default SystemEventsPage;
