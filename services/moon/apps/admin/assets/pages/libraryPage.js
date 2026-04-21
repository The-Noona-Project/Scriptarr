import {
  escapeHtml,
  renderChip,
  renderCoverThumb,
  renderEmptyState,
  renderStatusBadge
} from "../dom.js";
import {formatDate} from "../format.js";

const DEFAULT_LIBRARY_STATE = Object.freeze({
  query: "",
  type: "all",
  status: "all",
  sort: "title-asc"
});

/**
 * Load the admin library payload.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadLibraryPage = ({api}) => api.get("/api/moon/v3/admin/library");

/**
 * Normalize an admin library title payload for rendering and sorting.
 *
 * @param {Record<string, any>} title
 * @returns {Record<string, any>}
 */
const normalizeLibraryTitle = (title = {}) => {
  const chapterCount = Number.parseInt(String(title.chapterCount || 0), 10) || 0;
  const chaptersDownloaded = Number.parseInt(String(title.chaptersDownloaded || 0), 10) || 0;
  const coveragePercent = chapterCount > 0 ? Math.round((chaptersDownloaded / chapterCount) * 100) : 0;
  const latestReleaseDate = Array.isArray(title.chapters)
    ? title.chapters
      .map((chapter) => chapter?.releaseDate || "")
      .filter(Boolean)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || ""
    : "";
  return {
    ...title,
    title: String(title.title || "Untitled").trim() || "Untitled",
    mediaType: String(title.mediaType || "manga").trim() || "manga",
    libraryTypeLabel: String(title.libraryTypeLabel || title.mediaType || "Manga").trim() || "Manga",
    libraryTypeSlug: String(title.libraryTypeSlug || title.mediaType || "manga").trim() || "manga",
    status: String(title.status || "active").trim() || "active",
    latestChapter: String(title.latestChapter || "Unknown").trim() || "Unknown",
    metadataProvider: String(title.metadataProvider || "").trim(),
    author: String(title.author || "").trim(),
    summary: String(title.summary || "").trim(),
    sourceUrl: String(title.sourceUrl || "").trim(),
    workingRoot: String(title.workingRoot || "").trim(),
    downloadRoot: String(title.downloadRoot || "").trim(),
    chapterCount,
    chaptersDownloaded,
    coveragePercent,
    latestReleaseDate
  };
};

/**
 * Test whether a title matches the current filter state.
 *
 * @param {Record<string, any>} title
 * @param {{query: string, type: string, status: string}} state
 * @returns {boolean}
 */
