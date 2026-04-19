import {escapeHtml, renderEmptyState} from "../dom.js";

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

  const {ravenVpn = {}, metadataProviders = {}, oracle = {}, warden = {}} = result.payload || {};

  return `
    <div class="content-grid two-up">
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
          <p class="field-note">MangaDex stays on by default. AniList and ComicVine are available when you want wider metadata coverage.</p>
          <button class="solid-button" type="submit">Save provider order</button>
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
            <option value="openai" ${oracle.provider === "openai" ? "selected" : ""}>OpenAI</option>
            <option value="localai" ${oracle.provider === "localai" ? "selected" : ""}>LocalAI</option>
          </select>
        </label>
        <label>
          <span>Model</span>
          <input id="oracle-model" type="text" value="${escapeHtml(oracle.model || "gpt-4.1-mini")}">
        </label>
        <label>
          <span>OpenAI API key</span>
          <input id="oracle-openai-key" type="password" placeholder="${oracle.openAiApiKeyConfigured ? "Leave blank to keep stored value" : "sk-..."}">
        </label>
        <label>
          <span>LocalAI preset</span>
          <select id="localai-profile">
            <option value="cpu" ${oracle.localAiProfileKey === "cpu" ? "selected" : ""}>CPU</option>
            <option value="nvidia" ${oracle.localAiProfileKey === "nvidia" ? "selected" : ""}>NVIDIA CUDA 12</option>
            <option value="amd" ${oracle.localAiProfileKey === "amd" ? "selected" : ""}>AMD</option>
            <option value="intel" ${oracle.localAiProfileKey === "intel" ? "selected" : ""}>Intel</option>
          </select>
        </label>
        <label class="wide-field">
          <span>Custom LocalAI image</span>
          <input id="localai-custom-image" type="text" value="${escapeHtml(oracle.localAiCustomImage || "")}" placeholder="localai/localai:latest-gpu-nvidia-cuda-12">
        </label>
        <div class="inline-note wide-field">
          <strong>Runtime state</strong>
          <p>Oracle starts off by default and prefers OpenAI on install. LocalAI is ${warden.installed ? "installed" : "not installed"} and ${warden.running ? "running" : "not running"} right now. Pulling or starting LocalAI can take 5 to 20 minutes depending on the host.</p>
        </div>
        <div class="action-row wide-field">
          <button class="ghost-button" id="localai-install" type="button">Install LocalAI image</button>
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

  root.querySelector("#oracle-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const customImage = root.querySelector("#localai-custom-image")?.value.trim() || "";
    const result = await api.put("/api/moon/admin/settings/oracle", {
      enabled: root.querySelector("#oracle-enabled")?.checked,
      provider: root.querySelector("#oracle-provider")?.value || "openai",
      model: root.querySelector("#oracle-model")?.value || "gpt-4.1-mini",
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
    setFlash(result.ok ? "warn" : "bad", result.ok ? "LocalAI image install started. This can take a while." : result.payload?.error || "Unable to start LocalAI install.");
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
