"use client";

/**
 * @file Purpose-built managed update page for Moon admin.
 */

import {useEffect, useMemo, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminJson} from "../lib/api.js";
import {formatDate, formatPercent, normalizeString} from "../lib/format.js";
import {AdminActionBanner, AdminConfirmPanel, AdminDenseTable, AdminFilterBar, AdminStatusBadge} from "./AdminUi.jsx";
import {useAdminToast} from "./AdminToasts.jsx";

const CONFIRMATION = "UPDATE SCRIPTARR";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const serviceTone = (service) => {
  if (service.updateAvailable) {
    return "warning";
  }
  if (service.running) {
    return "good";
  }
  return "bad";
};

const taskTone = (status) => {
  const normalized = normalizeString(status).toLowerCase();
  if (normalized === "failed") {
    return "bad";
  }
  if (normalized === "running") {
    return "running";
  }
  if (normalized === "queued") {
    return "queued";
  }
  return "good";
};

/**
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const SystemUpdatesPage = ({user}) => {
  const canMutate = hasAdminGrant(user, "system", "root");
  const [selected, setSelected] = useState(() => new Set());
  const [confirmation, setConfirmation] = useState("");
  const [flash, setFlash] = useState("");
  const [flashTone, setFlashTone] = useState("");
  const {notify} = useAdminToast();
  const {loading, refreshing, error, data, refresh, setData} = useAdminJson("/api/moon/v3/admin/system/updates", {
    fallback: {
      services: [],
      job: null
    }
  });
  const services = normalizeArray(data?.services);
  const updateableServices = useMemo(() =>
    services.filter((service) => service.updateAvailable).map((service) => service.name),
  [services]);
  const job = data?.job || null;
  const jobTasks = normalizeArray(job?.tasks).sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0));
  const installReady = canMutate && confirmation === CONFIRMATION;
  const selectedList = Array.from(selected).filter((name) => updateableServices.includes(name));

  useEffect(() => {
    setSelected((current) => new Set(Array.from(current).filter((name) => updateableServices.includes(name))));
  }, [updateableServices.join("|")]);

  useEffect(() => {
    if (job?.status !== "running") {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [job?.status, refresh]);

  const runAction = async (path, body = {}) => {
    setFlash("");
    const result = await requestJson(path, {
      method: "POST",
      json: body
    });
    if (!result.ok) {
      setFlash(result.payload?.error || "Moon could not complete that update action.");
      setFlashTone("bad");
      notify({message: result.payload?.error || "Moon could not complete that update action.", tone: "bad", category: "job"});
      return;
    }
    setData(result.payload);
    setFlash("Update action accepted.");
    setFlashTone("good");
    notify({message: "Update action accepted.", tone: "good", category: "job"});
  };

  const toggleSelected = (serviceName) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(serviceName)) {
        next.delete(serviceName);
      } else {
        next.add(serviceName);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">System</div>
        <h2>Loading updates</h2>
        <p>Moon is reading managed service image state from Warden.</p>
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
            <h2>Updates</h2>
            <p className="admin-muted">Check and install newer managed service images through Warden.</p>
          </div>
          <AdminStatusBadge tone={job?.status === "running" ? "running" : refreshing ? "warning" : "good"}>
            {job?.status === "running" ? "Update running" : refreshing ? "Refreshing" : "Ready"}
          </AdminStatusBadge>
        </div>
        <AdminFilterBar>
          <button className="admin-button ghost" type="button" onClick={() => void refresh()}>Refresh</button>
          <button
            className="admin-button solid"
            type="button"
            disabled={!canMutate}
            onClick={() => void runAction("/api/moon/v3/admin/system/updates/check")}
          >
            Check now
          </button>
          <button
            className="admin-button solid"
            type="button"
            disabled={!installReady || !selectedList.length}
            onClick={() => void runAction("/api/moon/v3/admin/system/updates/install", {services: selectedList})}
          >
            Install selected
          </button>
          <button
            className="admin-button danger"
            type="button"
            disabled={!installReady || !updateableServices.length}
            onClick={() => void runAction("/api/moon/v3/admin/system/updates/install", {services: updateableServices})}
          >
            Install all available
          </button>
        </AdminFilterBar>
        {!canMutate ? <p className="admin-muted">Viewing is allowed with system.read. Check and install actions require system.root.</p> : null}
        <div className="admin-log-meta">
          <span>Latest check: {formatDate(data?.checkedAt)}</span>
          <span>{updateableServices.length} service{updateableServices.length === 1 ? "" : "s"} update available</span>
          <span>{selectedList.length} selected</span>
        </div>
      </section>
      <section className="admin-panel">
        <AdminConfirmPanel confirmation={CONFIRMATION} value={confirmation} onChange={setConfirmation}>
          Installs restart selected managed services. Only services marked update available can be installed.
        </AdminConfirmPanel>
      </section>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Images</div>
            <h2>Managed services</h2>
          </div>
        </div>
        <div className="admin-update-grid">
          {services.map((service) => {
            const isSelectable = Boolean(service.updateAvailable);
            const isSelected = selected.has(service.name);
            return (
              <article className={`admin-update-card${isSelected ? " is-selected" : ""}`} key={service.name}>
                <div className="admin-record-head">
                  <strong>{service.name}</strong>
                  <AdminStatusBadge tone={serviceTone(service)}>
                    {service.updateAvailable ? "Update" : service.health || "current"}
                  </AdminStatusBadge>
                </div>
                <p>{service.image}</p>
                <div className="admin-detail-grid">
                  <span><strong>Running</strong>{service.runningImageLabel || "unknown"}</span>
                  <span><strong>Local</strong>{service.localImageLabel || "unknown"}</span>
                  <span><strong>Health</strong>{service.health || "unknown"}</span>
                  <span><strong>Container</strong>{service.containerName || "managed"}</span>
                </div>
                <label className="admin-check-row">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={!isSelectable}
                    onChange={() => toggleSelected(service.name)}
                  />
                  <span>{isSelectable ? "Include in install" : "No update available"}</span>
                </label>
              </article>
            );
          })}
        </div>
      </section>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Active job</div>
            <h2>{job ? job.label || job.kind || "Update job" : "No update job"}</h2>
          </div>
          {job ? <AdminStatusBadge tone={taskTone(job.status)}>{job.status}</AdminStatusBadge> : null}
        </div>
        {job ? (
          <>
            <div className="admin-log-meta">
              <span>Started: {formatDate(job.startedAt || job.createdAt)}</span>
              <span>Updated: {formatDate(job.updatedAt)}</span>
              <span>{normalizeArray(job.servicesToRestart || job.requestedServices).length} service target{normalizeArray(job.servicesToRestart || job.requestedServices).length === 1 ? "" : "s"}</span>
            </div>
            <AdminDenseTable
              columns={[
                {key: "label", label: "Task"},
                {key: "status", label: "Status", className: "is-tight", render: (row) => <AdminStatusBadge tone={taskTone(row.status)}>{row.status}</AdminStatusBadge>},
                {key: "percent", label: "Progress", className: "is-tight", render: (row) => formatPercent(row.percent)},
                {key: "message", label: "Message", render: (row) => row.message || "Waiting"}
              ]}
              rows={jobTasks}
              empty="No update job tasks have been recorded yet."
              getKey={(row, index) => normalizeString(row.taskId, `update-task-${index}`)}
            />
          </>
        ) : <div className="admin-empty">Run a check or install action to create update job activity.</div>}
      </section>
    </>
  );
};

export default SystemUpdatesPage;