const matchesLibraryState = (title, state) => {
  const query = String(state.query || "").trim().toLowerCase();
  const type = String(state.type || "all");
  const status = String(state.status || "all");

  if (type !== "all" && title.libraryTypeSlug !== type) {
    return false;
  }
  if (status !== "all" && title.status !== status) {
    return false;
  }
  if (!query) {
    return true;
  }

  const searchable = [
    title.title,
    title.author,
    title.libraryTypeLabel,
    title.metadataProvider || "unmatched",
    ...(Array.isArray(title.tags) ? title.tags : []),
    ...(Array.isArray(title.aliases) ? title.aliases : [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return searchable.includes(query);
};

/**
 * Sort normalized titles using the active admin sort mode.
 *
 * @param {Record<string, any>[]} titles
 * @param {string} sort
 * @returns {Record<string, any>[]}
 */
const sortLibraryTitles = (titles, sort) => {
  const sortable = [...titles];
  const compareString = (left, right) => left.localeCompare(right, undefined, {numeric: true, sensitivity: "base"});
  const compareDate = (left, right) => (Date.parse(left || "") || 0) - (Date.parse(right || "") || 0);
  const compareNumber = (left, right) => Number(left || 0) - Number(right || 0);

  sortable.sort((left, right) => {
    switch (sort) {
      case "coverage-desc":
        return compareNumber(right.coveragePercent, left.coveragePercent) || compareString(left.title, right.title);
      case "coverage-asc":
        return compareNumber(left.coveragePercent, right.coveragePercent) || compareString(left.title, right.title);
      case "latest-desc":
        return compareNumber(right.latestChapter, left.latestChapter) || compareString(left.title, right.title);
      case "release-desc":
        return compareDate(right.latestReleaseDate, left.latestReleaseDate) || compareString(left.title, right.title);
      case "release-asc":
        return compareDate(left.latestReleaseDate, right.latestReleaseDate) || compareString(left.title, right.title);
      case "provider-asc":
        return compareString(left.metadataProvider || "zzz", right.metadataProvider || "zzz") || compareString(left.title, right.title);
      case "status-asc":
        return compareString(left.status, right.status) || compareString(left.title, right.title);
      default:
        return compareString(left.title, right.title);
    }
  });
  return sortable;
};

/**
 * Build the filtered and sorted admin library rows for rendering.
 *
 * @param {Record<string, any>[]} titles
 * @param {typeof DEFAULT_LIBRARY_STATE} state
 * @returns {Record<string, any>[]}
 */
const buildVisibleTitles = (titles, state) => sortLibraryTitles(
  titles.filter((title) => matchesLibraryState(title, state)),
  state.sort
);

/**
 * Render a single admin library row.
 *
 * @param {Record<string, any>} title
 * @returns {string}
 */
const renderLibraryRow = (title) => {
  const path = title.downloadRoot || title.workingRoot || "Path pending";
  const titleHref = `/title/${encodeURIComponent(title.libraryTypeSlug)}/${encodeURIComponent(title.id)}`;
  return `
    <tr>
      <td>
        <div class="series-row-title">
          ${renderCoverThumb(title.coverUrl, title.title, "cover-thumb series-cover-thumb")}
          <div class="series-row-copy">
            <div class="series-row-heading">
              <a class="series-row-link" href="${escapeHtml(titleHref)}" target="_blank" rel="noreferrer">${escapeHtml(title.title)}</a>
            </div>
            <div class="series-row-meta">
              ${renderChip(title.libraryTypeLabel)}
              ${title.metadataProvider ? renderChip(title.metadataProvider) : renderChip("Unmatched")}
            </div>
            <div class="series-row-summary">${escapeHtml(title.summary || title.author || "No metadata summary yet.")}</div>
          </div>
        </div>
      </td>
      <td>${escapeHtml(title.status)}</td>
      <td>${escapeHtml(title.latestChapter)}</td>
      <td>${escapeHtml(formatDate(title.latestReleaseDate))}</td>
      <td>
        <div class="coverage-cell">
          <div class="coverage-track"><span style="width:${Math.max(0, Math.min(100, title.coveragePercent))}%"></span></div>
          <div class="coverage-copy">${escapeHtml(`${title.chaptersDownloaded}/${title.chapterCount}`)}</div>
        </div>
      </td>
      <td>${title.metadataProvider ? renderStatusBadge("Matched") : renderStatusBadge("Gap")}</td>
      <td><span class="path-copy">${escapeHtml(path)}</span></td>
      <td>
        <div class="library-row-actions">
          <a class="ghost-button small" href="${escapeHtml(titleHref)}" target="_blank" rel="noreferrer">Open</a>
          ${title.sourceUrl ? `<a class="ghost-button small" href="${escapeHtml(title.sourceUrl)}" target="_blank" rel="noreferrer">Source</a>` : ""}
        </div>
      </td>
    </tr>
  `;
};

/**
 * Render the library table body markup.
 *
 * @param {Record<string, any>[]} titles
 * @returns {string}
 */
const renderLibraryTableBody = (titles) => titles.map((title) => renderLibraryRow(title)).join("");

/**
 * Render the admin library page.
 *
 * @param {Awaited<ReturnType<typeof loadLibraryPage>>} result
 * @returns {string}
 */
export const renderLibraryPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Library unavailable", result.payload?.error || "Unable to load Scriptarr library data.");
  }

  const titles = (result.payload?.titles || []).map((title) => normalizeLibraryTitle(title));
  const visibleTitles = buildVisibleTitles(titles, DEFAULT_LIBRARY_STATE);
  const typeOptions = Array.from(new Set(titles.map((title) => title.libraryTypeSlug))).sort();
  const statusOptions = Array.from(new Set(titles.map((title) => title.status))).sort();

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Series</span>
          <h2>Series index</h2>
          <p class="field-note">A dense, sortable library view inspired by the Sonarr series table, tuned for Raven title health, metadata, and file coverage.</p>
        </div>
      </div>
      <div class="series-toolbar">
        <label class="series-toolbar-search">
          <span class="section-kicker">Search</span>
          <input type="search" id="library-search" placeholder="Search title, author, tag, or provider" value="">
        </label>
        <label class="compact-field">
          <span>Type</span>
          <select id="library-type-filter">
            <option value="all">All types</option>
            ${typeOptions.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("")}
          </select>
        </label>
        <label class="compact-field">
          <span>Status</span>
          <select id="library-status-filter">
            <option value="all">All statuses</option>
            ${statusOptions.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join("")}
          </select>
        </label>
        <label class="compact-field">
          <span>Sort</span>
          <select id="library-sort">
            <option value="title-asc">Title A-Z</option>
            <option value="latest-desc">Latest chapter</option>
            <option value="release-desc">Most recent release</option>
            <option value="coverage-desc">Coverage</option>
            <option value="provider-asc">Provider</option>
            <option value="status-asc">Status</option>
          </select>
        </label>
      </div>
      <div class="series-toolbar-summary" id="library-summary">Showing ${visibleTitles.length} of ${titles.length} title(s).</div>
      <div class="table-wrap series-table-wrap">
        <table class="data-table series-index-table">
          <thead>
            <tr>
              <th>Series Title</th>
              <th>Status</th>
              <th>Latest</th>
              <th>Last Release</th>
              <th>Coverage</th>
              <th>Metadata</th>
              <th>Path</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="library-table-body">
            ${visibleTitles.length
              ? renderLibraryTableBody(visibleTitles)
              : `<tr><td colspan="8">${renderEmptyState("Library is empty", "No real titles have been imported yet. This index will stay empty until Raven has real library ingest.")}</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
};

/**
 * Enhance the admin library page with live filtering and sorting.
 *
 * @param {HTMLElement} root
 * @param {any} _context
 * @param {Awaited<ReturnType<typeof loadLibraryPage>>} result
 * @returns {Promise<void>}
 */
export const enhanceLibraryPage = async (root, _context, result) => {
  if (!result.ok) {
    return;
  }

  const titles = (result.payload?.titles || []).map((title) => normalizeLibraryTitle(title));
  const state = {...DEFAULT_LIBRARY_STATE};
  const summary = root.querySelector("#library-summary");
  const body = root.querySelector("#library-table-body");

  /**
   * Re-render the visible rows in the dense library table.
   *
   * @returns {void}
   */
  const renderRows = () => {
    if (!(body instanceof HTMLElement) || !(summary instanceof HTMLElement)) {
      return;
    }
    const visibleTitles = buildVisibleTitles(titles, state);
    summary.textContent = `Showing ${visibleTitles.length} of ${titles.length} title(s).`;
    body.innerHTML = visibleTitles.length
      ? renderLibraryTableBody(visibleTitles)
      : `<tr><td colspan="8">${renderEmptyState("No titles match the current filters", "Try a broader search or clear one of the active filters.")}</td></tr>`;
  };

  root.querySelector("#library-search")?.addEventListener("input", (event) => {
    state.query = event.currentTarget?.value || "";
    renderRows();
  });
  root.querySelector("#library-type-filter")?.addEventListener("change", (event) => {
    state.type = event.currentTarget?.value || "all";
    renderRows();
  });
  root.querySelector("#library-status-filter")?.addEventListener("change", (event) => {
    state.status = event.currentTarget?.value || "all";
    renderRows();
  });
  root.querySelector("#library-sort")?.addEventListener("change", (event) => {
    state.sort = event.currentTarget?.value || "title-asc";
    renderRows();
  });
};

export default {
  loadLibraryPage,
  renderLibraryPage,
  enhanceLibraryPage
};
