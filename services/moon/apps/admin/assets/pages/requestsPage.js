import {escapeHtml, renderChipList, renderCoverThumb, renderEmptyState, renderStatusBadge, renderTable} from "../dom.js";
import {formatDate} from "../format.js";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Resolve the representative metadata entry from a grouped Raven intake result.
 *
 * @param {Record<string, any>} entry
 * @returns {Record<string, any>}
 */
const resolveMetadata = (entry) => entry.selectedMetadata
  || entry.metadata
  || entry.representativeMetadata
  || normalizeArray(entry.metadataMatches)[0]
  || {};

/**
 * Resolve the concrete download target from a grouped Raven intake result.
 *
 * @param {Record<string, any>} entry
 * @returns {Record<string, any> | null}
 */
const resolveDownload = (entry) => entry.selectedDownload
  || entry.download
  || entry.downloadTarget
  || entry.bestDownloadMatch
  || null;

/**
 * Resolve the stable target identity from a grouped Raven intake result.
 *
 * @param {Record<string, any>} entry
 * @param {Record<string, any> | null} download
 * @returns {Record<string, any> | null}
 */
const resolveTargetIdentity = (entry, download) => {
  const explicitIdentity = entry.targetIdentity
    || entry.workIdentity
    || entry.stableTargetIdentity
    || download?.targetIdentity
    || null;
  if (explicitIdentity && typeof explicitIdentity === "object" && !Array.isArray(explicitIdentity)) {
    return explicitIdentity;
  }

  const workKey = normalizeString(entry.workKey || entry.targetWorkKey || download?.workKey);
  const providerId = normalizeString(
    entry.downloadProviderId
    || download?.providerId
    || download?.providerName
  );
  const titleUrl = normalizeString(entry.titleUrl || download?.titleUrl);
  if (!workKey && !providerId && !titleUrl) {
    return null;
  }
  return {
    workKey,
    providerId,
    titleUrl
  };
};

/**
 * Load the moderation request queue.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadRequestsPage = ({api}) => api.get("/api/moon/v3/admin/requests");

const renderRequestSourceCell = (entry) => `
  <div class="stack-list compact-stack">
    <span>${escapeHtml(entry.source)}</span>
    <span>${escapeHtml(entry.details?.selectedMetadata?.provider || "metadata")}</span>
    <span>${escapeHtml(entry.details?.selectedDownload?.providerName || entry.availability || "pending")}</span>
  </div>
`;

const renderActionCell = (entry) => {
  if (entry.status === "pending") {
    return `<div class="action-row">
      <button class="solid-button small" type="button" data-review-action="approved" data-request-id="${escapeHtml(entry.id)}">Approve</button>
      <button class="ghost-button small" type="button" data-review-action="denied" data-request-id="${escapeHtml(entry.id)}">Deny</button>
    </div>`;
  }

  if (entry.status === "unavailable") {
    return `<div class="action-row">
      <button class="solid-button small" type="button" data-review-action="resolve" data-request-id="${escapeHtml(entry.id)}" data-request-query="${escapeHtml(entry.details?.query || entry.title)}">Resolve</button>
      <button class="ghost-button small" type="button" data-review-action="denied" data-request-id="${escapeHtml(entry.id)}">Deny</button>
    </div>`;
  }

  return renderStatusBadge(entry.status);
};

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

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Moderation</span>
          <h2>Unified request queue</h2>
        </div>
      </div>
      ${renderTable({
        columns: ["Title", "Requester", "Source + match", "Status", "Notes", "Updated", "Actions"],
        rows: (result.payload?.requests || []).map((entry) => [
          `<div class="table-title-cell with-cover-row">${renderCoverThumb(entry.coverUrl, entry.title)}<div><strong>${escapeHtml(entry.title)}</strong>${renderChipList([entry.requestType, entry.availability])}</div></div>`,
          escapeHtml(entry.requestedBy?.username || entry.requestedBy?.discordUserId || "Unknown"),
          renderRequestSourceCell(entry),
          renderStatusBadge(entry.status),
          escapeHtml(entry.notes || entry.details?.query || "No notes"),
          escapeHtml(formatDate(entry.updatedAt, {includeTime: true})),
          renderActionCell(entry)
        ]),
        emptyTitle: "No requests yet",
        emptyBody: "Moon and Discord requests will appear here once users start filing them."
      })}
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
  root.querySelectorAll("[data-review-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.reviewAction;
      const requestId = button.dataset.requestId || "";

      if (action === "resolve") {
        const query = button.dataset.requestQuery || "";
        const search = await api.get(`/api/moon/v3/admin/add/search?query=${encodeURIComponent(query)}`);
        const readyMatch = normalizeArray(search.payload?.results).find((entry) => {
          const download = resolveDownload(entry);
          return Boolean(download?.titleUrl);
        });
        if (!readyMatch) {
          setFlash("bad", "No concrete download match is available for this request yet.");
          return;
        }
        const metadata = resolveMetadata(readyMatch);
        const download = resolveDownload(readyMatch);
        const targetIdentity = resolveTargetIdentity(readyMatch, download);

        const result = await api.post(`/api/moon/v3/admin/requests/${encodeURIComponent(requestId)}/resolve`, {
          query,
          title: normalizeString(readyMatch.title || readyMatch.canonicalTitle || metadata.title || download?.titleName),
          selectedMetadata: metadata,
          selectedDownload: download,
          ...(targetIdentity ? {targetIdentity} : {})
        });
        setFlash(result.ok ? "good" : "bad", result.ok
          ? "Unavailable request resolved and queued."
          : result.payload?.error || "Unable to resolve the selected request.");
        await rerender();
        return;
      }

      const comment = window.prompt(
        action === "approved" ? "Approval note for this request:" : "Reason for denying this request:",
        action === "approved" ? "Approved from Moon admin." : "Denied from Moon admin."
      );

      if (comment == null) {
        return;
      }

      const result = await api.post(`/api/moon/admin/requests/${encodeURIComponent(requestId)}/review`, {
        status: action,
        comment
      });

      setFlash(result.ok ? "good" : "bad", result.ok
        ? (action === "approved" ? "Request approved and queued." : "Request was denied.")
        : result.payload?.error || "Unable to update the selected request.");
      await rerender();
    });
  });
};

export default {
  loadRequestsPage,
  renderRequestsPage,
  enhanceRequestsPage
};
