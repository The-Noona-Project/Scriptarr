"use client";

/**
 * @file Purpose-built general settings hub for Moon admin.
 */

import {useEffect, useMemo, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {formatDate, formatDisplayValue, normalizeString} from "../lib/format.js";
import {buildSettingsDraft, clearVpnPasswordDraft, mergeSettingsDraft, normalizeToastDraft} from "../lib/settingsDraft.js";
import {AdminActionBanner, AdminStatusBadge} from "./AdminUi.jsx";
import {useAdminChrome} from "./AdminProviders.jsx";
import {useAdminToast} from "./AdminToasts.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const emptySettings = Object.freeze({
  branding: {siteName: "Scriptarr", logo: {enabled: false, variants: {}}},
  publicBranding: {siteName: "Scriptarr", logo: {enabled: false, urls: {}}},
  ravenVpn: {enabled: false, region: "us_california", piaUsername: "", passwordConfigured: false},
  ravenVpnRuntime: {connected: false, lastError: ""},
  metadataProviders: {providers: []},
  downloadProviders: {providers: []},
  requestWorkflow: {autoApproveAndDownload: false},
  discord: {guildId: "", superuserId: "", onboarding: {channelId: "", template: ""}, runtime: {}},
  toastSettings: {global: {}, personal: null, effective: {}, canEditGlobal: false},
  databaseOverview: null,
  links: {
    databaseExplorer: "/admin/settings/database",
    noonaProject: "https://github.com/The-Noona-Project/Scriptarr",
    supportDiscord: "https://discord.gg/HMYHT8KD5v"
  }
});

