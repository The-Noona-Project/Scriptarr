import {escapeHtml, renderAvatar, renderChipList, renderCoverThumb, renderEmptyState, renderStatusBadge} from "../dom.js";
import {formatDate} from "../format.js";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Encode JSON for an application/json script tag without HTML-escaping quotes,
 * which would break JSON.parse() when the client enhancement reads textContent.
 *
 * @param {unknown} value
 * @returns {string}
 */
const encodeJson = (value) => JSON.stringify(value)
  .replace(/</g, "\\u003c")
  .replace(/>/g, "\\u003e")
  .replace(/&/g, "\\u0026")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");
const parseJsonNode = (root, selector, fallback = []) => {
  try {
    return JSON.parse(root.querySelector(selector)?.textContent || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};

const REQUEST_FILTERS = [
  {id: "all", label: "All"},
  {id: "pending", label: "Pending"},
  {id: "unavailable", label: "Unavailable"},
  {id: "queued", label: "Queued"},
  {id: "completed", label: "Completed"},
  {id: "closed", label: "Closed"}
];

const isClosedStatus = (status) => ["denied", "blocked", "expired", "cancelled"].includes(normalizeString(status));
const hasAdminSource = (request) => Boolean(request?.details?.selectedDownload?.titleUrl);

const buildFilterCounts = (requests) => ({
  all: requests.length,
  pending: requests.filter((entry) => normalizeString(entry.status) === "pending").length,
  unavailable: requests.filter((entry) => normalizeString(entry.status) === "unavailable").length,
  queued: requests.filter((entry) => ["queued", "downloading", "failed"].includes(normalizeString(entry.status))).length,
  completed: requests.filter((entry) => normalizeString(entry.status) === "completed").length,
  closed: requests.filter((entry) => isClosedStatus(entry.status)).length
});

const matchesFilter = (request, filter) => {
  const status = normalizeString(request?.status);
  if (filter === "all") {
    return true;
  }
  if (filter === "closed") {
    return isClosedStatus(status);
  }
  if (filter === "queued") {
    return ["queued", "downloading", "failed"].includes(status);
  }
  return status === filter;
};

const matchesSearch = (request, query) => {
  const normalizedQuery = normalizeString(query).toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const metadata = request.details?.selectedMetadata || {};
  const haystack = [
    normalizeString(request.title),
    normalizeString(request.notes),
    normalizeString(request.requestedBy?.username),
    normalizeString(request.requestedBy?.discordUserId),
    normalizeString(metadata.title),
    normalizeString(metadata.providerName || metadata.provider),
    ...normalizeArray(metadata.aliases),
    ...normalizeArray(metadata.tags)
  ].join(" ").toLowerCase();
  return haystack.includes(normalizedQuery);
};

const summarizeRequest = (request) => {
  const metadata = request.details?.selectedMetadata || {};
  const download = request.details?.selectedDownload || {};
  return `
    <article class="request-list-card ${normalizeString(request.status) === "pending" ? "is-pending" : ""}" data-request-id="${escapeHtml(request.id)}">
      <label class="request-list-select">
        <input type="checkbox" data-action="toggle-select" data-request-id="${escapeHtml(request.id)}">
      </label>
      <div class="request-list-card-main" data-action="select-request" data-request-id="${escapeHtml(request.id)}">
        <div class="request-list-card-head">
          <div>
            <strong>${escapeHtml(request.title)}</strong>
            <div class="request-list-card-meta">
              <span>${escapeHtml(request.requestType)}</span>
              <span>${escapeHtml(metadata.providerName || metadata.provider || "metadata")}</span>
              <span>${escapeHtml(download.providerName || download.providerId || request.availability || "review")}</span>
            </div>
          </div>
          ${renderStatusBadge(request.status)}
        </div>
        <div class="request-list-card-foot">
          <span>${escapeHtml(request.requestedBy?.username || request.requestedBy?.discordUserId || "Unknown requester")}</span>
          <span>${escapeHtml(formatDate(request.updatedAt, {includeTime: true}))}</span>
        </div>
      </div>
    </article>
  `;
};

const renderSourceChoice = (entry, selectedKey, index) => {
  const sourceKey = `${normalizeString(entry.providerId)}::${normalizeString(entry.titleUrl)}`;
  const isSelected = sourceKey === selectedKey;
  return `
    <article class="detail-stack-card ${isSelected ? "is-selected-source" : ""}">
      <div class="service-card-head">
        <div>
          <strong>${escapeHtml(entry.titleName || "Untitled source")}</strong>
          <span>${escapeHtml(entry.providerName || entry.providerId || "download")} · ${escapeHtml(entry.libraryTypeLabel || entry.requestType || "Manga")}</span>
          ${renderChipList([
            normalizeString(entry.confidenceBand),
            ...normalizeArray(entry.tags).slice(0, 5)
          ].filter(Boolean))}
        </div>
        ${renderStatusBadge(entry.availability || "available")}
      </div>
      <p>${escapeHtml(entry.sourceUrl || entry.titleUrl || "No upstream source URL was returned.")}</p>
      ${normalizeArray(entry.warnings).length ? `<p>${escapeHtml(normalizeArray(entry.warnings).join(" · "))}</p>` : ""}
      <button class="solid-button small" type="button" data-action="pick-source" data-source-index="${escapeHtml(index)}">
        ${isSelected ? "Selected source" : "Use this source"}
      </button>
    </article>
  `;
};

const renderTimeline = (request) => {
  const timeline = normalizeArray(request.timeline);
  if (!timeline.length) {
    return "<p class=\"muted-copy\">No request history yet.</p>";
  }

  return `
    <div class="detail-stack-list">
      ${timeline.slice().reverse().slice(0, 12).map((entry) => `
        <article class="detail-stack-card">
          <strong>${escapeHtml(entry.type || "updated")}</strong>
          <span>${escapeHtml(entry.message || "Request updated.")}</span>
          <span>${escapeHtml(formatDate(entry.at, {includeTime: true}))}</span>
        </article>
      `).join("")}
    </div>
  `;
};

const renderDetailPanel = ({request, selectedSourceKey, sourceOptions}) => {
  if (!request) {
    return renderEmptyState("Pick a request", "Select a request from the left to inspect metadata, tags, history, and download candidates.");
  }

  const metadata = request.details?.selectedMetadata || {};
  const download = request.details?.selectedDownload || {};
  const effectiveSources = normalizeArray(sourceOptions).length
    ? normalizeArray(sourceOptions)
    : (normalizeArray(request.details?.sourceFoundOptions).length
      ? normalizeArray(request.details?.sourceFoundOptions)
      : (download.titleUrl ? [download] : []));

  return `
    <section class="panel-section request-detail-panel-inner">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Deep review</span>
          <h2>${escapeHtml(request.title)}</h2>
        </div>
        <div class="action-row">
          <button class="ghost-button small" type="button" data-action="refresh-sources">Refresh sources</button>
          <button class="ghost-button small" type="button" data-action="override-request">Override metadata</button>
          <button class="ghost-button small" type="button" data-action="deny-request">Deny</button>
        </div>
      </div>
      <div class="request-detail-meta-grid">
        <article class="detail-stack-card">
          <strong>Requester</strong>
          <div class="request-detail-requester">
            ${renderAvatar(request.requestedBy?.username || request.requestedBy?.discordUserId || "Reader", "")}
            <div class="detail-stack-meta">
              <span>${escapeHtml(request.requestedBy?.username || "Unknown requester")}</span>
              <span>${escapeHtml(request.requestedBy?.discordUserId || "No Discord id")}</span>
            </div>
          </div>
        </article>
        <article class="detail-stack-card">
          <strong>Status</strong>
          <div class="action-row">
            ${renderStatusBadge(request.status)}
            ${renderStatusBadge(request.availability || "unavailable")}
          </div>
          <span>${escapeHtml(formatDate(request.updatedAt, {includeTime: true}))}</span>
        </article>
        <article class="detail-stack-card">
          <strong>Notes</strong>
          <span>${escapeHtml(request.notes || request.details?.query || "No request notes.")}</span>
        </article>
      </div>

      <section class="detail-subsection">
        <h3>Metadata</h3>
        <div class="detail-stack-list">
          <article class="detail-stack-card">
            <strong>${escapeHtml(metadata.title || request.title)}</strong>
            <span>${escapeHtml(metadata.providerName || metadata.provider || "metadata")} · ${escapeHtml(metadata.type || request.requestType || "manga")}</span>
            ${renderChipList(normalizeArray(metadata.tags).slice(0, 10))}
            ${normalizeArray(metadata.aliases).length ? `<span>${escapeHtml(normalizeArray(metadata.aliases).join(", "))}</span>` : ""}
            ${metadata.summary ? `<span>${escapeHtml(metadata.summary)}</span>` : ""}
            <div class="action-row">
              ${metadata.url ? `<a class="ghost-button small" href="${escapeHtml(metadata.url)}" target="_blank" rel="noreferrer">Open metadata</a>` : ""}
            </div>
          </article>
        </div>
      </section>

      <section class="detail-subsection">
        <div class="section-heading">
          <div>
            <h3>Download sources</h3>
            <span class="muted-copy">Admins choose the source during approval.</span>
          </div>
          <button class="solid-button small" type="button" data-action="approve-request" ${selectedSourceKey || hasAdminSource(request) ? "" : "disabled"}>
            Approve and queue
          </button>
        </div>
        ${effectiveSources.length
          ? `<div class="detail-stack-list">${effectiveSources.map((entry, index) => renderSourceChoice(entry, selectedSourceKey || `${normalizeString(download.providerId)}::${normalizeString(download.titleUrl)}`, index)).join("")}</div>`
          : `<section class="callout warn"><strong>No source selected</strong><p>This request does not have a concrete download source yet. Refresh providers or override the metadata match.</p></section>`}
      </section>

      <section class="detail-subsection">
        <h3>History</h3>
        ${renderTimeline(request)}
      </section>
    </section>
  `;
};

/**
 * Load the moderation request queue.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadRequestsPage = ({api}) => api.get("/api/moon/v3/admin/requests");

/**
 * Render the request moderation page.
 *
 * @param {Awaited<ReturnType<typeof loadRequestsPage>>} result
 * @returns {string}
 */
export const renderRequestsPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Requests unavailable", result.payload?.error || "Unable to load moderated requests.");
  }

  const requests = normalizeArray(result.payload?.requests);
  const counts = buildFilterCounts(requests);

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Moderation</span>
          <h2>Unified request queue</h2>
        </div>
      </div>
      <div class="request-workspace">
        <section class="panel-section request-list-panel">
          <script type="application/json" id="admin-requests-data">${encodeJson(requests)}</script>
          <div class="request-list-toolbar">
            <input id="admin-request-search" type="search" placeholder="Search titles, requester, tags, aliases, or metadata provider">
            <div class="request-filter-row">
              ${REQUEST_FILTERS.map((filter) => `
                <button class="ghost-button small ${filter.id === "all" ? "is-active-filter" : ""}" type="button" data-filter-id="${escapeHtml(filter.id)}">
                  ${escapeHtml(filter.label)}
                  <span>${escapeHtml(counts[filter.id] || 0)}</span>
                </button>
              `).join("")}
            </div>
            <div class="action-row">
              <button class="ghost-button small" type="button" data-bulk-action="approve">Bulk approve</button>
              <button class="ghost-button small" type="button" data-bulk-action="deny">Bulk deny</button>
              <button class="ghost-button small" type="button" data-bulk-action="refresh">Bulk refresh sources</button>
            </div>
          </div>
          <div id="admin-request-list"></div>
        </section>
        <section class="request-detail-panel">
          <div id="admin-request-detail"></div>
        </section>
      </div>
    </section>
  `;
};

/**
 * Wire request moderation actions.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @returns {Promise<void>}
 */
export const enhanceRequestsPage = async (root, {api, rerender, setFlash}) => {
  const requests = parseJsonNode(root, "#admin-requests-data", []);
  const listRoot = root.querySelector("#admin-request-list");
  const detailRoot = root.querySelector("#admin-request-detail");
  const searchInput = root.querySelector("#admin-request-search");

  let activeFilter = "all";
  let searchValue = "";
  let selectedRequestId = normalizeString(requests[0]?.id);
  let selectedIds = new Set();
  let sourceOptionsByRequest = new Map();
  let selectedSourceByRequest = new Map();

  const chooseOption = async ({title, entries, renderEntry}) => {
    const visibleEntries = normalizeArray(entries).slice(0, 8);
    if (!visibleEntries.length) {
      return null;
    }
    if (visibleEntries.length === 1) {
      return visibleEntries[0];
    }
    const answer = window.prompt(
      [
        title,
        ...visibleEntries.map((entry, index) => `${index + 1}. ${renderEntry(entry)}`)
      ].join("\n"),
      "1"
    );
    if (answer == null) {
      return null;
    }
    const index = Number.parseInt(String(answer), 10) - 1;
    return visibleEntries[index] || null;
  };

  const visibleRequests = () => normalizeArray(requests)
    .filter((entry) => matchesFilter(entry, activeFilter))
    .filter((entry) => matchesSearch(entry, searchValue));

  const selectedRequest = () => normalizeArray(requests).find((entry) => entry.id === selectedRequestId) || null;

  const currentSourceKey = (request) => {
    const explicit = normalizeString(selectedSourceByRequest.get(request.id));
    if (explicit) {
      return explicit;
    }
    const download = request.details?.selectedDownload || {};
    if (download.titleUrl) {
      return `${normalizeString(download.providerId)}::${normalizeString(download.titleUrl)}`;
    }
    return "";
  };

  const currentSourceOptions = (request) =>
    normalizeArray(sourceOptionsByRequest.get(request.id)).length
      ? normalizeArray(sourceOptionsByRequest.get(request.id))
      : normalizeArray(request.details?.sourceFoundOptions);

  const renderList = () => {
    const nextVisible = visibleRequests();
    if (!selectedRequestId && nextVisible.length) {
      selectedRequestId = nextVisible[0].id;
    }
    if (selectedRequestId && !normalizeArray(requests).some((entry) => entry.id === selectedRequestId)) {
      selectedRequestId = nextVisible[0]?.id || "";
    }

    if (!listRoot) {
      return;
    }

    listRoot.innerHTML = nextVisible.length
      ? `<div class="stack-list">${nextVisible.map((entry) => summarizeRequest(entry)).join("")}</div>`
      : renderEmptyState("No matching requests", "Adjust the filters or search terms to find a different request.");

    listRoot.querySelectorAll("[data-action='toggle-select']").forEach((checkbox) => {
      checkbox.checked = selectedIds.has(checkbox.dataset.requestId || "");
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", () => {
        const requestId = checkbox.dataset.requestId || "";
        if (checkbox.checked) {
          selectedIds.add(requestId);
        } else {
          selectedIds.delete(requestId);
        }
      });
    });

    listRoot.querySelectorAll("[data-action='select-request']").forEach((button) => {
      button.addEventListener("click", () => {
        selectedRequestId = button.dataset.requestId || "";
        renderDetail();
      });
    });

    listRoot.querySelectorAll(".request-list-card").forEach((card) => {
      card.classList.toggle("is-selected", card.dataset.requestId === selectedRequestId);
    });
  };

  const renderDetail = () => {
    if (!detailRoot) {
      return;
    }

    const request = selectedRequest();
    detailRoot.innerHTML = renderDetailPanel({
      request,
      selectedSourceKey: request ? currentSourceKey(request) : "",
      sourceOptions: request ? currentSourceOptions(request) : []
    });

    if (!request) {
      return;
    }

    detailRoot.querySelectorAll("[data-action='pick-source']").forEach((button) => {
      button.addEventListener("click", () => {
        const sourceIndex = Number.parseInt(button.dataset.sourceIndex || "-1", 10);
        const source = currentSourceOptions(request)[sourceIndex];
        if (!source) {
          setFlash("bad", "That source option is no longer available.");
          return;
        }
        selectedSourceByRequest.set(request.id, `${normalizeString(source.providerId)}::${normalizeString(source.titleUrl)}`);
        renderDetail();
      });
    });

    detailRoot.querySelector("[data-action='refresh-sources']")?.addEventListener("click", async () => {
      const result = await api.post(`/api/moon/v3/admin/requests/${encodeURIComponent(request.id)}/refresh-sources`, {});
      setFlash(result.ok ? "good" : "bad", result.ok
        ? (normalizeArray(result.payload?.results).length
          ? "Source check updated. This request is back in admin review."
          : "Source check ran, but no enabled download provider matches it yet.")
        : result.payload?.error || "Unable to refresh source options.");
      await rerender();
    });

    detailRoot.querySelector("[data-action='approve-request']")?.addEventListener("click", async () => {
      const sourceKey = currentSourceKey(request);
      const selectedDownload = currentSourceOptions(request).find((entry) =>
        `${normalizeString(entry.providerId)}::${normalizeString(entry.titleUrl)}` === sourceKey
      ) || request.details?.selectedDownload || null;
      if (!selectedDownload?.titleUrl) {
        setFlash("bad", "Pick a concrete download source before approving this request.");
        return;
      }
      const comment = window.prompt("Approval note for this request:", "Approved from Moon admin.");
      if (comment == null) {
        return;
      }
      const result = await api.post(`/api/moon/v3/admin/requests/${encodeURIComponent(request.id)}/approve`, {
        comment,
        selectedMetadata: request.details?.selectedMetadata,
        selectedDownload
      });
      setFlash(result.ok ? "good" : "bad", result.ok
        ? "Request approved and queued."
        : result.payload?.error || "Unable to approve this request.");
      await rerender();
    });

    detailRoot.querySelector("[data-action='deny-request']")?.addEventListener("click", async () => {
      const comment = window.prompt("Reason for denying this request:", "Denied from Moon admin.");
      if (comment == null) {
        return;
      }
      const result = await api.post(`/api/moon/admin/requests/${encodeURIComponent(request.id)}/review`, {
        status: "denied",
        comment
      });
      setFlash(result.ok ? "good" : "bad", result.ok
        ? "Request was denied."
        : result.payload?.error || "Unable to deny this request.");
      await rerender();
    });

    detailRoot.querySelector("[data-action='override-request']")?.addEventListener("click", async () => {
      const query = window.prompt("Search query for the replacement metadata match:", request.details?.query || request.title || "");
      if (query == null) {
        return;
      }

      const metadataSearch = await api.get(`/api/moon/v3/admin/requests/metadata-search?query=${encodeURIComponent(query)}`);
      const metadata = await chooseOption({
        title: "Pick the metadata match you want to save:",
        entries: metadataSearch.payload?.results,
        renderEntry: (entry) => `${normalizeString(entry.title, "Untitled")} | ${normalizeString(entry.providerName || entry.provider, "metadata")} | ${normalizeString(entry.type, "manga")}`
      });
      if (!metadata) {
        setFlash("bad", metadataSearch.ok
          ? "Moon admin needs an exact metadata match before it can override the request."
          : metadataSearch.payload?.error || "Unable to search metadata right now.");
        return;
      }

      const downloads = await api.post("/api/moon/v3/admin/requests/download-options", {
        query,
        selectedMetadata: metadata
      });
      let selectedDownload = null;
      if (normalizeArray(downloads.payload?.results).length) {
        selectedDownload = await chooseOption({
          title: "Pick the concrete download match to save:",
          entries: downloads.payload?.results,
          renderEntry: (entry) => `${normalizeString(entry.titleName || entry.title, "Untitled")} | ${normalizeString(entry.providerName || entry.providerId, "download")} | ${normalizeString(entry.titleUrl)}`
        });
        if (!selectedDownload) {
          setFlash("bad", "Pick a concrete download match or cancel the override.");
          return;
        }
      } else {
        const keepUnavailable = window.confirm("No concrete download match was found. Save this override as unavailable?");
        if (!keepUnavailable) {
          return;
        }
      }

      const notes = window.prompt("Optional moderation notes for this override:", request.notes || "") || "";
      const result = await api.post(`/api/moon/v3/admin/requests/${encodeURIComponent(request.id)}/override`, {
        query,
        notes,
        selectedMetadata: metadata,
        ...(selectedDownload ? {selectedDownload} : {})
      });
      setFlash(result.ok ? "good" : "bad", result.ok
        ? (selectedDownload?.titleUrl ? "Request override saved. Approve it when you are ready to queue it." : "Request override saved as unavailable.")
        : result.payload?.error || "Unable to save the override.");
      await rerender();
    });
  };

  const runBulkAction = async (action) => {
    const targets = normalizeArray(requests).filter((entry) => selectedIds.has(entry.id));
    if (!targets.length) {
      setFlash("bad", "Select one or more requests first.");
      return;
    }

    if (action === "deny") {
      const comment = window.prompt("Reason for denying these requests:", "Denied from Moon admin.");
      if (comment == null) {
        return;
      }
      let successCount = 0;
      for (const request of targets.filter((entry) => ["pending", "unavailable"].includes(normalizeString(entry.status)))) {
        const result = await api.post(`/api/moon/admin/requests/${encodeURIComponent(request.id)}/review`, {
          status: "denied",
          comment
        });
        if (result.ok) {
          successCount += 1;
        }
      }
      setFlash(successCount ? "good" : "bad", successCount
        ? `Denied ${successCount} request${successCount === 1 ? "" : "s"}.`
        : "No selected requests could be denied.");
      await rerender();
      return;
    }

    if (action === "refresh") {
      let successCount = 0;
      for (const request of targets.filter((entry) => normalizeString(entry.status) === "unavailable")) {
        const result = await api.post(`/api/moon/v3/admin/requests/${encodeURIComponent(request.id)}/refresh-sources`, {});
        if (result.ok) {
          successCount += 1;
        }
      }
      setFlash(successCount ? "good" : "bad", successCount
        ? `Refreshed sources for ${successCount} request${successCount === 1 ? "" : "s"}.`
        : "No selected unavailable requests could be refreshed.");
      await rerender();
      return;
    }

    if (action === "approve") {
      const comment = window.prompt("Approval note for these requests:", "Approved from Moon admin.");
      if (comment == null) {
        return;
      }
      let successCount = 0;
      for (const request of targets) {
        const sourceKey = currentSourceKey(request);
        const selectedDownload = currentSourceOptions(request).find((entry) =>
          `${normalizeString(entry.providerId)}::${normalizeString(entry.titleUrl)}` === sourceKey
        ) || request.details?.selectedDownload || null;
        if (!selectedDownload?.titleUrl) {
          continue;
        }
        const result = await api.post(`/api/moon/v3/admin/requests/${encodeURIComponent(request.id)}/approve`, {
          comment,
          selectedMetadata: request.details?.selectedMetadata,
          selectedDownload
        });
        if (result.ok) {
          successCount += 1;
        }
      }
      setFlash(successCount ? "good" : "bad", successCount
        ? `Approved ${successCount} request${successCount === 1 ? "" : "s"}.`
        : "No selected requests had a concrete source ready for approval.");
      await rerender();
    }
  };

  root.querySelectorAll("[data-filter-id]").forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filterId || "all";
      root.querySelectorAll("[data-filter-id]").forEach((node) => node.classList.toggle("is-active-filter", node === button));
      renderList();
      renderDetail();
    });
  });

  searchInput?.addEventListener("input", () => {
    searchValue = searchInput.value || "";
    renderList();
    renderDetail();
  });

  root.querySelectorAll("[data-bulk-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      await runBulkAction(button.dataset.bulkAction || "");
    });
  });

  renderList();
  renderDetail();
};

export default {
  loadRequestsPage,
  renderRequestsPage,
  enhanceRequestsPage
};
