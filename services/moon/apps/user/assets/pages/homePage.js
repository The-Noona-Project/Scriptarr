import {escapeHtml, renderEmptyState, renderSeriesCard} from "../dom.js";
import {formatProgress} from "../format.js";
import {buildReaderPathForTitle, buildTitlePath, buildTitlePathForTitle, resolveTitleTypeSlug} from "../routes.js";

/**
 * Load the Moon user home payload.
 *
 * @param {{api: ReturnType<import("../api.js").createUserApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadHomePage = ({api}) => api.get("/api/moon/v3/user/home");

/**
 * Render the Moon user home page.
 *
 * @param {Awaited<ReturnType<typeof loadHomePage>>} result
 * @param {{branding?: {siteName?: string} | null}} [chrome]
 * @returns {string}
 */
export const renderHomePage = (result, chrome = {}) => {
  if (!result.ok) {
    return renderEmptyState("Sign in to read", result.payload?.error || "Moon needs a session before it can load your library and progress.");
  }

  const latestTitles = result.payload?.latestTitles || [];
  const continueReading = result.payload?.continueReading || [];
  const featured = latestTitles[0] || null;
  const siteName = chrome.branding?.siteName || "Scriptarr";

  return `
    ${featured ? `
      <section class="hero-panel" style="--hero-accent:${escapeHtml(featured.coverAccent || "#de6d3a")}">
        <div class="hero-copy">
          <span class="section-kicker">Featured now</span>
          <h1>${escapeHtml(featured.title)}</h1>
          <p>${escapeHtml(featured.summary || "Moon keeps the library front-and-center so you can read, follow, and request from one place.")}</p>
          <div class="hero-actions">
            <a class="solid-button" href="${escapeHtml(buildTitlePathForTitle(featured))}" data-link>Open series</a>
            ${featured.chapters?.length ? `<a class="ghost-button" href="${escapeHtml(buildReaderPathForTitle(featured, featured.chapters[featured.chapters.length - 1].id))}" data-link>Read latest</a>` : ""}
          </div>
        </div>
        <div class="hero-meta">
          <strong>${escapeHtml(featured.author || "Unknown creator")}</strong>
          <span>${escapeHtml(featured.latestChapter || "Unknown")}</span>
          <span>${escapeHtml(featured.libraryTypeLabel || featured.mediaType || "manga")}</span>
        </div>
      </section>
    ` : ""}
    <section class="library-shelf">
      <div class="section-head">
        <div>
          <span class="section-kicker">Continue reading</span>
          <h2>Pick up where you left off</h2>
        </div>
      </div>
      <div class="card-grid">
        ${continueReading.length
          ? continueReading.map((entry) => renderSeriesCard({
            id: entry.titleId || entry.mediaId,
            title: entry.title || entry.mediaId,
            latestChapter: entry.chapterLabel || entry.latestChapter || "In progress",
            summary: entry.summary || `${formatProgress(entry.positionRatio)} complete`,
            coverAccent: entry.coverAccent,
            progressRatio: entry.positionRatio,
            libraryTypeSlug: resolveTitleTypeSlug(entry),
            href: entry.bookmark?.chapterId
              ? buildReaderPath(resolveTitleTypeSlug(entry), entry.titleId || entry.mediaId, entry.bookmark.chapterId)
              : buildTitlePath(resolveTitleTypeSlug(entry), entry.titleId || entry.mediaId)
          })).join("")
          : renderEmptyState("No saved progress yet", "Start reading a chapter and Moon will surface it here.")}
      </div>
    </section>
    <section class="library-shelf">
      <div class="section-head">
        <div>
          <span class="section-kicker">Library</span>
          <h2>Recently surfaced titles</h2>
        </div>
      </div>
      <div class="card-grid">
        ${latestTitles.length
          ? latestTitles.map((title) => renderSeriesCard({
            ...title,
            href: buildTitlePathForTitle(title)
          })).join("")
          : renderEmptyState("Library is empty", `No titles have been imported into ${siteName} yet. Moon will stay empty here until Raven has real titles to serve.`)}
      </div>
    </section>
    <section class="content-grid two-up">
      <section class="panel-section">
        <div class="section-head">
          <div>
            <span class="section-kicker">Following</span>
            <h2>Your tracked titles</h2>
          </div>
        </div>
        ${(result.payload?.following || []).length
          ? `
            <div class="stack-list">
              ${(result.payload.following || []).map((entry) => `
                <article class="stack-card">
                  <a href="${escapeHtml(buildTitlePath(entry.libraryTypeSlug || entry.mediaType || "manga", entry.titleId))}" data-link>
                    <strong>${escapeHtml(entry.title)}</strong>
                  </a>
                  <span>${escapeHtml(entry.latestChapter || "No chapter yet")}</span>
                </article>
              `).join("")}
            </div>
          `
          : renderEmptyState("Nothing followed yet", "Follow titles from their detail page to keep them in your home feed.")}
      </section>
      <section class="panel-section">
        <div class="section-head">
          <div>
            <span class="section-kicker">Requests</span>
            <h2>Your queue</h2>
          </div>
        </div>
        ${(result.payload?.requests || []).length
          ? `
            <div class="stack-list">
              ${(result.payload.requests || []).map((entry) => `
                <article class="stack-card">
                  <strong>${escapeHtml(entry.title)}</strong>
                  <span>${escapeHtml(entry.status)}</span>
                </article>
              `).join("")}
            </div>
          `
          : renderEmptyState("No requests yet", "Requests you create in Moon or Discord will appear here.")}
      </section>
    </section>
  `;
};

export default {
  loadHomePage,
  renderHomePage
};
