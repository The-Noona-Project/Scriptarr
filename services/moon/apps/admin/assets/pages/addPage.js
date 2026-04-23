import {escapeHtml, renderChipList, renderCoverThumb, renderEmptyState, renderStatusBadge} from "../dom.js";

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const encodeDataValue = (value) => encodeURIComponent(JSON.stringify(value));
const decodeDataValue = (value) => {
  try {
    return JSON.parse(decodeURIComponent(value || ""));
  } catch {
    return null;
  }
};

const renderMetadataCard = (entry, index) => `
  <article class="stack-card intake-card">
    <div class="list-card-head with-cover">
      ${renderCoverThumb(entry.coverUrl, entry.title)}
      <div class="list-card-copy">
        <div>
          <strong>${escapeHtml(entry.title || "Untitled")}</strong>
          <span>${escapeHtml(entry.providerName || entry.provider || "metadata")} · ${escapeHtml(entry.type || "manga")}</span>
          ${renderChipList(normalizeArray(entry.tags).slice(0, 8))}
        </div>
      </div>
    </div>
    <p>${escapeHtml(entry.summary || "No metadata summary was returned for this match.")}</p>
    ${normalizeArray(entry.aliases).length ? `<div class="inline-note"><strong>Aliases</strong><p>${escapeHtml(normalizeArray(entry.aliases).join(", "))}</p></div>` : ""}
    <div class="action-row">
      <button class="solid-button small" type="button" data-action="load-download-options" data-result-index="${escapeHtml(index)}">Pick source</button>
      ${entry.url ? `<a class="ghost-button small" href="${escapeHtml(entry.url)}" target="_blank" rel="noreferrer">Open metadata</a>` : ""}
    </div>
  </article>
`;

const renderSourceCard = (entry, index) => `
  <article class="stack-card intake-card ${normalizeString(entry.titleUrl) ? "is-ready" : "is-unavailable"}">
    <div class="list-card-head">
      <div class="list-card-copy">
        <div>
          <strong>${escapeHtml(entry.titleName || "Untitled source")}</strong>
          <span>${escapeHtml(entry.providerName || entry.providerId || "download")} · ${escapeHtml(entry.libraryTypeLabel || entry.requestType || "Manga")}</span>
          ${renderChipList([
            normalizeString(entry.confidenceBand),
            ...normalizeArray(entry.tags).slice(0, 5)
          ].filter(Boolean))}
        </div>
      </div>
      ${renderStatusBadge(entry.availability || "available")}
    </div>
    <p>${escapeHtml(entry.sourceUrl || entry.titleUrl || "No upstream source URL was returned.")}</p>
    ${normalizeArray(entry.warnings).length ? `<div class="inline-note"><strong>Warnings</strong><p>${escapeHtml(normalizeArray(entry.warnings).join(" · "))}</p></div>` : ""}
    <button class="solid-button small" type="button" data-action="queue-with-source" data-source-index="${escapeHtml(index)}">Queue this source</button>
  </article>
`;

