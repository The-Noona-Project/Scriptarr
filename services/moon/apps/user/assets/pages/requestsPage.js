import {escapeHtml, renderChipList, renderCoverArt, renderEmptyState} from "../dom.js";
import {formatDate} from "../format.js";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};
const renderStatusBadge = (value) => `<span class="status-pill">${escapeHtml(value)}</span>`;

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
 * Resolve a stable target identity if Raven already grouped this result.
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
 * Normalize a grouped intake result into a consistent Moon-facing shape.
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
  const aliases = normalizeArray(entry.aliases || metadata.aliases)
    .filter(Boolean)
    .slice(0, 5);
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
    aliases
  };
};

/**
 * Load the current user's request list and optional intake-search results.
 *
 * @param {{
 *   api: ReturnType<import("../api.js").createUserApi>,
 *   searchParams: URLSearchParams
 * }} context
 * @returns {Promise<import("../api.js").ApiResult & {query: string}>}
 */
export const loadRequestsPage = async ({api, searchParams}) => {
  const query = searchParams.get("q") || "";
  const [requestsResult, searchResult] = await Promise.all([
    api.get("/api/moon/v3/user/requests"),
    query
      ? api.get(`/api/moon/v3/user/requests/search?query=${encodeURIComponent(query)}`)
      : Promise.resolve({
        ok: true,
        status: 200,
        payload: {query: "", results: []}
      })
  ]);

  if (!requestsResult.ok) {
    return {...requestsResult, query};
  }

  return {
    ok: true,
    status: 200,
    payload: {
      requests: requestsResult.payload?.requests || [],
      search: searchResult.ok ? searchResult.payload : {query, results: []}
    },
    query
  };
};

const renderIntakeResult = (entry, index) => {
  const normalized = normalizeIntakeResult(entry);
  const metadata = normalized.metadata;
  const download = normalized.download;
  const isAvailable = ["available", "download-ready"].includes(normalized.availability) && download?.titleUrl;
  const detailChips = [
    normalized.editionLabel,
    normalized.type
  ].filter((value) => {
    const normalizedValue = normalizeString(value).toLowerCase();
    return normalizedValue && !normalized.title.toLowerCase().includes(normalizedValue);
  });

  return `
    <article class="stack-card intake-card ${isAvailable ? "is-ready" : "is-unavailable"}">
      <div class="list-card-head with-cover">
        ${renderCoverArt(normalized.coverUrl, normalized.title, "request-cover-art")}
        <div class="list-card-copy">
          <strong>${escapeHtml(normalized.title)}</strong>
          <span>${escapeHtml(metadata.provider || entry.metadataProviderId || "metadata")} -> ${escapeHtml(download?.providerName || "No download match yet")}</span>
          ${detailChips.length ? renderChipList(detailChips) : ""}
        </div>
        ${renderStatusBadge(isAvailable ? "Ready" : "Unavailable")}
      </div>
      <p>${escapeHtml(metadata.summary || "No metadata summary was returned for this match.")}</p>
      ${normalized.aliases.length ? renderChipList(normalized.aliases) : ""}
      <div class="inline-note">
        <strong>${escapeHtml(normalized.type)}</strong>
        <span>${escapeHtml(download?.titleName || "No enabled download provider match yet")}</span>
      </div>
      <button class="solid-button" type="button" data-intake-action="submit-request" data-result-index="${escapeHtml(index)}">
        ${isAvailable ? "Send to moderation" : "Save as unavailable"}
      </button>
    </article>
  `;
};

/**
 * Render the current user's request page.
 *
 * @param {Awaited<ReturnType<typeof loadRequestsPage>>} result
 * @returns {string}
 */
