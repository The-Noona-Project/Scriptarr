import {escapeHtml, renderChipList, renderCoverArt, renderEmptyState} from "../dom.js";
import {buildReaderPathForTitle, buildTitlePathForTitle} from "../routes.js";

/**
 * Load a Moon title detail payload.
 *
 * @param {{
 *   api: ReturnType<import("../api.js").createUserApi>,
 *   route: ReturnType<import("../routes.js").matchUserRoute>
 * }} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadTitlePage = ({api, route}) => api.get(`/api/moon/v3/user/title/${encodeURIComponent(route.params.titleId)}`);

/**
 * Render the title detail page.
 *
 * @param {Awaited<ReturnType<typeof loadTitlePage>>} result
 * @returns {string}
 */
export const renderTitlePage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Series unavailable", result.payload?.error || "Moon could not load this series.");
  }

  const title = result.payload?.title;
  const availableChapters = (title?.chapters || []).filter((chapter) => chapter.available);
  const latestChapter = availableChapters[availableChapters.length - 1];

  return `
    <section class="detail-hero" style="--detail-accent:${escapeHtml(title.coverAccent || "#de6d3a")}">
      <div class="detail-art-shell">
        ${renderCoverArt(title.coverUrl, title.title, "detail-cover-art")}
      </div>
      <div class="detail-copy">
        <span class="section-kicker">${escapeHtml(title.libraryTypeLabel || title.mediaType || "manga")}</span>
        <h1>${escapeHtml(title.title)}</h1>
        <p>${escapeHtml(title.summary || "No summary has been matched for this title yet.")}</p>
        <div class="detail-actions">
          ${latestChapter ? `<a class="solid-button" href="${escapeHtml(buildReaderPathForTitle(title, latestChapter.id))}" data-link>Read latest</a>` : ""}
          <button class="ghost-button" id="title-follow-toggle" type="button" data-following="${result.payload.following ? "yes" : "no"}">${result.payload.following ? "Unfollow" : "Follow"}</button>
        </div>
      </div>
      <div class="detail-meta">
        <div><span>Author</span><strong>${escapeHtml(title.author || "Unknown")}</strong></div>
        <div><span>Provider</span><strong>${escapeHtml(title.metadataProvider || "Unmatched")}</strong></div>
        <div><span>Latest</span><strong>${escapeHtml(title.latestChapter || "Unknown")}</strong></div>
      </div>
    </section>
    <section class="content-grid two-up">
      <section class="panel-section">
        <div class="section-head">
          <div>
            <span class="section-kicker">Metadata</span>
            <h2>Tags and aliases</h2>
          </div>
        </div>
        ${renderChipList(title.tags)}
        ${renderChipList(title.aliases)}
      </section>
      <section class="panel-section">
        <div class="section-head">
          <div>
            <span class="section-kicker">Requests</span>
            <h2>Your related requests</h2>
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
          : renderEmptyState("No requests for this title", "If a title still needs more chapters, request it from Moon or Discord and it will show here.")}
      </section>
    </section>
    <section class="panel-section">
      <div class="section-head">
        <div>
          <span class="section-kicker">Chapters</span>
          <h2>Read from Moon</h2>
        </div>
      </div>
        <div class="chapter-list">
        ${availableChapters.map((chapter) => `
          <a class="chapter-row" href="${escapeHtml(buildReaderPathForTitle(title, chapter.id))}" data-link>
            <div>
              <strong>${escapeHtml(chapter.label)}</strong>
              <span>${escapeHtml(chapter.releaseDate || "Unknown date")}</span>
            </div>
            <span>${escapeHtml(chapter.pageCount)} pages</span>
          </a>
        `).join("")}
      </div>
    </section>
  `;
};

/**
 * Wire title-detail follow actions.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createUserApi>,
 *   navigate: (path: string, options?: {replace?: boolean}) => void,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @param {Awaited<ReturnType<typeof loadTitlePage>>} result
 * @returns {Promise<void>}
 */
export const enhanceTitlePage = async (root, {api, navigate, rerender, setFlash}, result) => {
  const canonicalTitlePath = buildTitlePathForTitle(result.payload?.title);
  if (window.location.pathname !== canonicalTitlePath && result.payload?.title?.libraryTypeSlug) {
    navigate(canonicalTitlePath, {replace: true});
    return;
  }

  root.querySelector("#title-follow-toggle")?.addEventListener("click", async () => {
    const title = result.payload?.title;
    const isFollowing = result.payload?.following === true;
    const response = isFollowing
      ? await api.delete(`/api/moon/v3/user/following/${encodeURIComponent(title.id)}`)
      : await api.post("/api/moon/v3/user/following", {
        titleId: title.id,
        title: title.title,
        latestChapter: title.latestChapter,
        mediaType: title.mediaType,
        libraryTypeLabel: title.libraryTypeLabel,
        libraryTypeSlug: title.libraryTypeSlug
      });

    setFlash(response.ok ? "good" : "bad", response.ok
      ? `${title.title} ${isFollowing ? "removed from" : "added to"} your following list.`
      : response.payload?.error || "Unable to update the following list.");
    await rerender();
  });
};

export default {
  loadTitlePage,
  renderTitlePage,
  enhanceTitlePage
};
