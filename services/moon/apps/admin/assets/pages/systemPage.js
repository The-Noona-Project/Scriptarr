import {escapeHtml, renderEmptyState, renderStatusBadge, renderTable} from "../dom.js";
import {formatDate} from "../format.js";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Resolve system route config.
 *
 * @param {string} routeId
 * @returns {{path: string, title: string, emptyTitle: string, emptyBody: string}}
 */
const systemConfig = (routeId) => ({
  "system-status": {
    path: "/api/moon/v3/admin/system/status",
    title: "System status",
    emptyTitle: "Status unavailable",
    emptyBody: "Moon could not load Warden and service status details."
  },
  "system-tasks": {
    path: "/api/moon/v3/admin/system/tasks",
    title: "Tasks",
    emptyTitle: "No tasks available",
    emptyBody: "There are no pending requests or active service tasks to show."
  },
  "system-updates": {
    path: "/api/moon/v3/admin/system/updates",
    title: "Updates",
    emptyTitle: "No update data",
    emptyBody: "Image publish data is not available."
  },
  "system-events": {
    path: "/api/moon/v3/admin/system/events",
    title: "Events",
    emptyTitle: "No recent events",
    emptyBody: "Recent request and task timeline events will appear here."
  },
  "system-logs": {
    path: "/api/moon/v3/admin/system/logs",
    title: "Logs",
    emptyTitle: "No log summary",
    emptyBody: "Sanitized service log lines will appear here."
  }
}[routeId]);

/**
 * Load a system page payload.
 *
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   route: import("../routes.js").AdminRoute
 * }} context
 * @returns {Promise<import("../api.js").ApiResult & {routeId: string}>}
 */
export const loadSystemPage = async ({api, route}) => ({
  ...(await api.get(systemConfig(route.id).path)),
  routeId: route.id
});

/**
 * Render the system page family.
 *
 * @param {Awaited<ReturnType<typeof loadSystemPage>>} result
 * @returns {string}
 */
