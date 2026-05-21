"use client";

/**
 * @file Generic data-backed admin pages for the Next Moon admin app.
 */

import {useMemo} from "react";
import {useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {buildAdminLibraryTitlePath} from "../lib/routes.js";
import {formatDate, normalizeString} from "../lib/format.js";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const isPlainObject = (value) => value && typeof value === "object" && !Array.isArray(value);

const endpointForRoute = (route) => {
  const titleId = normalizeString(route.params?.titleId);
  const endpoints = {
    overview: "/api/moon/v3/admin/overview",
    library: "/api/moon/v3/admin/library",
    import: "/api/moon/v3/admin/import",
    ingest: "/api/moon/v3/admin/ingest",
    calendar: "/api/moon/v3/admin/calendar",
    "activity-history": "/api/moon/v3/admin/activity/history",
    "activity-blocklist": "/api/moon/v3/admin/activity/blocklist",
    "wanted-missing": "/api/moon/v3/admin/wanted/missing-content",
    "wanted-metadata": "/api/moon/v3/admin/wanted/metadata",
    requests: "/api/moon/v3/admin/requests",
    users: "/api/moon/v3/admin/users",
    discord: "/api/moon/admin/settings/portal/discord",
    mediamanagement: "/api/moon/v3/admin/mediamanagement",
    settings: "/api/moon/v3/admin/settings",
    "system-api": "/api/moon/admin/settings/moon/public-api",
    "system-status": "/api/moon/v3/admin/system/status",
    "system-tasks": "/api/moon/v3/admin/system/tasks",
    "system-updates": "/api/moon/v3/admin/system/updates",
    "system-events": "/api/moon/v3/admin/system/events",
    "system-logs": "/api/moon/v3/admin/system/logs"
  };
  if (route.id === "library-title" && titleId) {
    return `/api/moon/v3/admin/library/${encodeURIComponent(titleId)}`;
  }
  return endpoints[route.id] || null;
};

const domainForRoute = (route) => {
  if (route.id.startsWith("activity-")) {
    return "activity";
  }
  if (route.id.startsWith("system-")) {
    return "system";
  }
  return route.domain || "system";
};

const titleForRecord = (record) =>
  normalizeString(
    record.title,
    normalizeString(record.titleName, normalizeString(record.name, normalizeString(record.label, normalizeString(record.eventType, "Record"))))
  );

const statusForRecord = (record) =>
  normalizeString(record.status, normalizeString(record.state, normalizeString(record.role, normalizeString(record.severity))));

const coverForRecord = (record) =>
  normalizeString(record.coverUrl, normalizeString(record.avatarUrl, normalizeString(record.iconUrl)));

const summarizeValue = (value) => {
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (isPlainObject(value)) {
    return Object.keys(value).slice(0, 4).join(", ") || "object";
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (value == null || value === "") {
    return "";
  }
  return String(value);
};

const primaryArray = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!isPlainObject(payload)) {
    return [];
  }
  const preferredKeys = [
    "titles",
    "requests",
    "users",
    "groups",
    "entries",
    "tasks",
    "events",
    "updates",
    "logs",
    "imports",
    "services"
  ];
  for (const key of preferredKeys) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
  }
  const firstArray = Object.values(payload).find(Array.isArray);
  return firstArray || [];
};

const metricEntries = (payload) => {
  const metrics = [];
  const addObjectMetrics = (source, prefix = "") => {
    if (!isPlainObject(source)) {
      return;
    }
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "number" || typeof value === "boolean") {
        metrics.push({
          label: `${prefix}${key}`.replace(/([a-z])([A-Z])/g, "$1 $2"),
          value: typeof value === "boolean" ? value ? "yes" : "no" : value
        });
      }
    }
  };

  addObjectMetrics(payload?.counts);
  addObjectMetrics(payload?.summary);
  addObjectMetrics(payload?.stats);

  if (isPlainObject(payload)) {
    for (const [key, value] of Object.entries(payload)) {
      if (Array.isArray(value)) {
        metrics.push({
          label: key.replace(/([a-z])([A-Z])/g, "$1 $2"),
          value: value.length
        });
      }
    }
  }

  return metrics.slice(0, 8);
};

