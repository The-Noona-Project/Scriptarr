import {escapeHtml, renderChipList, renderCoverThumb, renderEmptyState, renderStatusBadge} from "../dom.js";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

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
  const metadata = entry.metadata || {};
  const download = entry.download || null;
  const aliases = normalizeArray(entry.aliases || metadata.aliases).filter(Boolean).slice(0, 5);
  const ready = entry.availability === "available" && download?.titleUrl;
  const coverUrl = entry.coverUrl || download?.coverUrl || metadata.coverUrl || "";

  return `
    <article class="stack-card intake-card ${ready ? "is-ready" : "is-unavailable"}">
      <div class="list-card-head with-cover">
        ${renderCoverThumb(coverUrl, entry.canonicalTitle || metadata.title || "Untitled match")}
        <div class="list-card-copy">
          <div>
            <strong>${escapeHtml(entry.canonicalTitle || metadata.title || "Untitled match")}</strong>
            <span>${escapeHtml(metadata.provider || entry.metadataProviderId || "metadata")} -> ${escapeHtml(download?.providerName || "No download match yet")}</span>
          </div>
        </div>
        ${renderStatusBadge(ready ? "Ready" : "Unavailable")}
      </div>
      <p>${escapeHtml(metadata.summary || "No metadata summary was returned for this match.")}</p>
      ${aliases.length ? renderChipList(aliases) : ""}
      <div class="inline-note">
        <strong>${escapeHtml(entry.type || metadata.type || "manga")}</strong>
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

      const response = await api.post("/api/moon/v3/admin/add/queue", {
        query: root.querySelector("#admin-add-query")?.value.trim() || "",
        requestType: selected.download?.requestType || selected.type || "manga",
        notes: root.querySelector("#admin-add-notes")?.value || "",
        selectedMetadata: selected.metadata,
        selectedDownload: selected.download || null
      });

      setFlash(
        response.ok ? "good" : "bad",
        response.ok
          ? (selected.download?.titleUrl
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
