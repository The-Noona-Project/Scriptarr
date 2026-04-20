import {renderEmptyState, renderSeriesCard} from "../dom.js";
import {buildTitlePath} from "../routes.js";

/**
 * Load the following list for the current user.
 *
 * @param {{api: ReturnType<import("../api.js").createUserApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadFollowingPage = ({api}) => api.get("/api/moon/v3/user/following");

/**
 * Render the following page.
 *
 * @param {Awaited<ReturnType<typeof loadFollowingPage>>} result
 * @returns {string}
 */
export const renderFollowingPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Following unavailable", result.payload?.error || "Sign in before managing followed titles.");
  }

  return `
    <section class="library-shelf">
      <div class="section-head">
        <div>
          <span class="section-kicker">Following</span>
          <h2>Titles you care about</h2>
        </div>
      </div>
      <div class="card-grid">
        ${(result.payload?.following || []).length
          ? (result.payload.following || []).map((entry) => renderSeriesCard({
            id: entry.titleId,
            title: entry.title,
            latestChapter: entry.latestChapter,
            summary: entry.mediaType,
            libraryTypeSlug: entry.libraryTypeSlug,
            href: buildTitlePath(entry.libraryTypeSlug || entry.mediaType || "manga", entry.titleId)
          })).join("")
          : renderEmptyState("You are not following anything yet", "Follow titles from their detail page to build a personal update shelf.")}
      </div>
    </section>
  `;
};

export default {
  loadFollowingPage,
  renderFollowingPage
};
