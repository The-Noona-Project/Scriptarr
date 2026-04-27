"use client";

/**
 * @file Dedicated Discord settings page for Moon admin.
 */

import {useEffect, useMemo, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {buildDiscordCommandRows, normalizeDiscordSettings} from "../lib/adminDiscord.js";
import {formatDate, formatDisplayValue, normalizeString} from "../lib/format.js";
import {AdminActionBanner, AdminDenseTable, AdminStatusBadge} from "./AdminUi.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const patchNested = (source, key, patch) => ({
  ...source,
  [key]: {
    ...(source[key] || {}),
    ...patch
  }
});

/**
 * Render the dedicated Discord admin page.
 *
 * @param {{user: Record<string, any>}} props
 * @returns {import("react").ReactNode}
 */
export const DiscordPage = ({user}) => {
  const {loading, refreshing, error, data, refresh, setData} = useAdminJson("/api/moon/v3/admin/discord", {
    fallback: {settings: normalizeDiscordSettings({}), runtime: {}, commandCatalog: []}
  });
  const [draft, setDraft] = useState(() => normalizeDiscordSettings({}));
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const live = useAdminEventStaleness({
    domains: ["discord"],
    locked: busy !== "",
    onStale: () => {},
    onRefresh: refresh
  });
  const canWrite = hasAdminGrant(user, "discord", "write");

  useEffect(() => {
    setDraft(normalizeDiscordSettings(data?.settings));
  }, [data?.settings]);

  const commandRows = useMemo(() => buildDiscordCommandRows(
    draft,
    data?.commandCatalog,
    data?.runtime?.commandInventory
  ), [data?.commandCatalog, data?.runtime?.commandInventory, draft]);

  const setField = (patch) => setDraft((current) => ({...current, ...patch}));
  const setOnboarding = (patch) => setDraft((current) => patchNested(current, "onboarding", patch));
  const setNotifications = (patch) => setDraft((current) => patchNested(current, "notifications", patch));
  const setCommand = (id, patch) => setDraft((current) => ({
    ...current,
    commands: {
      ...current.commands,
      [id]: {
        ...(current.commands[id] || {enabled: true, roleId: ""}),
        ...patch
      }
    }
  }));

  const runAction = async (label, url, options = {}, onSuccess = null) => {
    setBusy(label);
    setNotice("");
    setFailure("");
    const result = await requestJson(url, options);
    setBusy("");
    if (!result.ok) {
      setFailure(result.payload?.error || `${label} failed.`);
      return;
    }
    onSuccess?.(result.payload);
    setNotice(`${label} completed.`);
  };

  const save = () => runAction(
    "Save Discord settings",
    "/api/moon/v3/admin/discord",
    {method: "PUT", json: draft},
    (payload) => {
      setData(payload);
      setDraft(normalizeDiscordSettings(payload?.settings));
    }
  );

  const reload = () => runAction(
    "Reload Discord runtime",
    "/api/moon/v3/admin/discord/runtime/reload",
    {method: "POST", json: {}},
    setData
  );

  const testOnboarding = () => runAction(
    "Send onboarding test",
    "/api/moon/v3/admin/discord/onboarding/test",
    {method: "POST", json: {...draft, username: user?.username || "Admin"}}
  );

  const testRelease = () => runAction(
    "Send release test",
    "/api/moon/v3/admin/discord/release-notifications/test",
    {method: "POST", json: draft}
  );

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">System</div>
        <h2>Loading Discord</h2>
        <p>Moon is loading Portal Discord settings and runtime state.</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="admin-panel admin-state-panel is-danger">
        <div className="admin-kicker">System</div>
        <h2>Discord unavailable</h2>
        <p>{error}</p>
      </section>
    );
  }

  const runtime = data?.runtime || {};
  const commandCount = normalizeArray(runtime.commandInventory).length;

  return (
    <>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">System</div>
            <h2>Discord</h2>
            <p className="admin-muted">Guild workflow settings, slash-command access, onboarding, and release posts.</p>
          </div>
          <AdminStatusBadge tone={runtime.connected ? "good" : "warning"}>
            {refreshing ? "refreshing" : runtime.connected ? "connected" : formatDisplayValue(runtime.connectionState, "degraded")}
          </AdminStatusBadge>
        </div>
        {failure ? <AdminActionBanner tone="bad">{failure}</AdminActionBanner> : null}
        {notice ? <AdminActionBanner tone="good">{notice}</AdminActionBanner> : null}
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Auth</span><strong>{runtime.authConfigured ? "configured" : "missing"}</strong></article>
          <article className="admin-metric-card"><span>Bot token</span><strong>{runtime.botTokenConfigured ? "configured" : "missing"}</strong></article>
          <article className="admin-metric-card"><span>Registered guild</span><strong>{formatDisplayValue(runtime.registeredGuildId, "unknown")}</strong></article>
          <article className="admin-metric-card"><span>Commands</span><strong>{commandCount}</strong></article>
        </div>
        <div className="admin-log-meta">
          <span>Live stream: {live.state}</span>
          <span>Last sync: {formatDate(runtime.portal?.runtime?.lastSyncAt || runtime.lastSyncAt)}</span>
          <span>Warning: {formatDisplayValue(runtime.warning || runtime.syncError || runtime.error, "none")}</span>
        </div>
      </section>

      <section className="admin-settings-grid">
        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Guild</div>
              <h2>Runtime identifiers</h2>
            </div>
          </div>
          <div className="admin-task-form">
            <label>
              <span>Guild id</span>
              <input disabled={!canWrite} value={draft.guildId} onChange={(event) => setField({guildId: event.target.value})} />
            </label>
            <label>
              <span>Superuser id</span>
              <input disabled={!canWrite} value={draft.superuserId} onChange={(event) => setField({superuserId: event.target.value})} />
            </label>
            <label>
              <span>Release channel id</span>
              <input disabled={!canWrite} value={draft.notifications.releaseChannelId} onChange={(event) => setNotifications({releaseChannelId: event.target.value})} />
            </label>
          </div>
          <div className="admin-action-row">
            <button className="admin-button solid" type="button" disabled={!canWrite || busy !== ""} onClick={save}>Save settings</button>
            <button className="admin-button ghost" type="button" disabled={!canWrite || busy !== ""} onClick={reload}>Reload runtime</button>
            <button className="admin-button ghost" type="button" disabled={!canWrite || busy !== "" || !draft.notifications.releaseChannelId} onClick={testRelease}>Test release post</button>
          </div>
        </article>

        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Onboarding</div>
              <h2>Welcome message</h2>
            </div>
          </div>
          <div className="admin-task-form">
            <label>
              <span>Channel id</span>
              <input disabled={!canWrite} value={draft.onboarding.channelId} onChange={(event) => setOnboarding({channelId: event.target.value})} />
            </label>
            <label>
              <span>Template</span>
              <textarea disabled={!canWrite} rows={5} value={draft.onboarding.template} onChange={(event) => setOnboarding({template: event.target.value})} />
            </label>
          </div>
          <div className="admin-action-row">
            <button className="admin-button ghost" type="button" disabled={!canWrite || busy !== "" || !draft.onboarding.channelId} onClick={testOnboarding}>Send onboarding test</button>
          </div>
          <p className="admin-muted">Supported placeholders: {"{siteName}"}, {"{username}"}, {"{user_mention}"}, {"{guild_name}"}, {"{guild_id}"}, {"{moon_url}"}.</p>
        </article>
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Commands</div>
            <h2>{commandRows.length} command{commandRows.length === 1 ? "" : "s"}</h2>
            <p className="admin-muted">Enable commands and assign required Discord role ids where the command supports role gates.</p>
          </div>
        </div>
        <AdminDenseTable
          rows={commandRows}
          getKey={(row) => row.id}
          columns={[
            {key: "enabled", label: "Enabled", render: (row) => (
              <input
                aria-label={`${row.label} enabled`}
                checked={row.enabled}
                disabled={!canWrite}
                type="checkbox"
                onChange={(event) => setCommand(row.id, {enabled: event.target.checked})}
              />
            )},
            {key: "command", label: "Command", render: (row) => (
              <span>
                <strong>{row.label}</strong>
                <br />
                <span className="admin-muted">{row.description}</span>
              </span>
            )},
            {key: "status", label: "Status", render: (row) => <AdminStatusBadge tone={row.registered ? "good" : "warning"}>{row.status}</AdminStatusBadge>},
            {key: "scope", label: "Scope", render: (row) => row.ownerOnly ? "owner DM" : row.scope},
            {key: "role", label: "Required role id", render: (row) => row.roleManaged ? (
              <input
                aria-label={`${row.label} role id`}
                disabled={!canWrite || !row.enabled}
                value={draft.commands[row.id]?.roleId || ""}
                onChange={(event) => setCommand(row.id, {roleId: event.target.value})}
                placeholder="Optional role id"
              />
            ) : "owner only"}
          ]}
        />
      </section>
    </>
  );
};

export default DiscordPage;
