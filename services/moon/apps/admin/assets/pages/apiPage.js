import {escapeHtml, renderChipList, renderEmptyState, renderStatusBadge} from "../dom.js";
import {formatDate} from "../format.js";

/**
 * Load the public Moon API settings payload.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadApiPage = ({api}) => api.get("/api/moon/admin/settings/moon/public-api");

const docsUrl = "/api/public/docs";
const openApiUrl = "/api/public/openapi.json";

const renderKeyResult = () => `
  <div class="callout subtle hidden" id="public-api-key-result" hidden>
    <strong>New API key</strong>
    <p>This plaintext value is only shown right after generation. Copy it now and store it somewhere safe.</p>
    <pre class="api-key-output" id="public-api-key-output"></pre>
  </div>
`;

/**
 * Render the public API admin page.
 *
 * @param {Awaited<ReturnType<typeof loadApiPage>>} result
 * @returns {string}
 */
export const renderApiPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Public API unavailable", result.payload?.error || "Moon could not load the public API settings.");
  }

  const settings = result.payload || {};
  const enabled = settings.enabled === true;

  return `
    <div class="content-grid two-up">
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Automation</span>
            <h2>Public Moon API</h2>
          </div>
          ${renderStatusBadge(enabled ? "Enabled" : "Disabled")}
        </div>
        <form id="public-api-settings-form" class="settings-form">
          <label class="switch-row">
            <input id="public-api-enabled" type="checkbox" ${enabled ? "checked" : ""}>
            <span>Enable trusted automation requests</span>
          </label>
          <div class="inline-note">
            <strong>Guardrails</strong>
            <p>External API requests are brokered through Moon, reject NSFW titles, reject titles already in the library or already queued, and are always submitted at the lowest Raven priority.</p>
          </div>
          <div class="action-row">
            <button class="solid-button" type="submit">Save API settings</button>
            <button class="ghost-button" type="button" id="public-api-generate-key">${settings.lastRotatedAt ? "Regenerate API key" : "Generate API key"}</button>
          </div>
        </form>
        ${renderKeyResult()}
      </section>
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Docs</span>
            <h2>Swagger and OpenAPI</h2>
          </div>
        </div>
        <div class="callout subtle">
          <strong>Admin automation entrypoint</strong>
          <p>Agents and external automation should search first, then submit a request with the issued selection token. Raw provider payloads are not trusted on write.</p>
        </div>
        <div class="action-row">
          <a class="solid-button" href="${docsUrl}" target="_blank" rel="noreferrer">Open Swagger UI</a>
          <a class="ghost-button" href="${openApiUrl}" target="_blank" rel="noreferrer">Open OpenAPI JSON</a>
        </div>
        <div class="stack-list compact-stack">
          <div class="inline-note">
            <strong>Last rotated</strong>
            <span>${escapeHtml(settings.lastRotatedAt ? formatDate(settings.lastRotatedAt, {includeTime: true}) : "Never")}</span>
          </div>
          <div class="inline-note">
            <strong>Auth header</strong>
            <span><code>X-Scriptarr-Api-Key</code></span>
          </div>
          <div class="inline-note">
            <strong>Caller rules</strong>
            ${renderChipList(["Search first", "Use selectionToken", "No NSFW", "No duplicates", "Lowest priority"])}
          </div>
          <div class="inline-note">
            <strong>Available endpoints</strong>
            ${renderChipList(["GET /api/public/v1/search", "POST /api/public/v1/requests", "GET /api/public/v1/requests/{id}"])}
          </div>
        </div>
      </section>
    </div>
  `;
};

/**
 * Wire the public API settings page interactions.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @returns {Promise<void>}
 */
export const enhanceApiPage = async (root, {api, rerender, setFlash}) => {
  root.querySelector("#public-api-settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api.put("/api/moon/admin/settings/moon/public-api", {
      enabled: root.querySelector("#public-api-enabled")?.checked === true
    });
    setFlash(result.ok ? "good" : "bad", result.ok
      ? "Public Moon API settings saved."
      : result.payload?.error || "Unable to save the public API settings.");
    await rerender();
  });

  root.querySelector("#public-api-generate-key")?.addEventListener("click", async () => {
    const result = await api.post("/api/moon/admin/settings/moon/public-api/key", {});
    if (!result.ok) {
      setFlash("bad", result.payload?.error || "Unable to generate a new public API key.");
      return;
    }

    const wrapper = root.querySelector("#public-api-key-result");
    const output = root.querySelector("#public-api-key-output");
    if (wrapper instanceof HTMLElement && output instanceof HTMLElement) {
      output.textContent = result.payload?.apiKey || "";
      wrapper.hidden = false;
      wrapper.classList.remove("hidden");
    }
    setFlash("good", "Generated a new public API key. Copy it now before you leave this page.");
  });
};

export default {
  loadApiPage,
  renderApiPage,
  enhanceApiPage
};