const formatBytes = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = numeric;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unit]}`;
};

const ToggleRow = ({checked, disabled = false, label, onChange}) => (
  <label className="admin-check-row">
    <input
      checked={Boolean(checked)}
      disabled={disabled}
      type="checkbox"
      onChange={(event) => onChange(event.target.checked)}
    />
    <span>{label}</span>
  </label>
);

const ProviderList = ({providers, disabled, onChange}) => (
  <div className="admin-settings-provider-list">
    {providers.map((provider) => (
      <article className="admin-update-card" key={provider.id}>
        <div className="admin-record-head">
          <strong>{provider.name || provider.id}</strong>
          <AdminStatusBadge tone={provider.enabled ? "good" : "warning"}>{provider.enabled ? "enabled" : "disabled"}</AdminStatusBadge>
        </div>
        <div className="admin-task-form">
          <ToggleRow
            checked={provider.enabled}
            disabled={disabled}
            label="Enabled"
            onChange={(enabled) => onChange(provider.id, {enabled})}
          />
          <label>
            <span>Priority</span>
            <input
              disabled={disabled}
              min="1"
              type="number"
              value={provider.priority}
              onChange={(event) => onChange(provider.id, {priority: event.target.value})}
            />
          </label>
        </div>
        <p className="admin-muted">{normalizeArray(provider.scopes).join(", ") || "All scopes"}</p>
      </article>
    ))}
  </div>
);

const ToastPreferenceForm = ({draft, disabled, onChange}) => (
  <div className="admin-settings-toast-grid">
    <ToggleRow checked={draft.actionToasts} disabled={disabled} label="Admin actions" onChange={(value) => onChange({actionToasts: value})} />
    <ToggleRow checked={draft.jobToasts} disabled={disabled} label="Async jobs" onChange={(value) => onChange({jobToasts: value})} />
    <ToggleRow checked={draft.liveEventToasts} disabled={disabled} label="Live events" onChange={(value) => onChange({liveEventToasts: value})} />
    <ToggleRow checked={draft.failuresOnly} disabled={disabled} label="Failures only" onChange={(value) => onChange({failuresOnly: value})} />
    {["info", "success", "warning", "error"].map((severity) => (
      <ToggleRow
        checked={draft.severities?.[severity]}
        disabled={disabled}
        key={severity}
        label={`${severity} severity`}
        onChange={(value) => onChange({severities: {...draft.severities, [severity]: value}})}
      />
    ))}
  </div>
);

/**
 * Render the redesigned Settings page.
 *
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const SettingsPage = ({user}) => {
  const canSave = hasAdminGrant(user, "settings", "write");
  const canRoot = hasAdminGrant(user, "settings", "root");
  const canDatabase = hasAdminGrant(user, "database", "read");
  const {refreshChrome} = useAdminChrome();
  const {notify, savePersonalPreferences, saveGlobalPreferences, refreshToastSettings} = useAdminToast();
  const [flash, setFlash] = useState("");
  const [flashTone, setFlashTone] = useState("");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState(null);
  const [dirtySections, setDirtySections] = useState(() => new Set());
  const {loading, refreshing, error, data, refresh, setData} = useAdminJson("/api/moon/v3/admin/settings", {
    fallback: emptySettings
  });
  useAdminEventStaleness({
    domains: canDatabase ? ["settings", "database"] : ["settings"],
    enabled: true,
    locked: Boolean(busy),
    onStale: () => {},
    onRefresh: refresh
  });

  useEffect(() => {
    if (data) {
      const incoming = buildSettingsDraft(data);
      setDraft((current) => mergeSettingsDraft(current, incoming, dirtySections));
    }
  }, [data, dirtySections]);

  const payload = data || emptySettings;
  const dbOverview = payload.databaseOverview;
  const logoUrls = payload.publicBranding?.logo?.urls || {};
  const logoUrl = logoUrls.chrome || "";
  const providerCounts = useMemo(() => ({
    metadata: draft?.metadataProviders?.filter((provider) => provider.enabled).length || 0,
    download: draft?.downloadProviders?.filter((provider) => provider.enabled).length || 0
  }), [draft?.downloadProviders, draft?.metadataProviders]);

  const markDirty = (section) => setDirtySections((current) => {
    const next = new Set(current);
    next.add(section);
    return next;
  });

  const clearDirty = (section) => setDirtySections((current) => {
    const next = new Set(current);
    next.delete(section);
    return next;
  });

  const patchDraft = (section, patch) => {
    markDirty(section);
    setDraft((current) => ({
      ...(current || {}),
      [section]: {
        ...(current?.[section] || {}),
        ...patch
      }
    }));
  };

  const patchProvider = (section, providerId, patch) => {
    markDirty(section);
    setDraft((current) => ({
      ...(current || {}),
      [section]: normalizeArray(current?.[section]).map((provider) => provider.id === providerId
        ? {...provider, ...patch, priority: patch.priority == null ? provider.priority : Number.parseInt(String(patch.priority), 10) || provider.priority}
        : provider)
    }));
  };

  const saveRequest = async (label, url, options, onSuccess, section = "") => {
    setBusy(label);
    setFlash("");
    const result = await requestJson(url, options);
    setBusy("");
    if (!result.ok) {
      setFlash(formatDisplayValue(result.payload?.error, `Moon could not save ${label}.`));
      setFlashTone("bad");
      notify({message: formatDisplayValue(result.payload?.error, `Moon could not save ${label}.`), tone: "bad", category: "action"});
      return null;
    }
    onSuccess?.(result.payload);
    if (section) {
      clearDirty(section);
    }
    setFlash(`${label} saved.`);
    setFlashTone("good");
    notify({message: `${label} saved.`, tone: "good", category: "action"});
    void refresh();
    return result.payload;
  };

  const saveBranding = async () => {
    const result = await saveRequest("Branding", "/api/moon/v3/admin/settings/branding", {
      method: "PUT",
      json: draft.branding
    }, (payload) => {
      setData((current) => ({...current, branding: payload.branding, publicBranding: payload.publicBranding}));
      setDraft((current) => ({
        ...current,
        branding: {
          ...(current?.branding || {}),
          siteName: normalizeString(payload.branding?.siteName, normalizeString(payload.publicBranding?.siteName, current?.branding?.siteName || "Scriptarr"))
        }
      }));
    }, "branding");
    if (result) {
      await refreshChrome();
    }
  };

  const uploadLogo = async (file) => {
    if (!file) {
      return;
    }
    setBusy("Logo");
    setFlash("");
    const response = await fetch("/api/moon/v3/admin/settings/branding/logo", {
      method: "PUT",
      headers: {"Content-Type": file.type || "application/octet-stream"},
      body: await file.arrayBuffer()
    });
    const payload = await response.json().catch(() => ({}));
    setBusy("");
    if (!response.ok) {
      const message = formatDisplayValue(payload?.error, "Moon could not upload that logo.");
      setFlash(message);
      setFlashTone("bad");
      notify({message, tone: "bad", category: "action"});
      return;
    }
    setData((current) => ({...current, branding: payload.branding, publicBranding: payload.publicBranding}));
    clearDirty("branding");
    setDraft((current) => ({
      ...current,
      branding: {
        ...(current?.branding || {}),
        siteName: normalizeString(payload.branding?.siteName, normalizeString(payload.publicBranding?.siteName, current?.branding?.siteName || "Scriptarr"))
      }
    }));
    setFlash("Brand logo uploaded.");
    setFlashTone("good");
    notify({message: "Brand logo uploaded.", tone: "good", category: "action"});
    await refreshChrome();
    void refresh();
  };

  const removeLogo = async () => {
    await saveRequest("Brand logo", "/api/moon/v3/admin/settings/branding/logo", {
      method: "DELETE"
    }, (payload) => {
      setData((current) => ({...current, branding: payload.branding, publicBranding: payload.publicBranding}));
      setDraft((current) => ({
        ...current,
        branding: {
          ...(current?.branding || {}),
          siteName: normalizeString(payload.branding?.siteName, normalizeString(payload.publicBranding?.siteName, current?.branding?.siteName || "Scriptarr"))
        }
      }));
    }, "branding");
    await refreshChrome();
  };

  const saveToastDraft = async (kind) => {
    setBusy(kind);
    const result = kind === "global toasts"
      ? await saveGlobalPreferences(draft.globalToasts)
      : await savePersonalPreferences(draft.personalToasts);
    setBusy("");
    if (!result.ok) {
      setFlash(formatDisplayValue(result.payload?.error, "Moon could not save toast preferences."));
      setFlashTone("bad");
      return;
    }
    setData((current) => ({...current, toastSettings: result.payload}));
    setDraft((current) => ({
      ...current,
      personalToasts: normalizeToastDraft(result.payload?.personal || result.payload?.effective),
      globalToasts: normalizeToastDraft(result.payload?.global)
    }));
    clearDirty(kind === "global toasts" ? "globalToasts" : "personalToasts");
    setFlash(kind === "global toasts" ? "Global toast defaults saved." : "Personal toast preferences saved.");
    setFlashTone("good");
    await refreshToastSettings();
  };

  const saveVpn = async () => {
    await saveRequest("Raven VPN", "/api/moon/v3/admin/settings/raven/vpn", {
      method: "PUT",
      json: draft.ravenVpn
    }, (payload) => {
      const nextVpn = payload?.ravenVpn || payload || {};
      setData((current) => ({...current, ravenVpn: nextVpn}));
      setDraft((current) => clearVpnPasswordDraft({
        ...current,
        ravenVpn: {
          enabled: Boolean(nextVpn.enabled),
          region: normalizeString(nextVpn.region, current?.ravenVpn?.region || "us_california"),
          piaUsername: normalizeString(nextVpn.piaUsername),
          piaPassword: ""
        }
      }));
    }, "ravenVpn");
  };

  const resetPersonalToasts = () => {
    markDirty("personalToasts");
    setDraft((current) => ({
      ...current,
      personalToasts: normalizeToastDraft(current?.globalToasts)
    }));
  };

  if (loading || !draft) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">System</div>
        <h2>Loading Settings</h2>
        <p>Moon is loading brokered settings through Sage.</p>
      </section>
    );
  }

  return (
    <>
      {error ? <AdminActionBanner tone="bad">{error}</AdminActionBanner> : null}
      {flash ? <AdminActionBanner tone={flashTone}>{flash}</AdminActionBanner> : null}
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">General</div>
            <h2>Settings</h2>
            <p className="admin-muted">Branding, database visibility, notifications, and the compact operational settings that still belong here.</p>
          </div>
          <AdminStatusBadge tone={refreshing ? "warning" : "good"}>{refreshing ? "Refreshing" : "Live"}</AdminStatusBadge>
        </div>
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Database size</span><strong>{formatBytes(dbOverview?.totalBytes)}</strong></article>
          <article className="admin-metric-card"><span>Tables</span><strong>{dbOverview?.tableCount || 0}</strong></article>
          <article className="admin-metric-card"><span>Rows</span><strong>{dbOverview?.rowCount || 0}</strong></article>
          <article className="admin-metric-card"><span>Storage</span><strong>{dbOverview?.driver || "hidden"}</strong></article>
        </div>
        <div className="admin-action-row">
          <a className="admin-button solid" href={canDatabase ? payload.links?.databaseExplorer || "/admin/settings/database" : "#"} aria-disabled={!canDatabase}>Open database explorer</a>
          <a className="admin-button ghost" href={payload.links?.noonaProject} target="_blank" rel="noreferrer">The Noona Project</a>
          <a className="admin-button ghost" href={payload.links?.supportDiscord} target="_blank" rel="noreferrer">Get support</a>
        </div>
      </section>

      <section className="admin-settings-grid">
        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Branding</div>
              <h2>Brand and logo</h2>
            </div>
            <AdminStatusBadge tone={payload.publicBranding?.logo?.enabled ? "good" : "warning"}>{payload.publicBranding?.logo?.enabled ? "Logo" : "Default mark"}</AdminStatusBadge>
          </div>
          <div className="admin-brand-preview">
            <span className="admin-brand-mark preview">
              {logoUrl ? <img src={logoUrl} alt="" /> : "S"}
            </span>
            <div>
              <strong>{draft.branding.siteName}</strong>
              <p className="admin-muted">Used in admin chrome, user chrome, and install manifest metadata.</p>
            </div>
          </div>
          <div className="admin-logo-preview-row">
            {[
              {label: "Chrome", url: logoUrls.chrome},
              {label: "192", url: logoUrls.icon192},
              {label: "512", url: logoUrls.icon512}
            ].map((entry) => (
              <span key={entry.label}>
                {entry.url ? <img src={entry.url} alt="" /> : "S"}
                <em>{entry.label}</em>
              </span>
            ))}
          </div>
          <div className="admin-task-form">
            <label>
              <span>Site name</span>
              <input disabled={!canSave} value={draft.branding.siteName} onChange={(event) => patchDraft("branding", {siteName: event.target.value})} />
            </label>
            <label>
              <span>Logo upload</span>
              <input accept="image/png,image/jpeg,image/webp" disabled={!canSave || busy === "Logo"} type="file" onChange={(event) => void uploadLogo(event.target.files?.[0])} />
            </label>
          </div>
          <div className="admin-action-row">
            <button className="admin-button solid" type="button" disabled={!canSave || busy === "Branding"} onClick={() => void saveBranding()}>Save branding</button>
            <button className="admin-button ghost danger" type="button" disabled={!canSave || !payload.publicBranding?.logo?.enabled} onClick={() => void removeLogo()}>Remove logo</button>
          </div>
        </article>

        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Notifications</div>
              <h2>Toast preferences</h2>
            </div>
          </div>
          <h3>Personal</h3>
          <ToastPreferenceForm
            draft={draft.personalToasts}
            disabled={busy === "personal toasts"}
            onChange={(patch) => patchDraft("personalToasts", patch)}
          />
          <div className="admin-action-row">
            <button className="admin-button solid" type="button" disabled={busy === "personal toasts"} onClick={() => void saveToastDraft("personal toasts")}>Save personal</button>
            <button className="admin-button ghost" type="button" disabled={busy === "personal toasts"} onClick={resetPersonalToasts}>Reset to global</button>
          </div>
          <div className="admin-log-meta">
            <span>Effective live events: {payload.toastSettings?.effective?.liveEventToasts === false ? "off" : "on"}</span>
            <span>Failures only: {payload.toastSettings?.effective?.failuresOnly ? "yes" : "no"}</span>
          </div>
          {payload.toastSettings?.canEditGlobal || canRoot ? (
            <>
              <h3>Global defaults</h3>
              <ToastPreferenceForm
                draft={draft.globalToasts}
                disabled={busy === "global toasts" || !canRoot}
                onChange={(patch) => patchDraft("globalToasts", patch)}
              />
              <button className="admin-button ghost" type="button" disabled={busy === "global toasts" || !canRoot} onClick={() => void saveToastDraft("global toasts")}>Save global</button>
            </>
          ) : null}
        </article>
      </section>

      <section className="admin-settings-grid">
        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Raven</div>
              <h2>VPN</h2>
            </div>
            <AdminStatusBadge tone={draft.ravenVpn.enabled ? "good" : "warning"}>{draft.ravenVpn.enabled ? "enabled" : "disabled"}</AdminStatusBadge>
          </div>
          <div className="admin-task-form">
            <label>
              <span>Enabled</span>
              <select disabled={!canSave} value={draft.ravenVpn.enabled ? "true" : "false"} onChange={(event) => patchDraft("ravenVpn", {enabled: event.target.value === "true"})}>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </label>
            <label>
              <span>Region</span>
              <input disabled={!canSave} value={draft.ravenVpn.region} onChange={(event) => patchDraft("ravenVpn", {region: event.target.value})} />
            </label>
            <label>
              <span>PIA username</span>
              <input disabled={!canSave} value={draft.ravenVpn.piaUsername} onChange={(event) => patchDraft("ravenVpn", {piaUsername: event.target.value})} />
            </label>
            <label>
              <span>PIA password</span>
              <input disabled={!canSave} placeholder={payload.ravenVpn?.passwordConfigured ? "Configured - leave blank" : ""} type="password" value={draft.ravenVpn.piaPassword} onChange={(event) => patchDraft("ravenVpn", {piaPassword: event.target.value})} />
            </label>
          </div>
          <button className="admin-button solid" type="button" disabled={!canSave || busy === "Raven VPN"} onClick={() => void saveVpn()}>Save VPN</button>
          <div className="admin-log-meta">
            <span>Runtime: {payload.ravenVpnRuntime?.connected ? "connected" : "not connected"}</span>
            <span>Password: {payload.ravenVpn?.passwordConfigured ? "configured" : "missing"}</span>
            <span>Last error: {formatDisplayValue(payload.ravenVpnRuntime?.lastError, "none")}</span>
          </div>
        </article>

        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Requests</div>
              <h2>Workflow</h2>
            </div>
          </div>
          <ToggleRow
            checked={draft.requestWorkflow.autoApproveAndDownload}
            disabled={!canSave}
            label="Auto approve and download new requests"
            onChange={(autoApproveAndDownload) => patchDraft("requestWorkflow", {autoApproveAndDownload})}
          />
          <button className="admin-button solid" type="button" disabled={!canSave || busy === "Request workflow"} onClick={() => void saveRequest("Request workflow", "/api/moon/v3/admin/settings/request-workflow", {method: "PUT", json: draft.requestWorkflow}, null, "requestWorkflow")}>Save workflow</button>
        </article>
      </section>

      <section className="admin-settings-grid">
        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Metadata</div>
              <h2>{providerCounts.metadata} provider{providerCounts.metadata === 1 ? "" : "s"} enabled</h2>
            </div>
          </div>
          <ProviderList providers={draft.metadataProviders} disabled={!canSave} onChange={(id, patch) => patchProvider("metadataProviders", id, patch)} />
          <button className="admin-button solid" type="button" disabled={!canSave || busy === "Metadata providers"} onClick={() => void saveRequest("Metadata providers", "/api/moon/v3/admin/settings/raven/metadata", {method: "PUT", json: {providers: draft.metadataProviders}}, (providers) => setData((current) => ({...current, metadataProviders: providers})), "metadataProviders")}>Save metadata providers</button>
        </article>
        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Download</div>
              <h2>{providerCounts.download} provider{providerCounts.download === 1 ? "" : "s"} enabled</h2>
            </div>
          </div>
          <ProviderList providers={draft.downloadProviders} disabled={!canSave} onChange={(id, patch) => patchProvider("downloadProviders", id, patch)} />
          <button className="admin-button solid" type="button" disabled={!canSave || busy === "Download providers"} onClick={() => void saveRequest("Download providers", "/api/moon/v3/admin/settings/raven/download-providers", {method: "PUT", json: {providers: draft.downloadProviders}}, (providers) => setData((current) => ({...current, downloadProviders: providers})), "downloadProviders")}>Save download providers</button>
        </article>
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Discord</div>
            <h2>Portal basics</h2>
            <p className="admin-muted">Deep command mapping stays on the Discord page; these are the core runtime identifiers.</p>
          </div>
          <AdminStatusBadge tone={payload.discord?.runtime?.connected ? "good" : "warning"}>{payload.discord?.runtime?.connected ? "connected" : "degraded"}</AdminStatusBadge>
        </div>
        <div className="admin-task-form">
          <label>
            <span>Guild id</span>
            <input disabled={!canSave} value={draft.discord.guildId} onChange={(event) => patchDraft("discord", {guildId: event.target.value})} />
          </label>
          <label>
            <span>Superuser id</span>
            <input disabled={!canSave} value={draft.discord.superuserId} onChange={(event) => patchDraft("discord", {superuserId: event.target.value})} />
          </label>
          <label>
            <span>Onboarding channel</span>
            <input disabled={!canSave} value={draft.discord.onboarding.channelId} onChange={(event) => patchDraft("discord", {onboarding: {...draft.discord.onboarding, channelId: event.target.value}})} />
          </label>
          <label>
            <span>Onboarding template</span>
            <input disabled={!canSave} value={draft.discord.onboarding.template} onChange={(event) => patchDraft("discord", {onboarding: {...draft.discord.onboarding, template: event.target.value}})} />
          </label>
        </div>
        <div className="admin-action-row">
          <button className="admin-button solid" type="button" disabled={!canSave || busy === "Discord"} onClick={() => void saveRequest("Discord", "/api/moon/v3/admin/settings/portal/discord", {method: "PUT", json: draft.discord}, (discord) => setData((current) => ({...current, discord})), "discord")}>Save Discord basics</button>
          <a className="admin-button ghost" href="/admin/discord">Open Discord page</a>
        </div>
        <div className="admin-log-meta">
          <span>Registered guild: {formatDisplayValue(payload.discord?.runtime?.registeredGuildId, "unknown")}</span>
          <span>Commands: {normalizeArray(payload.discord?.runtime?.commandInventory).length}</span>
          <span>Generated: {formatDate(dbOverview?.generatedAt)}</span>
        </div>
      </section>
    </>
  );
};

export default SettingsPage;
