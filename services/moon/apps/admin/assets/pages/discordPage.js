import {escapeHtml, renderChipList, renderEmptyState, renderStatusBadge, renderTable} from "../dom.js";

const DEFAULT_ONBOARDING_TEMPLATE = "Welcome to {guild_name}, {user_mention}! Start reading at {moon_url}";
const PREVIEW_MOON_URL = "https://your-scriptarr.example";

const KNOWN_COMMANDS = [
  {
    id: "ding",
    label: "/ding",
    description: "Quick bot health reply.",
    scope: "Guild slash command",
    roleManaged: true
  },
  {
    id: "status",
    label: "/status",
    description: "Read-only Scriptarr runtime summary.",
    scope: "Guild slash command",
    roleManaged: true
  },
  {
    id: "chat",
    label: "/chat",
    description: "Portal chat bridge into Oracle.",
    scope: "Guild slash command",
    roleManaged: true
  },
  {
    id: "search",
    label: "/search",
    description: "Search the current Scriptarr library.",
    scope: "Guild slash command",
    roleManaged: true
  },
  {
    id: "request",
    label: "/request",
    description: "Search intake matches and file a moderated request.",
    scope: "Guild slash command",
    roleManaged: true
  },
  {
    id: "subscribe",
    label: "/subscribe",
    description: "Follow a library title for Discord notifications.",
    scope: "Guild slash command",
    roleManaged: true
  },
  {
    id: "downloadall",
    label: "downloadall",
    description: "DM-only admin bulk queue command.",
    scope: "Direct message",
    roleManaged: false
  }
];

const normalizeCommandRuntime = (value) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).map(([id, entry]) => ({
    id,
    ...(entry || {})
  }));
};

const normalizeSettings = (payload = {}) => {
  const source = payload?.settings || payload?.discord || payload?.portalDiscord || payload || {};
  const commands = Object.fromEntries(KNOWN_COMMANDS.map((command) => {
    const saved = source.commands?.[command.id] || {};
    return [command.id, {
      enabled: saved.enabled !== false,
      roleId: saved.roleId || ""
    }];
  }));

  return {
    guildId: source.guildId || "",
    superuserId: source.superuserId || "",
    onboarding: {
      channelId: source.onboarding?.channelId || "",
      template: source.onboarding?.template || DEFAULT_ONBOARDING_TEMPLATE
    },
    commands
  };
};

const normalizeRuntime = (payload = {}, settings = normalizeSettings(payload)) => {
  const runtime = payload?.runtime || {};
  const inventory = normalizeCommandRuntime(runtime.commandInventory || runtime.commands).map((entry) => ({
    ...entry,
    id: entry.id || entry.name || "",
    label: entry.label || entry.name || entry.id || "unknown"
  }));

  const connectionState = runtime.connectionState
    || (runtime.connected ? "connected" : (runtime.degraded ? "degraded" : (runtime.authConfigured ? "disconnected" : "missing")));

  return {
    authConfigured: Boolean(runtime.authConfigured),
    connectionState,
    registeredGuildId: runtime.registeredGuildId || runtime.guildId || settings.guildId || "",
    error: runtime.error || "",
    syncError: runtime.syncError || "",
    warning: runtime.warning || "",
    capabilities: runtime.capabilities || {},
    commandInventory: inventory
  };
};

const templatePreview = ({template, guildId, previewUserId, guildName = "Your Discord Server", moonUrl = PREVIEW_MOON_URL}) => {
  let rendered = String(template || DEFAULT_ONBOARDING_TEMPLATE).trim() || DEFAULT_ONBOARDING_TEMPLATE;
  const mention = `<@${previewUserId || "253987219969146890"}>`;
  const tokenMap = {
    "{user_mention}": mention,
    "{guild_name}": guildName,
    "{guild_id}": guildId || "123456789012345678",
    "{moon_url}": moonUrl
  };

  for (const [token, value] of Object.entries(tokenMap)) {
    rendered = rendered.replaceAll(token, value);
  }

  if (!String(template || "").includes("{user_mention}")) {
    rendered = `${mention}\n\n${rendered}`;
  }

  return rendered.trim();
};

