import {escapeHtml, renderEmptyState} from "../dom.js";
import {formatDate} from "../format.js";

/**
 * Load the current user's request list.
 *
 * @param {{api: ReturnType<import("../api.js").createUserApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadRequestsPage = ({api}) => api.get("/api/moon/v3/user/requests");

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

  return `
    <div class="content-grid two-up">
      <section class="panel-section">
        <div class="section-head">
          <div>
            <span class="section-kicker">Request something</span>
            <h2>Ask Moon for a new title</h2>
          </div>
        </div>
        <form id="user-request-form" class="request-form">
          <input id="request-title" type="text" placeholder="Title" required>
          <select id="request-type">
            <option value="manga">Manga</option>
            <option value="webtoon">Webtoon</option>
            <option value="comic">Comic</option>
          </select>
          <textarea id="request-notes" placeholder="Notes for moderators"></textarea>
          <button class="solid-button" type="submit">Create request</button>
        </form>
      </section>
      <section class="panel-section">
        <div class="section-head">
          <div>
            <span class="section-kicker">My queue</span>
            <h2>Request history</h2>
          </div>
        </div>
        ${(result.payload?.requests || []).length
          ? `
            <div class="stack-list">
              ${(result.payload.requests || []).map((entry) => `
                <article class="stack-card">
                  <strong>${escapeHtml(entry.title)}</strong>
                  <span>${escapeHtml(entry.status)} · ${escapeHtml(formatDate(entry.updatedAt, {includeTime: true}))}</span>
                  <p>${escapeHtml(entry.notes || "No notes")}</p>
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
 * Wire the request-creation form.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createUserApi>,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @returns {Promise<void>}
 */
export const enhanceRequestsPage = async (root, {api, rerender, setFlash}) => {
  root.querySelector("#user-request-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api.post("/api/moon/v3/user/requests", {
      title: root.querySelector("#request-title")?.value || "",
      requestType: root.querySelector("#request-type")?.value || "manga",
      notes: root.querySelector("#request-notes")?.value || ""
    });

    setFlash(result.ok ? "good" : "bad", result.ok ? "Request created and sent to moderation." : result.payload?.error || "Unable to create your request.");
    await rerender();
  });
};

export default {
  loadRequestsPage,
  renderRequestsPage,
  enhanceRequestsPage
};
