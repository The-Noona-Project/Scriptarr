import {
  escapeHtml,
  renderChip,
  renderCoverThumb,
  renderEmptyState,
  renderStatusBadge
} from "../dom.js";
import {formatDate} from "../format.js";
import {buildAdminLibraryTitlePath} from "../routes.js";

const chapterSortValue = (value) => {
  const parsed = Number.parseFloat(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const normalizeTitle = (title = {}) => {
  const chapters = Array.isArray(title.chapters) ? [...title.chapters] : [];
  const sortedChapters = chapters.sort((left, right) => {
    const chapterDelta = chapterSortValue(right?.chapterNumber) - chapterSortValue(left?.chapterNumber);
    if (chapterDelta !== 0) {
      return chapterDelta;
    }
    return Date.parse(String(right?.releaseDate || "")) - Date.parse(String(left?.releaseDate || ""));
  });
  const latestReleaseDate = sortedChapters
    .map((chapter) => String(chapter?.releaseDate || "").trim())
    .find(Boolean) || "";
  const chapterCount = Number.parseInt(String(title.chapterCount || sortedChapters.length || 0), 10) || 0;
  const chaptersDownloaded = Number.parseInt(String(title.chaptersDownloaded || sortedChapters.length || 0), 10) || 0;
  return {
    ...title,
    title: String(title.title || "Untitled").trim() || "Untitled",
    mediaType: String(title.mediaType || "manga").trim() || "manga",
    libraryTypeLabel: String(title.libraryTypeLabel || title.mediaType || "Manga").trim() || "Manga",
    libraryTypeSlug: String(title.libraryTypeSlug || title.mediaType || "manga").trim() || "manga",
    status: String(title.status || "active").trim() || "active",
    latestChapter: String(title.latestChapter || "Unknown").trim() || "Unknown",
    coverAccent: String(title.coverAccent || "#4f8f88").trim() || "#4f8f88",
    summary: String(title.summary || "").trim(),
    releaseLabel: String(title.releaseLabel || "").trim(),
    author: String(title.author || "").trim(),
    metadataProvider: String(title.metadataProvider || "").trim(),
    metadataMatchedAt: String(title.metadataMatchedAt || "").trim(),
    sourceUrl: String(title.sourceUrl || "").trim(),
    workingRoot: String(title.workingRoot || "").trim(),
    downloadRoot: String(title.downloadRoot || "").trim(),
    chapterCount,
    chaptersDownloaded,
    coveragePercent: chapterCount > 0 ? Math.round((chaptersDownloaded / chapterCount) * 100) : 0,
    latestReleaseDate,
    chapters: sortedChapters
  };
};

const normalizeRequest = (request = {}) => ({
  id: String(request.id || "").trim(),
  title: String(request.title || "Untitled request").trim() || "Untitled request",
  status: String(request.status || "pending").trim() || "pending",
  notes: String(request.notes || "").trim(),
  source: String(request.source || "moon").trim() || "moon",
  updatedAt: String(request.updatedAt || "").trim(),
  coverUrl: String(request.coverUrl || "").trim()
});

const normalizeTask = (task = {}) => ({
  taskId: String(task.taskId || "").trim(),
  titleName: String(task.titleName || "Background task").trim() || "Background task",
  status: String(task.status || "queued").trim() || "queued",
  percent: Number.parseInt(String(task.percent || 0), 10) || 0,
  message: String(task.message || "").trim(),
  updatedAt: String(task.updatedAt || task.queuedAt || "").trim()
});

/**
 * Load the admin library detail payload.
 *
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   route: import("../routes.js").AdminRoute
 * }} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadLibraryTitlePage = ({api, route}) =>
  api.get(`/api/moon/v3/admin/library/${encodeURIComponent(route.params?.titleId || "")}`);

const renderStat = (label, value) => `
  <div class="library-detail-stat">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
  </div>
`;

const renderMetaLine = (label, value) => value
  ? `<div class="library-detail-meta-line"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
  : "";

const renderRequestRows = (requests) => {
  if (!requests.length) {
    return renderEmptyState("No related requests", "Requests for this title will show here once Moon or Discord creates them.");
  }

  return `
    <div class="detail-stack-list">
      ${requests.map((request) => `
        <article class="detail-stack-card">
          <div>
            <strong>${escapeHtml(request.title)}</strong>
            <span>${escapeHtml(request.source)}</span>
          </div>
          <div class="detail-stack-meta">
            ${renderStatusBadge(request.status)}
            <span>${escapeHtml(formatDate(request.updatedAt, {includeTime: true}))}</span>
          </div>
        </article>
      `).join("")}
    </div>
  `;
};

const renderTaskRows = (tasks, emptyTitle, emptyBody) => {
  if (!tasks.length) {
    return renderEmptyState(emptyTitle, emptyBody);
  }

  return `
    <div class="detail-stack-list">
      ${tasks.map((task) => `
        <article class="detail-stack-card">
          <div>
            <strong>${escapeHtml(task.titleName)}</strong>
            <span>${escapeHtml(task.message || "No additional task details.")}</span>
          </div>
          <div class="detail-stack-meta">
            ${renderStatusBadge(task.status)}
            <span>${escapeHtml(`${task.percent}%`)}</span>
          </div>
        </article>
      `).join("")}
    </div>
  `;
};

const renderChapterTable = (title) => {
  if (!title.chapters.length) {
    return renderEmptyState("No chapters indexed", "Raven has not cataloged any chapters for this title yet.");
  }

  return `
    <div class="table-wrap detail-table-wrap">
      <table class="data-table detail-chapter-table">
        <thead>
          <tr>
            <th>Chapter</th>
            <th>Released</th>
            <th>Pages</th>
            <th>Status</th>
            <th>Archive</th>
          </tr>
        </thead>
        <tbody>
          ${title.chapters.map((chapter) => `
            <tr>
              <td>
                <div class="detail-chapter-copy">
                  <strong>${escapeHtml(chapter.label || `Chapter ${chapter.chapterNumber || "?"}`)}</strong>
                  <span>${escapeHtml(chapter.chapterNumber ? `#${chapter.chapterNumber}` : "Unnumbered")}</span>
                </div>
              </td>
              <td>${escapeHtml(formatDate(chapter.releaseDate))}</td>
              <td>${escapeHtml(`${Number.parseInt(String(chapter.pageCount || 0), 10) || 0}`)}</td>
              <td>${renderStatusBadge(chapter.available === false ? "Pending" : "Available")}</td>
              <td><span class="path-copy">${escapeHtml(chapter.archivePath || "Pending archive")}</span></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
};

/**
 * Render the Sonarr-inspired admin title detail page.
 *
 * @param {Awaited<ReturnType<typeof loadLibraryTitlePage>>} result
 * @returns {string}
 */
export const renderLibraryTitlePage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Series unavailable", result.payload?.error || "Moon could not load this admin title detail.");
  }

  const title = normalizeTitle(result.payload?.title);
  const requests = (Array.isArray(result.payload?.requests) ? result.payload.requests : []).map((request) => normalizeRequest(request));
  const activeTasks = (Array.isArray(result.payload?.activeTasks) ? result.payload.activeTasks : []).map((task) => normalizeTask(task));
  const recentTasks = (Array.isArray(result.payload?.recentTasks) ? result.payload.recentTasks : []).map((task) => normalizeTask(task));
  const canonicalUserPath = `/title/${encodeURIComponent(title.libraryTypeSlug)}/${encodeURIComponent(title.id)}`;

  return `
    <section class="panel-section library-detail-hero" style="--detail-accent:${escapeHtml(title.coverAccent)}; --detail-backdrop:url('${escapeHtml(title.coverUrl)}')">
      <div class="library-detail-backdrop" aria-hidden="true"></div>
      <div class="library-detail-hero-inner">
        <div class="library-detail-poster-shell">
          ${title.coverUrl
            ? `<img class="library-detail-poster" src="${escapeHtml(title.coverUrl)}" alt="${escapeHtml(title.title)} cover" loading="lazy" referrerpolicy="no-referrer">`
            : renderCoverThumb("", title.title, "cover-thumb library-detail-poster-fallback")}
        </div>
        <div class="library-detail-copy">
          <span class="section-kicker">${escapeHtml(title.libraryTypeLabel)}</span>
          <h2>${escapeHtml(title.title)}</h2>
          <div class="library-detail-badges">
            ${renderStatusBadge(title.status)}
            ${renderChip(title.metadataProvider || "Metadata gap")}
            ${title.releaseLabel ? renderChip(title.releaseLabel) : ""}
            ${title.latestReleaseDate ? renderChip(`Latest ${formatDate(title.latestReleaseDate)}`) : ""}
          </div>
          <p>${escapeHtml(title.summary || "No metadata summary is available for this title yet.")}</p>
          <div class="library-detail-actions">
            <a class="ghost-button small" href="${escapeHtml(canonicalUserPath)}" target="_blank" rel="noreferrer">Open user title page</a>
            ${title.sourceUrl ? `<a class="ghost-button small" href="${escapeHtml(title.sourceUrl)}" target="_blank" rel="noreferrer">Open source</a>` : ""}
          </div>
        </div>
        <div class="library-detail-stats">
          ${renderStat("Latest chapter", title.latestChapter)}
          ${renderStat("Coverage", `${title.chaptersDownloaded}/${title.chapterCount}`)}
          ${renderStat("Downloaded", `${title.coveragePercent}%`)}
          ${renderStat("Matched", formatDate(title.metadataMatchedAt, {includeTime: true}))}
        </div>
      </div>
    </section>
    <section class="content-grid two-up">
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Metadata</span>
            <h2>Series facts</h2>
          </div>
        </div>
        <div class="library-detail-meta-grid">
          ${renderMetaLine("Author", title.author || "Unknown")}
          ${renderMetaLine("Lifecycle", title.status)}
          ${renderMetaLine("Provider", title.metadataProvider || "Unmatched")}
          ${renderMetaLine("Released", title.releaseLabel || "Unknown")}
          ${renderMetaLine("Download root", title.downloadRoot || "Pending")}
          ${renderMetaLine("Working root", title.workingRoot || "Pending")}
        </div>
      </section>
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Activity</span>
            <h2>Requests and tasks</h2>
          </div>
        </div>
        <div class="detail-subsection">
          <h3>Related requests</h3>
          ${renderRequestRows(requests)}
        </div>
        <div class="detail-subsection">
          <h3>Active tasks</h3>
          ${renderTaskRows(activeTasks, "No active Raven tasks", "Downloads, imports, or rescans for this title will surface here while they are running.")}
        </div>
        <div class="detail-subsection">
          <h3>Recent tasks</h3>
          ${renderTaskRows(recentTasks, "No recent Raven task history", "Recent completed or failed task snapshots for this title will appear here.")}
        </div>
      </section>
    </section>
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Chapters</span>
          <h2>Cataloged chapter table</h2>
          <p class="field-note">A dense chapter view in the same spirit as Sonarr’s series detail tables, tuned for Raven chapter archives and release history.</p>
        </div>
      </div>
      ${renderChapterTable(title)}
    </section>
  `;
};

/**
 * Keep the admin title detail URL canonical to the title's stored type slug.
 *
 * @param {HTMLElement} _root
 * @param {{
 *   navigate: (path: string, options?: {replace?: boolean}) => void
 * }} context
 * @param {Awaited<ReturnType<typeof loadLibraryTitlePage>>} result
 * @returns {Promise<void>}
 */
export const enhanceLibraryTitlePage = async (_root, {navigate}, result) => {
  if (!result.ok) {
    return;
  }

  const title = normalizeTitle(result.payload?.title);
  const canonicalPath = buildAdminLibraryTitlePath(title.libraryTypeSlug, title.id);
  if (window.location.pathname !== canonicalPath) {
    navigate(canonicalPath, {replace: true});
  }
};

export default {
  loadLibraryTitlePage,
  renderLibraryTitlePage,
  enhanceLibraryTitlePage
};