const renderSourceStage = (metadata = null, sourceResults = [], loading = false) => {
  if (!metadata) {
    return renderEmptyState(
      "Pick metadata first",
      "Search metadata, choose the exact title, then Scriptarr will resolve the concrete download providers for you to review."
    );
  }

  if (loading) {
    return `
      <section class="callout subtle">
        <strong>Checking download providers</strong>
        <p>Moon is resolving enabled download providers against the metadata title and aliases.</p>
      </section>
    `;
  }

  const results = normalizeArray(sourceResults);
  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Selected metadata</span>
          <h2>${escapeHtml(metadata.title || "Untitled")}</h2>
        </div>
        ${metadata.url ? `<a class="ghost-button small" href="${escapeHtml(metadata.url)}" target="_blank" rel="noreferrer">Open metadata</a>` : ""}
      </div>
      ${results.length
        ? `<div class="stack-list">${results.map(renderSourceCard).join("")}</div>`
        : `
          <section class="callout warn">
            <strong>No source yet</strong>
            <p>No enabled download provider currently matches this metadata title. You can still save it as unavailable for admin review later.</p>
            <div class="action-row">
              <button class="solid-button small" type="button" data-action="queue-unavailable">Save as unavailable</button>
            </div>
          </section>
        `}
    </section>
  `;
};

/**
 * Load add-title metadata search results for the current query string.
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

  const result = await api.get(`/api/moon/v3/admin/add/metadata-search?query=${encodeURIComponent(query)}`);
  return {...result, query};
};

/**
 * Render the add-title page.
 *
 * @param {Awaited<ReturnType<typeof loadAddPage>>} result
 * @returns {string}
 */
export const renderAddPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Search unavailable", result.payload?.error || "Raven metadata search is not available right now.");
  }

  const results = normalizeArray(result.payload?.results);

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Admin queue</span>
          <h2>Add new title</h2>
        </div>
      </div>
      <form id="admin-add-search-form" class="toolbar-form">
        <input type="search" id="admin-add-query" name="query" value="${escapeHtml(result.query || "")}" placeholder="Search configured metadata providers" required>
        <button class="solid-button" type="submit">Search metadata</button>
      </form>
      <label class="compact-field">
        <span>Admin note</span>
        <textarea id="admin-add-notes" placeholder="Optional audit note for why this title is being added"></textarea>
      </label>
      <div class="callout subtle">
        <strong>Admin flow</strong>
        <p>Pick metadata first, inspect the metadata site if needed, then choose the exact download source you want Raven to queue. Duplicate and already-in-library targets stay blocked unless you use repair tools instead.</p>
      </div>
      ${results.length
        ? `<div class="content-grid two-up">
            <section class="panel-section">
              <div class="section-heading">
                <div>
                  <span class="section-kicker">Step 1</span>
                  <h2>Pick metadata</h2>
                </div>
              </div>
              <div class="stack-list" id="admin-add-metadata-list">
                ${results.map(renderMetadataCard).join("")}
              </div>
            </section>
            <section id="admin-add-source-stage">
              ${renderSourceStage()}
            </section>
          </div>`
        : renderEmptyState("Search for a title", "Search metadata first, then choose the exact download source you want to queue.")}
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
  const metadataResults = normalizeArray(result.payload?.results);
  let selectedMetadata = null;
  let selectedSources = [];

  const sourceStage = root.querySelector("#admin-add-source-stage");
  const feedback = root.querySelector("#admin-add-feedback");

  const renderSourceStageState = (metadata, sourceResults = [], loading = false) => {
    if (!sourceStage) {
      return;
    }
    sourceStage.innerHTML = renderSourceStage(metadata, sourceResults, loading);
    wireSourceActions();
  };

  const setFeedback = (html) => {
    if (feedback) {
      feedback.innerHTML = html;
    }
  };

  const renderDuplicateFeedback = (payload) => {
    if (payload?.code === "REQUEST_ALREADY_IN_LIBRARY") {
      const title = normalizeString(payload.libraryTitle?.title, "This title");
      const link = normalizeString(payload.libraryTitle?.linkUrl);
      setFeedback(link
        ? `<strong>${escapeHtml(title)}</strong> is already in the library. <a class="series-row-link" href="${escapeHtml(link)}" data-link>Open it here</a>.`
        : `<strong>${escapeHtml(title)}</strong> is already in the library.`);
      return;
    }

    if (payload?.code === "REQUEST_ALREADY_QUEUED") {
      const title = normalizeString(payload.title, "This title");
      const link = normalizeString(payload.linkUrl);
      setFeedback(link
        ? `<strong>${escapeHtml(title)}</strong> already has an active request. <a class="series-row-link" href="${escapeHtml(link)}" data-link>Open My Requests</a>.`
        : `<strong>${escapeHtml(title)}</strong> already has an active request.`);
    }
  };

  const queueSelection = async (selectedDownload = null) => {
    if (!selectedMetadata) {
      setFlash("bad", "Pick metadata before you queue anything.");
      return;
    }

    const response = await api.post("/api/moon/v3/admin/add/queue", {
      query: root.querySelector("#admin-add-query")?.value.trim() || "",
      title: selectedMetadata.title,
      requestType: selectedDownload?.requestType || selectedMetadata.type || "manga",
      notes: root.querySelector("#admin-add-notes")?.value || "",
      selectedMetadata,
      ...(selectedDownload ? {selectedDownload} : {})
    });

    if (!response.ok && response.status === 409) {
      renderDuplicateFeedback(response.payload);
    } else {
      setFeedback("");
    }

    setFlash(
      response.ok ? "good" : "bad",
      response.ok
        ? (selectedDownload?.titleUrl
          ? "Request created and queued into Raven."
          : "Request saved as unavailable for later review.")
        : response.payload?.error || "Unable to queue the selected title."
    );
    await rerender();
  };

  const wireSourceActions = () => {
    sourceStage?.querySelectorAll("[data-action='queue-with-source']").forEach((button) => {
      button.addEventListener("click", async () => {
        const sourceIndex = Number.parseInt(button.dataset.sourceIndex || "-1", 10);
        const selectedDownload = selectedSources[sourceIndex];
        if (!selectedDownload) {
          setFlash("bad", "That source is no longer available.");
          return;
        }
        await queueSelection(selectedDownload);
      });
    });

    sourceStage?.querySelector("[data-action='queue-unavailable']")?.addEventListener("click", async () => {
      await queueSelection(null);
    });
  };

  root.querySelector("#admin-add-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = root.querySelector("#admin-add-query")?.value.trim() || "";
    navigate(query ? `/admin/add?q=${encodeURIComponent(query)}` : "/admin/add");
  });

  root.querySelectorAll("[data-action='load-download-options']").forEach((button) => {
    button.addEventListener("click", async () => {
      const resultIndex = Number.parseInt(button.dataset.resultIndex || "-1", 10);
      const metadata = metadataResults[resultIndex];
      if (!metadata) {
        setFlash("bad", "That metadata result is no longer available.");
        return;
      }

      selectedMetadata = metadata;
      selectedSources = [];
      setFeedback("");
      renderSourceStageState(selectedMetadata, [], true);

      const response = await api.post("/api/moon/v3/admin/add/download-options", {
        query: root.querySelector("#admin-add-query")?.value.trim() || "",
        selectedMetadata
      });
      if (!response.ok) {
        renderSourceStageState(selectedMetadata, []);
        setFlash("bad", response.payload?.error || "Unable to load download options.");
        return;
      }

      selectedSources = normalizeArray(response.payload?.results);
      renderSourceStageState(selectedMetadata, selectedSources, false);
      if (!selectedSources.length) {
        setFlash("warn", "No enabled download provider matches this metadata title right now. You can still save it as unavailable.");
      }
    });
  });
};

export default {
  loadAddPage,
  renderAddPage,
  enhanceAddPage
};