export const renderRequestsPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Requests unavailable", result.payload?.error || "Sign in before creating or tracking requests.");
  }

  const requests = normalizeArray(result.payload?.requests);
  const search = result.payload?.search || {query: "", results: []};
  const searchResults = normalizeArray(search.results);

  return `
    <div class="content-grid two-up">
      <section class="panel-section">
        <div class="section-head">
          <div>
            <span class="section-kicker">Request something</span>
            <h2>Search metadata, then submit</h2>
          </div>
        </div>
        <form id="user-request-search-form" class="toolbar-form">
          <input id="request-search-query" type="search" value="${escapeHtml(result.query || "")}" placeholder="Search for a series title" required>
          <button class="solid-button" type="submit">Search</button>
        </form>
        <label class="compact-field">
          <span>Notes for moderators</span>
          <textarea id="request-notes" placeholder="Optional notes about the version, translation, or why you want this title"></textarea>
        </label>
        <div class="inline-note">
          <strong>How it works</strong>
          <p>Moon searches enabled metadata providers first, then checks whether any enabled download provider can actually fetch the title. If nothing is downloadable yet, you can still save an unavailable request for later resolution.</p>
        </div>
        ${searchResults.length
          ? `<div class="stack-list">${searchResults.map(renderIntakeResult).join("")}</div>`
          : renderEmptyState("Search for a title", "Pick a concrete intake result so moderators know exactly what should be queued in Raven.")}
      </section>
      <section class="panel-section">
        <div class="section-head">
          <div>
            <span class="section-kicker">My queue</span>
            <h2>Request history</h2>
          </div>
        </div>
        ${requests.length
          ? `
            <div class="stack-list">
              ${requests.map((entry) => `
                <article class="stack-card">
                  <div class="list-card-head with-cover">
                    ${renderCoverArt(entry.coverUrl, entry.title, "request-cover-art")}
                    <div class="list-card-copy">
                      <strong>${escapeHtml(entry.title)}</strong>
                      <span>${escapeHtml(formatDate(entry.updatedAt, {includeTime: true}))}</span>
                    </div>
                    ${renderStatusBadge(entry.status)}
                  </div>
                  <p>${escapeHtml(entry.notes || entry.details?.query || "No notes")}</p>
                  <div class="inline-note">
                    <strong>${escapeHtml(entry.details?.selectedMetadata?.provider || "metadata")}</strong>
                    <span>${escapeHtml(entry.details?.selectedDownload?.providerName || entry.availability || "pending")}</span>
                  </div>
                </article>
              `).join("")}
            </div>
          `
          : renderEmptyState("No requests yet", "Requests you submit here or through Discord will show up in the same moderation timeline.")}
      </section>
    </div>
  `;
};

/**
 * Wire the request search and create actions.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createUserApi>,
 *   navigate: (path: string) => void,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @param {Awaited<ReturnType<typeof loadRequestsPage>>} result
 * @returns {Promise<void>}
 */
export const enhanceRequestsPage = async (root, {navigate, api, rerender, setFlash}, result) => {
  const searchResults = normalizeArray(result.payload?.search?.results);

  root.querySelector("#user-request-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = root.querySelector("#request-search-query")?.value.trim() || "";
    navigate(query ? `/myrequests?q=${encodeURIComponent(query)}` : "/myrequests");
  });

  root.querySelectorAll("[data-intake-action='submit-request']").forEach((button) => {
    button.addEventListener("click", async () => {
      const resultIndex = Number.parseInt(button.dataset.resultIndex || "-1", 10);
      const selected = searchResults[resultIndex];
      if (!selected) {
        setFlash("bad", "That intake result is no longer available.");
        return;
      }
      const normalized = normalizeIntakeResult(selected);

      const response = await api.post("/api/moon/v3/user/requests", {
        query: root.querySelector("#request-search-query")?.value.trim() || "",
        title: normalized.title,
        requestType: normalized.requestType,
        notes: root.querySelector("#request-notes")?.value || "",
        selectedMetadata: normalized.metadata,
        selectedDownload: normalized.download || null,
        ...(normalized.targetIdentity ? {targetIdentity: normalized.targetIdentity} : {})
      });

      setFlash(
        response.ok ? "good" : "bad",
        response.ok
          ? (normalized.download?.titleUrl
            ? "Request created and sent to moderation."
            : "Unavailable request saved for later resolution.")
          : response.payload?.error || "Unable to create your request."
      );
      await rerender();
    });
  });
};

export default {
  loadRequestsPage,
  renderRequestsPage,
  enhanceRequestsPage
};