export const renderSystemPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("System page unavailable", result.payload?.error || "Unable to load system data.");
  }

  if (result.routeId === "system-status") {
    const services = result.payload?.services || {};
    const bootstrap = result.payload?.bootstrap || {};
    const runtime = result.payload?.runtime || {};
    const runtimeNetwork = runtime.managedNetworkName || bootstrap.managedNetworkName || "scriptarr-network";
    const runtimeMysqlMode = runtime.mysql?.mode || bootstrap.mysql?.mode || "selfhost";

    return `
      <div class="content-grid two-up">
        <section class="panel-section">
          <div class="section-heading">
            <div>
              <span class="section-kicker">Runtime</span>
              <h2>Service health</h2>
            </div>
          </div>
          <div class="service-strip">
            ${Object.entries(services).map(([name, payload]) => `
              <article class="service-card">
                <div class="service-card-head">
                  <strong>${escapeHtml(name)}</strong>
                  ${renderStatusBadge(payload?.ok === false ? "Degraded" : "Online")}
                </div>
                <p>${escapeHtml(payload?.error || payload?.service || payload?.message || "Healthy")}</p>
              </article>
            `).join("")}
          </div>
        </section>
        <section class="panel-section">
          <div class="section-heading">
            <div>
              <span class="section-kicker">Bootstrap</span>
              <h2>Managed stack</h2>
            </div>
          </div>
          ${renderTable({
            columns: ["Service", "Image", "Container"],
            rows: (bootstrap.services || []).map((service) => [
              `<strong>${escapeHtml(service.name)}</strong>`,
              escapeHtml(service.image),
              escapeHtml(service.containerName)
            ]),
            emptyTitle: "No managed services found",
            emptyBody: "Bootstrap data has not been surfaced yet."
          })}
          <div class="callout subtle">
            <strong>Network</strong>
            <p>${escapeHtml(runtimeNetwork)} &middot; ${escapeHtml(runtime.stackMode || "production")} &middot; ${escapeHtml(runtimeMysqlMode)}</p>
          </div>
        </section>
      </div>
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Maintenance</span>
            <h2>Content reset</h2>
          </div>
        </div>
        <div class="callout subtle">
          <strong>Safe content-only reset</strong>
          <p>Users, groups, sessions, settings, secrets, and durable events stay intact. Library titles, requests, progress, follows, bookmarks, Raven task state, and managed download folders are wiped.</p>
        </div>
        ${result.payload?.contentReset ? `
          <div class="content-grid two-up">
            <article class="service-card">
              <div class="service-card-head">
                <strong>Vault preview</strong>
                ${renderStatusBadge("Ready")}
              </div>
              <p>Requests ${escapeHtml(String(result.payload.contentReset.vault?.counts?.requests || 0))} · Titles ${escapeHtml(String(result.payload.contentReset.vault?.counts?.ravenTitles || 0))} · Progress ${escapeHtml(String(result.payload.contentReset.vault?.counts?.progress || 0))}</p>
            </article>
            <article class="service-card">
              <div class="service-card-head">
                <strong>Raven preview</strong>
                ${renderStatusBadge(result.payload.contentReset.raven?.error ? "Degraded" : "Ready")}
              </div>
              <p>${result.payload.contentReset.raven?.error
                ? escapeHtml(result.payload.contentReset.raven.error)
                : `Downloading folders ${escapeHtml(String(result.payload.contentReset.raven?.counts?.downloadingTitleFolders || 0))} · Downloaded folders ${escapeHtml(String(result.payload.contentReset.raven?.counts?.downloadedTitleFolders || 0))} · Active tasks ${escapeHtml(String(result.payload.contentReset.raven?.counts?.activeTasks || 0))}`}</p>
            </article>
          </div>
          <div class="field-stack" style="margin-top:16px;">
            <label class="field-label" for="content-reset-confirmation">Type ${escapeHtml(result.payload.contentReset.confirmationText || "RESET SCRIPTARR CONTENT")} to confirm</label>
            <input id="content-reset-confirmation" class="text-input" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(result.payload.contentReset.confirmationText || "RESET SCRIPTARR CONTENT")}" />
            <div class="action-row">
              <button class="solid-button danger-button" type="button" data-action="execute-content-reset">Reset content</button>
            </div>
          </div>
        ` : ""}
      </section>
    `;
  }

  if (result.routeId === "system-tasks") {
    return `
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">System tasks</span>
            <h2>Requests and service work</h2>
          </div>
        </div>
        ${renderTable({
          columns: ["Title", "Status", "Progress", "Updated"],
          rows: (result.payload?.tasks || []).map((task) => [
            `<strong>${escapeHtml(task.titleName)}</strong>`,
            renderStatusBadge(task.status),
            escapeHtml(`${task.percent || 0}%`),
            escapeHtml(formatDate(task.updatedAt || task.queuedAt, {includeTime: true}))
          ]),
          emptyTitle: "No active tasks",
          emptyBody: "Raven has no queued or completed task history to show right now."
        })}
      </section>
    `;
  }

  if (result.routeId === "system-updates") {
    const services = result.payload?.services || [];
    const job = result.payload?.job || null;
    const checkedAt = result.payload?.checkedAt || null;
    const selectableServices = services.filter((service) => service.updateAvailable);

    return `
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Images</span>
            <h2>Managed service updates</h2>
          </div>
        </div>
        <div class="action-row update-toolbar">
          <button class="ghost-button" type="button" data-action="check-updates">Check now</button>
          <button class="ghost-button" type="button" data-action="install-selected" ${selectableServices.length ? "" : "disabled"}>Install selected</button>
          <button class="solid-button" type="button" data-action="install-all">Install all</button>
        </div>
        ${job ? `
          <div class="callout subtle">
            <strong>Update job ${escapeHtml(job.jobId)}</strong>
            <p>${escapeHtml(job.status === "running"
              ? `Installing ${job.requestedServices?.join(", ") || "managed services"}`
              : job.error || "The last update job finished cleanly.")}</p>
          </div>
        ` : ""}
        ${checkedAt ? `
          <p class="field-note">Last checked ${escapeHtml(formatDate(checkedAt, {includeTime: true}))}.</p>
        ` : ""}
        ${renderTable({
          columns: ["Pick", "Service", "Status", "Running image", "Available image", "Container", "Image"],
          rows: services.map((service) => [
            service.updateAvailable
              ? `<label class="checkbox-cell"><input type="checkbox" data-update-service="${escapeHtml(service.name)}" checked></label>`
              : `<span class="muted-copy">-</span>`,
            `<strong>${escapeHtml(service.name)}</strong>`,
            renderStatusBadge(service.updateAvailable ? "Update available" : "Current"),
            escapeHtml(service.runningImageLabel || "missing"),
            escapeHtml(service.localImageLabel || "unknown"),
            escapeHtml(service.containerName),
            escapeHtml(service.image)
          ]),
          emptyTitle: "No image data",
          emptyBody: "Warden has not surfaced image tags for the managed stack yet."
        })}
      </section>
    `;
  }

  if (result.routeId === "system-events") {
    return `
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Timeline</span>
            <h2>Recent events</h2>
          </div>
        </div>
        ${renderTable({
          columns: ["Domain", "Type", "Actor", "Message", "When"],
          rows: normalizeArray(result.payload?.events).map((event) => [
            escapeHtml(normalizeString(event.domain, "system")),
            renderStatusBadge(normalizeString(event.eventType, "updated")),
            escapeHtml(normalizeString(event.actorLabel, normalizeString(event.actorId, "system"))),
            escapeHtml(normalizeString(event.message, "Scriptarr recorded an event.")),
            escapeHtml(formatDate(event.createdAt, {includeTime: true}))
          ]),
          emptyTitle: "No recent events",
          emptyBody: "Recent request and task activity will be summarized here."
        })}
      </section>
    `;
  }

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Logs</span>
          <h2>Sanitized log summary</h2>
        </div>
      </div>
      ${renderTable({
        columns: ["Line"],
        rows: (result.payload?.entries || []).map((entry) => [escapeHtml(entry)]),
        emptyTitle: "No log lines",
        emptyBody: "Service log lines will show here once Warden and the services publish them."
      })}
    </section>
  `;
};

/**
 * Enhance system page interactions after the shell renders.
 *
 * @param {HTMLElement} root
 * @param {{api: ReturnType<import("../api.js").createAdminApi>, rerender: () => Promise<void>, setFlash: (tone: string, text: string) => void}} context
 * @param {Awaited<ReturnType<typeof loadSystemPage>>} result
 * @returns {Promise<void>}
 */
export const enhanceSystemPage = async (root, {api, rerender, setFlash}, result) => {
  if (result.routeId === "system-events") {
    const stream = new EventSource("/api/moon/v3/admin/events/stream");
    const refreshSoon = () => {
      globalThis.setTimeout(() => {
        void rerender();
      }, 150);
    };
    stream.addEventListener("admin-event", refreshSoon);
    stream.addEventListener("error", () => {
      stream.close();
    });
    root.addEventListener("DOMNodeRemoved", () => {
      stream.close();
    }, {once: true});
    return;
  }

  if (result.routeId !== "system-updates") {
    if (result.routeId !== "system-status") {
      return;
    }

    root.querySelector("[data-action='execute-content-reset']")?.addEventListener("click", async () => {
      const confirmation = /** @type {HTMLInputElement | null} */ (root.querySelector("#content-reset-confirmation"))?.value || "";
      const response = await api.post("/api/moon/v3/admin/system/content-reset", {confirmation});
      setFlash(response.ok ? "good" : "bad", response.ok
        ? "Scriptarr content reset completed."
        : response.payload?.error || "Unable to complete the content reset.");
      await rerender();
    });
    return;
  }

  const selectedServices = () => Array.from(root.querySelectorAll("[data-update-service]:checked"))
    .map((input) => input.getAttribute("data-update-service"))
    .filter(Boolean);

  root.querySelector("[data-action='check-updates']")?.addEventListener("click", async () => {
    const response = await api.post("/api/moon/v3/admin/system/updates/check");
    setFlash(response.ok ? "good" : "bad", response.ok ? "Checked the managed service channels." : response.payload?.error || "Unable to check for updates.");
    await rerender();
  });

  root.querySelector("[data-action='install-selected']")?.addEventListener("click", async () => {
    const services = selectedServices();
    const response = await api.post("/api/moon/v3/admin/system/updates/install", {services});
    setFlash(response.ok ? "good" : "bad", response.ok ? "Started the selected managed service update job." : response.payload?.error || "Unable to start the selected update job.");
    await rerender();
  });

  root.querySelector("[data-action='install-all']")?.addEventListener("click", async () => {
    const response = await api.post("/api/moon/v3/admin/system/updates/install");
    setFlash(response.ok ? "good" : "bad", response.ok ? "Started the full managed service update job." : response.payload?.error || "Unable to start the full update job.");
    await rerender();
  });

  if (result.payload?.job?.status === "running") {
    globalThis.setTimeout(() => {
      void rerender();
    }, 2000);
  }
};

export default {
  loadSystemPage,
  renderSystemPage,
  enhanceSystemPage
};
