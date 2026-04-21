import {escapeHtml, renderEmptyState} from "../dom.js";

const OPENAI_DEFAULT_MODEL = "gpt-4.1-mini";
const LOCALAI_DEFAULT_MODEL = "gpt-4";

const fallbackModelForProvider = (provider) => provider === "localai" ? LOCALAI_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL;

/**
 * Load the full admin settings payload.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadSettingsPage = ({api}) => api.get("/api/moon/v3/admin/settings");

/**
 * Render the settings page.
 *
 * @param {Awaited<ReturnType<typeof loadSettingsPage>>} result
 * @returns {string}
 */
export const renderSettingsPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Settings unavailable", result.payload?.error || "Unable to load admin settings.");
  }

  const {ravenVpn = {}, metadataProviders = {}, downloadProviders = {}, oracle = {}, branding = {}, warden = {}} = result.payload || {};
  const oracleProvider = oracle.provider === "localai" ? "localai" : "openai";
  const oracleModel = oracle.model || fallbackModelForProvider(oracleProvider);
  const localAiState = [
    warden.installed ? "installed" : "not installed",
    warden.running ? "running" : "not running"
  ];

  if (warden.running) {
    localAiState.push(warden.ready ? "ready" : "still starting");
  }

  return `
    <section class="callout subtle">
      <strong>Looking for file naming?</strong>
      <p>Raven naming profiles now live in <a class="series-row-link" href="/admin/mediamanagement" data-link>Media Management</a> so every type can keep its own chapter and page format.</p>
    </section>
    <div class="content-grid two-up">
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Branding</span>
            <h2>Moon site identity</h2>
          </div>
        </div>
        <form id="branding-form" class="settings-form">
          <label>
            <span>Site name</span>
            <input id="branding-site-name" type="text" value="${escapeHtml(branding.siteName || "Scriptarr")}" placeholder="Scriptarr">
          </label>
          <p class="field-note">Moon uses this name in the user header, admin header, document titles, and install metadata for the PWA shell.</p>
          <button class="solid-button" type="submit">Save branding</button>
        </form>
      </section>
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Downloads</span>
            <h2>Raven VPN</h2>
          </div>
        </div>
        <form id="raven-vpn-form" class="settings-form">
          <label class="switch-row">
            <input id="vpn-enabled" type="checkbox" ${ravenVpn.enabled ? "checked" : ""}>
            <span>Enable PIA/OpenVPN for Raven downloads</span>
          </label>
          <label>
            <span>Region</span>
            <input id="vpn-region" type="text" value="${escapeHtml(ravenVpn.region || "us_california")}" placeholder="us_california">
          </label>
          <label>
            <span>PIA username</span>
            <input id="vpn-username" type="text" value="${escapeHtml(ravenVpn.piaUsername || "")}" placeholder="p1234567">
          </label>
          <label>
            <span>PIA password</span>
            <input id="vpn-password" type="password" placeholder="${ravenVpn.passwordConfigured ? "Leave blank to keep stored value" : "Enter password"}">
          </label>
          <p class="field-note">${ravenVpn.passwordConfigured ? "A stored PIA password is already configured." : "No PIA password has been stored yet."}</p>
          <button class="solid-button" type="submit">Save Raven VPN</button>
        </form>
      </section>
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Metadata</span>
            <h2>Provider stack</h2>
          </div>
        </div>
        <form id="metadata-form" class="settings-form">
          <div class="provider-stack">
            ${(metadataProviders.providers || []).map((provider) => `
              <article class="provider-card" data-provider-id="${escapeHtml(provider.id)}">
                <div>
                  <strong>${escapeHtml(provider.name)}</strong>
                  <span>${escapeHtml((provider.scopes || []).join(", "))}</span>
                </div>
                <div class="provider-controls">
                  <label class="switch-row compact">
                    <input type="checkbox" data-provider-enabled ${provider.enabled ? "checked" : ""}>
                    <span>Enabled</span>
                  </label>
                  <label class="compact-field">
                    <span>Priority</span>
                    <input type="number" min="1" step="1" data-provider-priority value="${escapeHtml(provider.priority)}">
                  </label>
                </div>
              </article>
            `).join("")}
          </div>
          <p class="field-note">MangaDex stays on by default, Anime-Planet is enabled ahead of MangaUpdates for scrape-based lifecycle and alias enrichment, and AniList or ComicVine can widen coverage when you need more sources.</p>
          <button class="solid-button" type="submit">Save provider order</button>
        </form>
      </section>
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Downloads</span>
            <h2>Download providers</h2>
          </div>
        </div>
        <form id="download-provider-form" class="settings-form">
          <div class="provider-stack">
            ${(downloadProviders.providers || []).map((provider) => `
              <article class="provider-card" data-download-provider-id="${escapeHtml(provider.id)}">
                <div>
                  <strong>${escapeHtml(provider.name)}</strong>
                  <span>${escapeHtml((provider.scopes || []).join(", "))}</span>
                </div>
                <div class="provider-controls">
                  <label class="switch-row compact">
                    <input type="checkbox" data-download-provider-enabled ${provider.enabled ? "checked" : ""}>
                    <span>Enabled</span>
                  </label>
                  <label class="compact-field">
                    <span>Priority</span>
                    <input type="number" min="1" step="1" data-download-provider-priority value="${escapeHtml(provider.priority)}">
                  </label>
                </div>
              </article>
            `).join("")}
          </div>
          <p class="field-note">WeebCentral stays first by default, MangaDex is available as a normal fallback source, and the Discord <code>downloadall</code> command remains intentionally WeebCentral-only for the configured owner account.</p>
          <button class="solid-button" type="submit">Save download providers</button>
        </form>
      </section>
    </div>
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">AI</span>
          <h2>Oracle and LocalAI</h2>
        </div>
      </div>
      <form id="oracle-form" class="settings-form three-column">
        <label class="switch-row">
          <input id="oracle-enabled" type="checkbox" ${oracle.enabled ? "checked" : ""}>
          <span>Enable Oracle</span>
        </label>
        <label>
          <span>Provider</span>
          <select id="oracle-provider">
            <option value="openai" ${oracleProvider === "openai" ? "selected" : ""}>OpenAI</option>
            <option value="localai" ${oracleProvider === "localai" ? "selected" : ""}>LocalAI</option>
          </select>
        </label>
        <label>
          <span>Model</span>
          <input id="oracle-model" type="text" value="${escapeHtml(oracleModel)}" placeholder="${escapeHtml(fallbackModelForProvider(oracleProvider))}">
        </label>
        <label>
          <span>OpenAI API key</span>
          <input id="oracle-openai-key" type="password" placeholder="${oracle.openAiApiKeyConfigured ? "Leave blank to keep stored value" : "sk-..."}">
        </label>
        <label>
          <span>LocalAI AIO preset</span>
          <select id="localai-profile">
            <option value="cpu" ${oracle.localAiProfileKey === "cpu" ? "selected" : ""}>CPU AIO</option>
            <option value="nvidia" ${oracle.localAiProfileKey === "nvidia" ? "selected" : ""}>NVIDIA CUDA 12 AIO</option>
            <option value="amd" ${oracle.localAiProfileKey === "amd" ? "selected" : ""}>AMD HIPBLAS AIO</option>
            <option value="intel" ${oracle.localAiProfileKey === "intel" ? "selected" : ""}>Intel AIO</option>
          </select>
        </label>
        <label class="wide-field">
          <span>Custom LocalAI image</span>
          <input id="localai-custom-image" type="text" value="${escapeHtml(oracle.localAiCustomImage || "")}" placeholder="localai/localai:latest-aio-gpu-nvidia-cuda-12">
        </label>
        <div class="inline-note wide-field">
          <strong>Runtime state</strong>
          <p>Oracle starts off by default and prefers OpenAI on install. LocalAI AIO is ${localAiState.join(", ")} right now. Pulling or starting LocalAI can take 5 to 20 minutes depending on the host, and the first ready state may take a little longer while the AIO runtime warms up.</p>
        </div>
        <div class="action-row wide-field">
          <button class="ghost-button" id="localai-install" type="button">Install LocalAI AIO image</button>
          <button class="ghost-button" id="localai-start" type="button">Start LocalAI</button>
          <button class="solid-button" type="submit">Save Oracle settings</button>
        </div>
      </form>
    </section>
  `;
};