const renderRuntimeSummary = (runtime) => {
  const runtimeTone = runtime.connectionState === "connected"
    ? "Connected"
    : runtime.connectionState === "degraded"
      ? "Degraded"
      : runtime.authConfigured
        ? "Disconnected"
        : "Missing";
  const capabilityRows = [
    ["Command sync", runtime.capabilities?.commandSync],
    ["Direct messages", runtime.capabilities?.directMessages],
    ["Onboarding", runtime.capabilities?.onboarding]
  ].map(([label, capability]) => `
    <tr>
      <td><strong>${escapeHtml(label)}</strong></td>
      <td>${renderStatusBadge(capability?.status || "unknown")}</td>
      <td>${escapeHtml(capability?.detail || "No detail from Portal yet.")}</td>
    </tr>
  `).join("");

  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <span class="section-kicker">Discord runtime</span>
          <h2>Bot status and command sync</h2>
        </div>
      </div>
      <section class="metric-grid discord-metric-grid">
        <article class="metric-card">
          <span>Auth</span>
          <strong>${runtime.authConfigured ? "Configured" : "Missing"}</strong>
        </article>
        <article class="metric-card">
          <span>Bot runtime</span>
          <strong>${escapeHtml(runtimeTone)}</strong>
        </article>
        <article class="metric-card">
          <span>Registered guild</span>
          <strong>${escapeHtml(runtime.registeredGuildId || "Not synced")}</strong>
        </article>
        <article class="metric-card">
          <span>Command inventory</span>
          <strong>${escapeHtml(runtime.commandInventory.length)}</strong>
        </article>
      </section>
      ${runtime.error ? `
        <div class="callout bad">
          <strong>Last runtime error</strong>
          <p>${escapeHtml(runtime.error)}</p>
        </div>
      ` : ""}
      ${runtime.syncError ? `
        <div class="callout warn">
          <strong>Command sync issue</strong>
          <p>${escapeHtml(runtime.syncError)}</p>
        </div>
      ` : ""}
      ${runtime.warning ? `
        <div class="callout warn">
          <strong>Capability warning</strong>
          <p>${escapeHtml(runtime.warning)}</p>
        </div>
      ` : ""}
      <div class="callout subtle">
        <strong>Credentials stay env-managed</strong>
        <p>Moon only manages guild workflow settings here. Discord bot token and OAuth client credentials remain host-managed environment config.</p>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Capability</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>${capabilityRows}</tbody>
        </table>
      </div>
      ${renderTable({
        columns: ["Command", "Scope", "Runtime", "Registered guild"],
        rows: runtime.commandInventory.map((entry) => [
          `<strong>${escapeHtml(entry.label)}</strong>`,
          escapeHtml(entry.scope || "Guild slash command"),
          renderStatusBadge(entry.status || (entry.registered ? "Registered" : "Pending")),
          escapeHtml(entry.guildId || runtime.registeredGuildId || "Not synced")
        ]),
        emptyTitle: "No Discord runtime inventory",
        emptyBody: "Portal has not surfaced Discord command registration details yet."
      })}
    </section>
  `;
};

const renderCommandMatrix = (settings) => `
  <section class="panel-section">
    <div class="section-heading">
      <div>
        <span class="section-kicker">Access control</span>
        <h2>Command permissions</h2>
      </div>
      <button class="solid-button" type="submit" form="discord-settings-form">Save Discord settings</button>
    </div>
    <div class="table-wrap">
      <table class="data-table form-table">
        <thead>
          <tr>
            <th>Command</th>
            <th>Scope</th>
            <th>Enabled</th>
            <th>Required role</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${KNOWN_COMMANDS.map((command) => `
            <tr>
              <td>
                <div class="table-title-cell">
                  <strong>${escapeHtml(command.label)}</strong>
                  <span class="muted-copy">${escapeHtml(command.description)}</span>
                </div>
              </td>
              <td>${escapeHtml(command.scope)}</td>
              <td>
                <label class="switch-row compact">
                  <input
                    type="checkbox"
                    data-command-enabled="${escapeHtml(command.id)}"
                    ${settings.commands[command.id]?.enabled ? "checked" : ""}>
                  <span>${settings.commands[command.id]?.enabled ? "Enabled" : "Disabled"}</span>
                </label>
              </td>
              <td>
                <input
                  type="text"
                  data-command-role="${escapeHtml(command.id)}"
                  value="${escapeHtml(settings.commands[command.id]?.roleId || "")}"
                  placeholder="${command.roleManaged ? "Discord role id" : "Not used"}"
                  ${command.roleManaged ? "" : "disabled"}>
              </td>
              <td>${command.roleManaged
                ? `<span class="muted-copy">Blank role id means any member in the configured guild can use ${escapeHtml(command.label)}.</span>`
                : `<span class="muted-copy">DM-only admin command. Portal ignores guild roles and checks the configured superuser id instead.</span>`}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  </section>
`;

/**
 * Load the brokered Discord admin payload.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadDiscordPage = ({api}) => api.get("/api/moon/admin/settings/portal/discord");

/**
 * Render the dedicated Discord admin page.
 *
 * @param {Awaited<ReturnType<typeof loadDiscordPage>>} result
 * @returns {string}
 */
export const renderDiscordPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Discord settings unavailable", result.payload?.error || "Moon could not load the brokered Discord settings.");
  }

  const settings = normalizeSettings(result.payload);
  const runtime = normalizeRuntime(result.payload, settings);
  const preview = templatePreview({
    template: settings.onboarding.template,
    guildId: settings.guildId,
    previewUserId: settings.superuserId
  });

  return `
    <div class="content-grid two-up">
      ${renderRuntimeSummary(runtime)}
      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Preview</span>
            <h2>Onboarding test</h2>
          </div>
        </div>
        <div class="callout subtle">
          <strong>Supported tokens</strong>
          ${renderChipList(["{user_mention}", "{guild_name}", "{guild_id}", "{moon_url}"])}
          <p>Moon renders a local preview here, and the test action sends the current form values through Sage to Portal.</p>
        </div>
        <label class="compact-field">
          <span>Preview message</span>
          <textarea id="discord-onboarding-preview" class="discord-preview" readonly>${escapeHtml(preview)}</textarea>
        </label>
        <div class="action-row">
          <button class="ghost-button" id="discord-onboarding-test" type="button">Send onboarding test</button>
        </div>
      </section>
    </div>
    <form id="discord-settings-form" class="page-form">
      <section class="content-grid two-up">
        <section class="panel-section">
          <div class="section-heading">
            <div>
              <span class="section-kicker">Guild</span>
              <h2>Discord workflow settings</h2>
            </div>
          </div>
          <div class="settings-form">
            <label>
              <span>Guild id</span>
              <input id="discord-guild-id" type="text" value="${escapeHtml(settings.guildId)}" placeholder="123456789012345678">
            </label>
            <label>
              <span>DM superuser id</span>
              <input id="discord-superuser-id" type="text" value="${escapeHtml(settings.superuserId)}" placeholder="253987219969146890">
            </label>
            <p class="field-note">Portal uses the configured guild id to scope slash-command access. The DM superuser id is the only account allowed to use the private <code>downloadall</code> bot command.</p>
          </div>
        </section>
        <section class="panel-section">
          <div class="section-heading">
            <div>
              <span class="section-kicker">Onboarding</span>
              <h2>Welcome message</h2>
            </div>
          </div>
          <div class="settings-form">
            <label>
              <span>Onboarding channel id</span>
              <input id="discord-onboarding-channel-id" type="text" value="${escapeHtml(settings.onboarding.channelId)}" placeholder="123456789012345678">
            </label>
            <label>
              <span>Onboarding template</span>
              <textarea id="discord-onboarding-template" rows="7" placeholder="${escapeHtml(DEFAULT_ONBOARDING_TEMPLATE)}">${escapeHtml(settings.onboarding.template)}</textarea>
            </label>
            <p class="field-note">When both channel id and template are set, Portal can post the saved onboarding message when a real guild member joins.</p>
          </div>
        </section>
      </section>
      ${renderCommandMatrix(settings)}
      <div class="action-row">
        <button class="solid-button" type="submit">Save Discord settings</button>
      </div>
    </form>
  `;
};

const collectSettings = (root) => ({
  guildId: root.querySelector("#discord-guild-id")?.value.trim() || "",
  superuserId: root.querySelector("#discord-superuser-id")?.value.trim() || "",
  onboarding: {
    channelId: root.querySelector("#discord-onboarding-channel-id")?.value.trim() || "",
    template: root.querySelector("#discord-onboarding-template")?.value || DEFAULT_ONBOARDING_TEMPLATE
  },
  commands: Object.fromEntries(KNOWN_COMMANDS.map((command) => [
    command.id,
    {
      enabled: root.querySelector(`[data-command-enabled='${command.id}']`)?.checked ?? true,
      roleId: command.roleManaged ? (root.querySelector(`[data-command-role='${command.id}']`)?.value.trim() || "") : ""
    }
  ]))
});

const updatePreview = (root) => {
  const previewNode = root.querySelector("#discord-onboarding-preview");
  if (!(previewNode instanceof HTMLTextAreaElement)) {
    return;
  }

  const settings = collectSettings(root);
  previewNode.value = templatePreview({
    template: settings.onboarding.template,
    guildId: settings.guildId,
    previewUserId: settings.superuserId
  });
};

/**
 * Wire the Discord settings form and onboarding test actions.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @returns {Promise<void>}
 */
export const enhanceDiscordPage = async (root, {api, rerender, setFlash}) => {
  root.querySelectorAll("#discord-guild-id, #discord-superuser-id, #discord-onboarding-template, #discord-onboarding-channel-id")
    .forEach((node) => {
      node.addEventListener("input", () => updatePreview(root));
    });

  root.querySelector("#discord-settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api.put("/api/moon/admin/settings/portal/discord", collectSettings(root));
    setFlash(result.ok ? "good" : "bad", result.ok
      ? "Discord workflow settings saved."
      : result.payload?.error || "Unable to save Discord settings.");
    await rerender();
  });

  root.querySelector("#discord-onboarding-test")?.addEventListener("click", async () => {
    const result = await api.post("/api/moon/admin/settings/portal/discord/onboarding/test", collectSettings(root));
    setFlash(result.ok ? "good" : "bad", result.ok
      ? "Portal accepted the onboarding test request."
      : result.payload?.error || "Unable to send the onboarding test.");
    await rerender();
  });

  updatePreview(root);
};

export default {
  loadDiscordPage,
  renderDiscordPage,
  enhanceDiscordPage
};