const detailPairs = (record) => Object.entries(record || {})
  .filter(([key, value]) => !["coverUrl", "avatarUrl", "iconUrl", "chapters", "details", "timeline", "events"].includes(key) && value != null && value !== "")
  .slice(0, 7)
  .map(([key, value]) => ({
    key,
    label: key.replace(/([a-z])([A-Z])/g, "$1 $2"),
    value: key.toLowerCase().includes("at") || key.toLowerCase().includes("date") ? formatDate(value) : summarizeValue(value)
  }))
  .filter((entry) => entry.value);

const recordHref = (route, record) => {
  if (route.id === "library") {
    const titleId = normalizeString(record.id);
    if (titleId) {
      return buildAdminLibraryTitlePath(record.libraryTypeSlug || record.mediaType || record.requestType || "manga", titleId);
    }
  }
  return "";
};

const RecordCard = ({route, record}) => {
  const coverUrl = coverForRecord(record);
  const title = titleForRecord(record);
  const status = statusForRecord(record);
  const href = recordHref(route, record);
  const body = (
    <>
      <div className="admin-record-media">
        {coverUrl ? <img src={coverUrl} alt="" /> : <span>{title.slice(0, 1).toUpperCase()}</span>}
      </div>
      <div className="admin-record-copy">
        <div className="admin-record-head">
          <strong>{title}</strong>
          {status ? <span className="admin-badge">{status}</span> : null}
        </div>
        <div className="admin-record-details">
          {detailPairs(record).map((detail) => (
            <span key={detail.key}>
              <em>{detail.label}</em>
              {detail.value}
            </span>
          ))}
        </div>
      </div>
    </>
  );

  return href ? <a className="admin-record-card" href={href}>{body}</a> : <article className="admin-record-card">{body}</article>;
};

const JsonSummary = ({payload}) => (
  <details className="admin-json-details">
    <summary>Raw payload</summary>
    <pre>{JSON.stringify(payload, null, 2)}</pre>
  </details>
);

/**
 * Render a real data-backed admin route.
 *
 * @param {{route: import("../lib/routes.js").AdminRoute}} props
 * @returns {import("react").ReactNode}
 */
export const AdminDataPage = ({route}) => {
  const endpoint = endpointForRoute(route);
  const {loading, refreshing, error, data, refresh} = useAdminJson(endpoint, {
    enabled: Boolean(endpoint),
    fallback: {}
  });
  const live = useAdminEventStaleness({
    domains: [domainForRoute(route)],
    enabled: Boolean(endpoint),
    onStale: () => {},
    onRefresh: refresh
  });
  const records = useMemo(() => primaryArray(data), [data]);
  const metrics = useMemo(() => metricEntries(data), [data]);

  if (!endpoint) {
    return (
      <section className="admin-panel admin-state-panel is-danger">
        <div className="admin-kicker">Route</div>
        <h2>Admin route not found</h2>
        <p>Moon does not have a Next admin route for {route.path}.</p>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">{route.group}</div>
        <h2>Loading {route.title}</h2>
        <p>Moon is reading {route.title.toLowerCase()} through the same-origin admin API.</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="admin-panel admin-state-panel is-danger">
        <div className="admin-kicker">{route.group}</div>
        <h2>{route.title} unavailable</h2>
        <p>{error}</p>
      </section>
    );
  }

  return (
    <>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">{route.group}</div>
            <h2>{route.title}</h2>
          </div>
          <span className={`admin-badge ${live.state === "live" ? "running" : "warning"}`}>
            {refreshing ? "Refreshing quietly" : live.state === "live" ? "Live" : "Degraded"}
          </span>
        </div>
        {metrics.length ? (
          <div className="admin-metric-grid">
            {metrics.map((metric) => (
              <article className="admin-metric-card" key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
              </article>
            ))}
          </div>
        ) : <p className="admin-muted">Live data is connected. There are no numeric summary fields for this route yet.</p>}
      </section>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Records</div>
            <h2>{records.length ? `${records.length} item${records.length === 1 ? "" : "s"}` : "No records"}</h2>
          </div>
        </div>
        {records.length ? (
          <div className="admin-record-grid">
            {records.slice(0, 80).map((record, index) => (
              <RecordCard route={route} record={record} key={normalizeString(record.id || record.taskId || record.eventId || record.discordUserId, `${route.id}-${index}`)} />
            ))}
          </div>
        ) : <div className="admin-empty">Nothing is waiting here right now.</div>}
      </section>
      <JsonSummary payload={data} />
    </>
  );
};

export default AdminDataPage;
