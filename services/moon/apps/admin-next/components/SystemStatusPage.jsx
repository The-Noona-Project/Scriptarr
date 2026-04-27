"use client";

/**
 * @file Purpose-built grouped endpoint matrix for Moon admin status.
 */

import {Accordion} from "@once-ui-system/core";
import {Fragment, useState} from "react";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {formatDate, normalizeString} from "../lib/format.js";
import {resolveStatusGroupKey, toggleStatusGroupKey} from "../lib/statusGroups.js";
import {AdminActionBanner, AdminStatusBadge} from "./AdminUi.jsx";
import {useAdminToast} from "./AdminToasts.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const statusTone = (status) => {
  const normalized = normalizeString(status).toLowerCase();
  if (normalized === "online") {
    return "good";
  }
  if (normalized === "degraded" || normalized === "failed") {
    return "bad";
  }
  return "queued";
};

/**
 * @param {{endpoint: any}} props
 * @returns {import("react").ReactNode}
 */
const EndpointRow = ({endpoint}) => (
  <tr>
    <td className="is-tight"><AdminStatusBadge tone={statusTone(endpoint.probeStatus)}>{endpoint.probeStatus || "not probed"}</AdminStatusBadge></td>
    <td className="is-tight"><code>{endpoint.method}</code></td>
    <td><code>{endpoint.path}</code><p className="admin-muted">{endpoint.description}</p></td>
    <td>{endpoint.auth}</td>
    <td>{endpoint.safeToProbe ? "safe read" : "not probed"}</td>
    <td>{endpoint.statusCode || "none"}</td>
    <td>{endpoint.latencyMs == null ? "none" : `${endpoint.latencyMs} ms`}</td>
    <td>{endpoint.error || endpoint.payloadSummary || "ok"}</td>
  </tr>
);

/**
 * @param {{group: any}} props
 * @returns {import("react").ReactNode}
 */
const EndpointGroup = ({group}) => {
  const endpoints = normalizeArray(group?.endpoints);
  return (
    <div className="admin-endpoint-group">
      <div className="admin-log-meta">
        <span>{endpoints.filter((entry) => entry.safeToProbe).length} safe probe{endpoints.filter((entry) => entry.safeToProbe).length === 1 ? "" : "s"}</span>
        <span>{endpoints.filter((entry) => entry.probeStatus === "online").length} online</span>
        <span>{endpoints.filter((entry) => entry.probeStatus === "not_probed").length} not probed</span>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-dense-table admin-endpoint-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Method</th>
              <th>Endpoint</th>
              <th>Auth</th>
              <th>Safety</th>
              <th>HTTP</th>
              <th>Latency</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((endpoint) => <EndpointRow endpoint={endpoint} key={endpoint.id} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/**
 * @returns {import("react").ReactNode}
 */
export const SystemStatusPage = () => {
  const [openGroupKeys, setOpenGroupKeys] = useState([]);
  const {notify} = useAdminToast();
  const {loading, refreshing, error, data, refresh, setData} = useAdminJson("/api/moon/v3/admin/system/status", {
    fallback: {
      groups: [],
      summary: {}
    }
  });
  const live = useAdminEventStaleness({
    domains: ["system"],
    enabled: true,
    onStale: () => {},
    onRefresh: refresh
  });
  const groups = normalizeArray(data?.groups);
  const summary = data?.summary || {};

  const runCheck = async () => {
    const result = await requestJson("/api/moon/v3/admin/system/status/check", {method: "POST"});
    if (result.ok) {
      setData(result.payload);
      notify({message: "Safe endpoint check completed.", tone: "good", category: "action"});
      return;
    }
    notify({message: result.payload?.error || "Safe endpoint check failed.", tone: "bad", category: "action"});
  };
  const toggleGroup = (key) => {
    setOpenGroupKeys((current) => toggleStatusGroupKey(current, key));
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">System</div>
        <h2>Loading status</h2>
        <p>Moon is asking Sage for grouped service endpoints and safe probes.</p>
      </section>
    );
  }

  return (
    <>
      {error ? <AdminActionBanner tone="bad">{error}</AdminActionBanner> : null}
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">System</div>
            <h2>Status</h2>
            <p className="admin-muted">Known Scriptarr endpoints grouped by service. Safe reads are probed; mutations are listed only.</p>
          </div>
          <AdminStatusBadge tone={live.state === "live" ? "running" : "warning"}>
            {refreshing ? "Refreshing quietly" : live.state === "live" ? "Live" : "Degraded"}
          </AdminStatusBadge>
        </div>
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Total endpoints</span><strong>{summary.total || 0}</strong></article>
          <article className="admin-metric-card"><span>Probed</span><strong>{summary.probed || 0}</strong></article>
          <article className="admin-metric-card"><span>Online</span><strong>{summary.online || 0}</strong></article>
          <article className="admin-metric-card"><span>Not probed</span><strong>{summary.notProbed || 0}</strong></article>
        </div>
        <div className="admin-log-meta">
          <span>Generated: {formatDate(data?.generatedAt)}</span>
          <span>Legacy service health remains available below this matrix.</span>
        </div>
        <button className="admin-button solid" type="button" onClick={() => void runCheck()}>
          Check safe endpoints
        </button>
      </section>
      <section className="admin-panel admin-status-accordion">
        <div className="admin-status-accordion-list">
          {groups.map((group, index) => {
            const groupKey = resolveStatusGroupKey(group, index);
            return (
              <Fragment key={groupKey}>
                <Accordion
                  size="m"
                  title={`${group.label} (${normalizeArray(group.endpoints).length})`}
                  open={openGroupKeys.includes(groupKey)}
                  onToggle={() => toggleGroup(groupKey)}
                >
                  <EndpointGroup group={group} />
                </Accordion>
                {index < groups.length - 1 ? <div className="admin-status-accordion-divider" /> : null}
              </Fragment>
            );
          })}
        </div>
      </section>
    </>
  );
};

export default SystemStatusPage;
