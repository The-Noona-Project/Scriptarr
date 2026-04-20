import {escapeHtml, renderChipList, renderCoverArt, renderEmptyState} from "../dom.js";
import {formatDate} from "../format.js";
import {buildReaderPathForTitle, buildTitlePathForTitle} from "../routes.js";

const chapterSortValue = (value) => {
  const parsed = Number.parseFloat(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const sortAvailableChapters = (chapters) => [...(Array.isArray(chapters) ? chapters : [])]
  .filter((chapter) => chapter?.available)
  .sort((left, right) => chapterSortValue(right?.chapterNumber) - chapterSortValue(left?.chapterNumber));

const formatMetadataProvider = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  if (normalized === "mangadex") {
    return "MangaDex";
  }
  if (normalized === "anilist") {
    return "AniList";
  }
  if (normalized === "mangaupdates") {
    return "MangaUpdates";
  }
  if (normalized === "mal") {
    return "MyAnimeList";
  }
  if (normalized === "comicvine") {
    return "ComicVine";
  }

  return normalized
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1))
    .join(" ");
};

const formatSourceProvider = (sourceUrl) => {
  const normalized = String(sourceUrl || "").trim();
  if (!normalized) {
    return "";
  }

  try {
    const {hostname} = new URL(normalized);
    const host = hostname.toLowerCase();
    if (host.includes("weebcentral")) {
      return "WeebCentral";
    }

    return host
      .replace(/^www\./, "")
      .split(".")
      .slice(0, -1)
      .join(".")
      .split(/[^a-z0-9]+/i)
      .filter(Boolean)
      .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1))
      .join(" ");
  } catch {
    return "";
  }
};

const formatChapterDateLabel = (chapter) => {
  const formatted = formatDate(chapter?.releaseDate);
  return formatted === "Unknown" ? "Date unavailable" : formatted;
};

const buildMetaItems = (title) => {
  const items = [];
  if (title?.author) {
    items.push({label: "Author", value: title.author});
  }

  const metadataProvider = formatMetadataProvider(title?.metadataProvider);
  if (metadataProvider) {
    items.push({label: "Metadata", value: metadataProvider});
  } else {
    const sourceProvider = formatSourceProvider(title?.sourceUrl);
    if (sourceProvider) {
      items.push({label: "Source", value: sourceProvider});
    }
  }

  if (title?.releaseLabel) {
    items.push({label: "Released", value: title.releaseLabel});
  }

  if (title?.chapterCount) {
    items.push({label: "Chapters", value: String(title.chapterCount)});
  }

  items.push({label: "Latest", value: title?.latestChapter || "Unknown"});
  return items;
};

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
  const availableChapters = sortAvailableChapters(title?.chapters);
  const latestChapter = availableChapters[0];
  const metaItems = buildMetaItems(title);

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
        ${metaItems.map((item) => `
          <div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>
        `).join("")}
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
              <span>${escapeHtml(formatChapterDateLabel(chapter))}</span>
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