/**
 * Wire all settings forms and runtime actions.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @returns {Promise<void>}
 */
export const enhanceSettingsPage = async (root, {api, rerender, setFlash}) => {
  const oracleProvider = root.querySelector("#oracle-provider");
  const oracleModel = root.querySelector("#oracle-model");

  oracleProvider?.addEventListener("change", () => {
    if (!oracleModel) {
      return;
    }
    const nextDefault = fallbackModelForProvider(oracleProvider.value);
    const currentValue = oracleModel.value.trim();
    if (!currentValue || currentValue === OPENAI_DEFAULT_MODEL || currentValue === LOCALAI_DEFAULT_MODEL) {
      oracleModel.value = nextDefault;
      oracleModel.placeholder = nextDefault;
    }
  });

  root.querySelector("#branding-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api.put("/api/moon/admin/settings/moon/branding", {
      siteName: root.querySelector("#branding-site-name")?.value || "Scriptarr"
    });
    setFlash(result.ok ? "good" : "bad", result.ok ? "Moon branding saved." : result.payload?.error || "Unable to save Moon branding.");
    await rerender();
  });

  root.querySelector("#raven-vpn-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api.put("/api/moon/admin/settings/raven/vpn", {
      enabled: root.querySelector("#vpn-enabled")?.checked,
      region: root.querySelector("#vpn-region")?.value || "us_california",
      piaUsername: root.querySelector("#vpn-username")?.value || "",
      piaPassword: root.querySelector("#vpn-password")?.value || ""
    });
    setFlash(result.ok ? "good" : "bad", result.ok ? "Raven VPN settings saved." : result.payload?.error || "Unable to save Raven VPN settings.");
    await rerender();
  });

  root.querySelector("#metadata-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const providers = Array.from(root.querySelectorAll("[data-provider-id]")).map((node) => ({
      id: node.dataset.providerId,
      enabled: node.querySelector("[data-provider-enabled]")?.checked,
      priority: Number.parseInt(node.querySelector("[data-provider-priority]")?.value || "0", 10)
    }));
    const result = await api.put("/api/moon/admin/settings/raven/metadata", {providers});
    setFlash(result.ok ? "good" : "bad", result.ok ? "Metadata provider order saved." : result.payload?.error || "Unable to save provider settings.");
    await rerender();
  });

  root.querySelector("#download-provider-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const providers = Array.from(root.querySelectorAll("[data-download-provider-id]")).map((node) => ({
      id: node.dataset.downloadProviderId,
      enabled: node.querySelector("[data-download-provider-enabled]")?.checked,
      priority: Number.parseInt(node.querySelector("[data-download-provider-priority]")?.value || "0", 10)
    }));
    const result = await api.put("/api/moon/admin/settings/raven/download-providers", {providers});
    setFlash(result.ok ? "good" : "bad", result.ok ? "Download provider settings saved." : result.payload?.error || "Unable to save download provider settings.");
    await rerender();
  });

  root.querySelector("#oracle-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const customImage = root.querySelector("#localai-custom-image")?.value.trim() || "";
    const provider = root.querySelector("#oracle-provider")?.value || "openai";
    const model = root.querySelector("#oracle-model")?.value.trim() || fallbackModelForProvider(provider);
    const result = await api.put("/api/moon/admin/settings/oracle", {
      enabled: root.querySelector("#oracle-enabled")?.checked,
      provider,
      model,
      openAiApiKey: root.querySelector("#oracle-openai-key")?.value || "",
      localAiProfileKey: root.querySelector("#localai-profile")?.value || "nvidia",
      localAiImageMode: customImage ? "custom" : "preset",
      localAiCustomImage: customImage
    });
    setFlash(result.ok ? "good" : "bad", result.ok ? "Oracle settings saved." : result.payload?.error || "Unable to save Oracle settings.");
    await rerender();
  });

  root.querySelector("#localai-install")?.addEventListener("click", async () => {
    const result = await api.post("/api/moon/admin/warden/localai/install", {});
    setFlash(result.ok ? "warn" : "bad", result.ok ? "LocalAI AIO image install started. This can take a while." : result.payload?.error || "Unable to start LocalAI install.");
    await rerender();
  });

  root.querySelector("#localai-start")?.addEventListener("click", async () => {
    const result = await api.post("/api/moon/admin/warden/localai/start", {});
    setFlash(result.ok ? "warn" : "bad", result.ok ? "LocalAI startup requested. Give it time to come online." : result.payload?.error || "Unable to start LocalAI.");
    await rerender();
  });
};

export default {
  loadSettingsPage,
  renderSettingsPage,
  enhanceSettingsPage
};
