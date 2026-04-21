import {escapeHtml, renderChipList, renderCoverThumb, renderEmptyState, renderStatusBadge} from "../dom.js";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

/**
 * Resolve the representative metadata match from a grouped intake result.
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
 * Resolve the concrete download target from a grouped intake result.
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
 * Resolve the stable work identity from a grouped Raven intake result.
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
 * Normalize a grouped intake result into a consistent Moon admin shape.
 *
 * @param {Record<string, any>} entry
 * @returns {{
 *   metadata: Record<string, any>,
 *   download: Record<string, any> | null,
 *   targetIdentity: Record<string, any> | null,
 *   title: string,
 *   editionLabel: string,
 *   availability: string,
 *   type: string,
 *   requestType: string,
 *   coverUrl: string,
 *   aliases: string[]
 * }}
 */
const normalizeIntakeResult = (entry) => {
  const metadata = resolveMetadata(entry);
  const download = resolveDownload(entry);
  const title = normalizeString(
    entry.displayTitle
    || entry.title
    || entry.canonicalTitle
    || entry.baseTitle
    || metadata.title
    || download?.titleName,
    "Untitled match"
  );
  const editionLabel = normalizeString(
    entry.editionLabel
    || entry.variantLabel
    || entry.variantSummary
    || entry.subtitle
    || entry.targetIdentity?.editionLabel
  );
  return {
    metadata,
    download,
    targetIdentity: resolveTargetIdentity(entry, download),
    title,
    editionLabel,
    availability: normalizeString(entry.availability, "unavailable"),
    type: normalizeString(entry.type || metadata.type || metadata.libraryTypeLabel || "manga"),
    requestType: normalizeString(download?.requestType || entry.requestType || metadata.type, "manga"),
    coverUrl: normalizeString(entry.coverUrl || download?.coverUrl || metadata.coverUrl),
    aliases: normalizeArray(entry.aliases || metadata.aliases).filter(Boolean).slice(0, 5)
  };
};

/**
 * Load add-title search results for the current query string.
 *
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   searchParams: URLSearchParams
 * }} context
 * @returns {Promise<import("../api.js").ApiResult & {query: string}>}
 */
export const loadAddPage = async ({api, searchParams}) => {
  const query = searchParams.get("q") || "";
  if (!query) {
    return {
      ok: true,
      status: 200,
      payload: {query: "", results: []},
      query
    };
  }

  const result = await api.get(`/api/moon/v3/admin/add/search?query=${encodeURIComponent(query)}`);
  return {...result, query};
};

const renderResultCard = (entry, index) => {
  const normalized = normalizeIntakeResult(entry);
  const metadata = normalized.metadata;
  const download = normalized.download;
  const ready = ["available", "download-ready"].includes(normalized.availability) && download?.titleUrl;
  const detailChips = [
    normalized.editionLabel,
    normalized.type
  ].filter((value) => {
    const normalizedValue = normalizeString(value).toLowerCase();
    return normalizedValue && !normalized.title.toLowerCase().includes(normalizedValue);
  });

  return `
    <article class="stack-card intake-card ${ready ? "is-ready" : "is-unavailable"}">
      <div class="list-card-head with-cover">
        ${renderCoverThumb(normalized.coverUrl, normalized.title)}
        <div class="list-card-copy">
          <div>
            <strong>${escapeHtml(normalized.title)}</strong>
            <span>${escapeHtml(metadata.provider || entry.metadataProviderId || "metadata")} -> ${escapeHtml(download?.providerName || "No download match yet")}</span>
            ${detailChips.length ? renderChipList(detailChips) : ""}
          </div>
        </div>
        ${renderStatusBadge(ready ? "Ready" : "Unavailable")}
      </div>
      <p>${escapeHtml(metadata.summary || "No metadata summary was returned for this match.")}</p>
      ${normalized.aliases.length ? renderChipList(normalized.aliases) : ""}
      <div class="inline-note">
        <strong>${escapeHtml(normalized.type)}</strong>
        <span>${escapeHtml(download?.titleName || "No enabled download provider match yet")}</span>
      </div>
      <button class="solid-button" type="button" data-action="queue-title" data-result-index="${escapeHtml(index)}">
        ${ready ? "Queue immediately" : "Save as unavailable"}
      </button>
    </article>
  `;
};

/**
 * Render the add-title page.
 *
 * @param {Awaited<ReturnType<typeof loadAddPage>>} result
 * @returns {string}
 */
export const renderAddPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Search unavailable", result.payload?.error || "Raven intake is not available right now.");
  }

  const results = normalizeArray(result.payload?.results);

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Raven intake</span>
          <h2>Search metadata and resolve downloads</h2>
        </div>
      </div>
      <form id="admin-add-search-form" class="toolbar-form">
        <input type="search" id="admin-add-query" name="query" value="${escapeHtml(result.query || "")}" placeholder="Search configured metadata providers" required>
        <button class="solid-button" type="submit">Search</button>
      </form>
      <label class="compact-field">
        <span>Admin note</span>
        <textarea id="admin-add-notes" placeholder="Optional audit note for why this title is being added"></textarea>
      </label>
      <div class="inline-note">
        <strong>Queue behavior</strong>
        <p>Admins use the same intake engine as members. Download-ready results create a request record and queue Raven immediately. Metadata-only matches are saved as unavailable so they can be resolved later.</p>
      </div>
      ${results.length
        ? `<div class="stack-list">${results.map(renderResultCard).join("")}</div>`
        : renderEmptyState("Search for a title", "Use the search box to find a metadata match first, then let Scriptarr check the enabled download providers.")}
      <div class="inline-note" id="admin-add-feedback"></div>
    </section>
  `;
};

/**
 * Wire the add-title search and queue actions.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   navigate: (path: string) => void,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @param {Awaited<ReturnType<typeof loadAddPage>>} result
 * @returns {Promise<void>}
 */
export const enhanceAddPage = async (root, {api, navigate, rerender, setFlash}, result) => {
  const searchResults = normalizeArray(result.payload?.results);

  root.querySelector("#admin-add-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = root.querySelector("#admin-add-query")?.value.trim() || "";
    navigate(query ? `/admin/add?q=${encodeURIComponent(query)}` : "/admin/add");
  });

  root.querySelectorAll("[data-action='queue-title']").forEach((button) => {
    button.addEventListener("click", async () => {
      const resultIndex = Number.parseInt(button.dataset.resultIndex || "-1", 10);
      const selected = searchResults[resultIndex];
      if (!selected) {
        setFlash("bad", "That intake result is no longer available.");
        return;
      }
      const normalized = normalizeIntakeResult(selected);

      const response = await api.post("/api/moon/v3/admin/add/queue", {
        query: root.querySelector("#admin-add-query")?.value.trim() || "",
        title: normalized.title,
        requestType: normalized.requestType,
        notes: root.querySelector("#admin-add-notes")?.value || "",
        selectedMetadata: normalized.metadata,
        selectedDownload: normalized.download || null,
        ...(normalized.targetIdentity ? {targetIdentity: normalized.targetIdentity} : {})
      });

      setFlash(
        response.ok ? "good" : "bad",
        response.ok
          ? (normalized.download?.titleUrl
            ? "Request created and queued into Raven."
            : "Request saved as unavailable for later resolution.")
          : response.payload?.error || "Unable to queue the selected title."
      );
      await rerender();
    });
  });
};

export default {
  loadAddPage,
  renderAddPage,
  enhanceAddPage
};
