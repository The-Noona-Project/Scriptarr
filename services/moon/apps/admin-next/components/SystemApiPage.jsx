"use client";

/**
 * @file API key management page for Moon admin.
 */

import {useMemo, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {formatDate, formatDisplayValue, normalizeString} from "../lib/format.js";
import {AdminActionBanner, AdminDenseTable, AdminDrawer, AdminStatusBadge} from "./AdminUi.jsx";
import {useAdminToast} from "./AdminToasts.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const emptyPayload = Object.freeze({
  settings: {enabled: false, keyConfigured: false},
  groups: [],
  systemKeys: [],
  userKeys: [],
  docsUrl: "/api/public/docs",
  openApiUrl: "/api/public/openapi.json"
});

const keyStatus = (key) => {
  if (key?.revokedAt) {
    return "revoked";
  }
  return key?.enabled === false ? "disabled" : "enabled";
};

const statusTone = (status) => {
  if (status === "enabled") {
    return "good";
  }
  if (status === "disabled") {
    return "warning";
  }
  return "bad";
};

const groupLabel = (groupsById, groupId) => groupsById.get(groupId)?.name || groupId;

/**
 * Render the Moon admin API key management page.
 *
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const SystemApiPage = ({user}) => {
  const canRoot = hasAdminGrant(user, "publicapi", "root");
  const [flash, setFlash] = useState("");
  const [flashTone, setFlashTone] = useState("");
  const [secret, setSecret] = useState("");
  const [drawer, setDrawer] = useState(null);
  const [busy, setBusy] = useState("");
  const {notify} = useAdminToast();
  const {loading, refreshing, error, data, refresh, setData} = useAdminJson("/api/moon/v3/admin/system/api", {
    fallback: emptyPayload
  });
  useAdminEventStaleness({
    domains: ["publicapi"],
    enabled: true,
    locked: refreshing,
    onStale: () => {},
    onRefresh: refresh
  });

  const payload = data || emptyPayload;
  const groupsById = useMemo(() => new Map(normalizeArray(payload.groups).map((group) => [group.id, group])), [payload.groups]);
  const systemKeys = normalizeArray(payload.systemKeys);
  const userKeys = normalizeArray(payload.userKeys);

  const openCreateDrawer = () => setDrawer({
    mode: "create",
    name: "",
    enabled: true,
    groupIds: []
  });

  const openEditDrawer = (apiKey) => setDrawer({
    mode: "edit",
    id: apiKey.id,
    name: normalizeString(apiKey.name),
    enabled: apiKey.enabled !== false,
    groupIds: normalizeArray(apiKey.groupIds)
  });

  const patchDrawer = (patch) => setDrawer((current) => ({...(current || {}), ...patch}));

  const toggleGroup = (groupId) => {
    const current = new Set(normalizeArray(drawer?.groupIds));
    if (current.has(groupId)) {
      current.delete(groupId);
    } else {
      current.add(groupId);
    }
    patchDrawer({groupIds: Array.from(current).sort()});
  };

  const saveSettings = async (enabled) => {
    setBusy("settings");
    setFlash("");
    const result = await requestJson("/api/moon/v3/admin/system/api/settings", {
      method: "PUT",
      json: {enabled}
    });
    setBusy("");
    if (!result.ok) {
      setFlash(formatDisplayValue(result.payload?.error, "Moon could not update API settings."));
      setFlashTone("bad");
      notify({message: formatDisplayValue(result.payload?.error, "Moon could not update API settings."), tone: "bad", category: "action"});
      return;
    }
    setData(result.payload || payload);
    setFlash(enabled ? "Public API enabled." : "Public API disabled.");
    setFlashTone("good");
    notify({message: enabled ? "Public API enabled." : "Public API disabled.", tone: "good", category: "action"});
  };

  const saveKey = async () => {
    if (!drawer) {
      return;
    }
    setBusy("key");
    setFlash("");
    const result = await requestJson(drawer.mode === "edit"
      ? `/api/moon/v3/admin/system/api/keys/${encodeURIComponent(drawer.id)}`
      : "/api/moon/v3/admin/system/api/keys", {
      method: drawer.mode === "edit" ? "PATCH" : "POST",
      json: {
        name: drawer.name,
        enabled: drawer.enabled,
        groupIds: normalizeArray(drawer.groupIds)
      }
    });
    setBusy("");
    if (!result.ok) {
      setFlash(formatDisplayValue(result.payload?.error, "Moon could not save the API key."));
      setFlashTone("bad");
      notify({message: formatDisplayValue(result.payload?.error, "Moon could not save the API key."), tone: "bad", category: "action"});
      return;
    }
    if (result.payload?.secret) {
      setSecret(result.payload.secret);
    }
    setDrawer(null);
    setFlash(drawer.mode === "edit" ? "System API key updated." : "System API key created.");
    setFlashTone("good");
    notify({message: drawer.mode === "edit" ? "System API key updated." : "System API key created.", tone: "good", category: "action"});
    void refresh();
  };

  const revokeKey = async (apiKey) => {
    setBusy(apiKey.id);
    setFlash("");
    const result = await requestJson(`/api/moon/v3/admin/system/api/keys/${encodeURIComponent(apiKey.id)}`, {
      method: "DELETE"
    });
    setBusy("");
    if (!result.ok) {
      setFlash(formatDisplayValue(result.payload?.error, "Moon could not revoke the API key."));
      setFlashTone("bad");
      notify({message: formatDisplayValue(result.payload?.error, "Moon could not revoke the API key."), tone: "bad", category: "action"});
      return;
    }
    setFlash("API key revoked.");
    setFlashTone("good");
    notify({message: "API key revoked.", tone: "good", category: "action"});
    void refresh();
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">System</div>
        <h2>Loading API</h2>
        <p>Moon is loading public API settings and key state through Sage.</p>
      </section>
    );
  }

  return (
    <>
      {error ? <AdminActionBanner tone="bad">{error}</AdminActionBanner> : null}
      {flash ? <AdminActionBanner tone={flashTone}>{flash}</AdminActionBanner> : null}
      {secret ? (
        <section className="admin-secret-panel" aria-live="polite">
          <div>
            <div className="admin-kicker">One-time key</div>
            <strong>{secret}</strong>
            <p className="admin-muted">This secret is shown once. Store it before leaving the page.</p>
          </div>
          <button className="admin-button" type="button" onClick={() => void navigator.clipboard?.writeText(secret)}>Copy</button>
        </section>
      ) : null}

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">System</div>
            <h2>API</h2>
            <p className="admin-muted">Manage system automation keys, personal key audit, and OpenAPI docs.</p>
          </div>
          <AdminStatusBadge tone={payload.settings?.enabled ? "good" : "warning"}>
            {payload.settings?.enabled ? "Enabled" : "Disabled"}
          </AdminStatusBadge>
        </div>
        <div className="admin-action-row">
          <a className="admin-button solid" href={payload.docsUrl || "/api/public/docs"} target="_blank" rel="noreferrer">Open Swagger</a>
          <a className="admin-button ghost" href={payload.openApiUrl || "/api/public/openapi.json"} target="_blank" rel="noreferrer">OpenAPI JSON</a>
          <button className="admin-button" type="button" disabled={!canRoot || busy === "settings"} onClick={() => void saveSettings(!payload.settings?.enabled)}>
            {payload.settings?.enabled ? "Disable API" : "Enable API"}
          </button>
        </div>
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">System keys</div>
            <h2>{systemKeys.length} key{systemKeys.length === 1 ? "" : "s"}</h2>
          </div>
          <button className="admin-button solid" type="button" disabled={!canRoot} onClick={openCreateDrawer}>Create key</button>
        </div>
        <AdminDenseTable
          rows={systemKeys}
          getKey={(row) => row.id}
          columns={[
            {key: "name", label: "Name", render: (row) => <strong>{formatDisplayValue(row.name, "System key")}</strong>},
            {key: "status", label: "Status", render: (row) => <AdminStatusBadge tone={statusTone(keyStatus(row))}>{keyStatus(row)}</AdminStatusBadge>},
            {key: "groups", label: "Permission groups", render: (row) => normalizeArray(row.groupIds).length ? normalizeArray(row.groupIds).map((id) => groupLabel(groupsById, id)).join(", ") : "No groups"},
            {key: "lastUsedAt", label: "Last used", render: (row) => row.lastUsedAt ? formatDate(row.lastUsedAt) : "Never"},
            {key: "createdBy", label: "Created by", render: (row) => formatDisplayValue(row.createdBy?.actorLabel, "Unknown")},
            {key: "actions", label: "", render: (row) => (
              <div className="admin-table-actions">
                <button className="admin-button ghost" type="button" disabled={!canRoot} onClick={() => openEditDrawer(row)}>Edit</button>
                <button className="admin-button ghost danger" type="button" disabled={!canRoot || busy === row.id || Boolean(row.revokedAt)} onClick={() => void revokeKey(row)}>Revoke</button>
              </div>
            )}
          ]}
          empty="No system API keys have been created yet."
        />
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">User keys</div>
            <h2>{userKeys.length} personal key{userKeys.length === 1 ? "" : "s"}</h2>
          </div>
        </div>
        <AdminDenseTable
          rows={userKeys}
          getKey={(row) => row.id}
          columns={[
            {key: "name", label: "Name", render: (row) => <strong>{formatDisplayValue(row.name, "User key")}</strong>},
            {key: "owner", label: "Owner", render: (row) => formatDisplayValue(row.ownerDiscordUserId, "Unknown")},
            {key: "status", label: "Status", render: (row) => <AdminStatusBadge tone={statusTone(keyStatus(row))}>{keyStatus(row)}</AdminStatusBadge>},
            {key: "lastUsedAt", label: "Last used", render: (row) => row.lastUsedAt ? formatDate(row.lastUsedAt) : "Never"},
            {key: "actions", label: "", render: (row) => (
              <button className="admin-button ghost danger" type="button" disabled={!canRoot || busy === row.id || Boolean(row.revokedAt)} onClick={() => void revokeKey(row)}>Revoke</button>
            )}
          ]}
          empty={payload.canAuditUserKeys ? "No personal API keys have been created yet." : "Root API access is required to audit personal keys."}
        />
      </section>

      <AdminDrawer
        open={Boolean(drawer)}
        title={drawer?.mode === "edit" ? "Edit system key" : "Create system key"}
        kicker="API"
        onClose={() => setDrawer(null)}
      >
        <div className="admin-task-form">
          <label>
            <span>Name</span>
            <input value={drawer?.name || ""} onChange={(event) => patchDrawer({name: event.target.value})} />
          </label>
          <label>
            <span>Status</span>
            <select value={drawer?.enabled === false ? "false" : "true"} onChange={(event) => patchDrawer({enabled: event.target.value === "true"})}>
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          </label>
        </div>
        <div className="admin-checkbox-grid">
          {normalizeArray(payload.groups).map((group) => (
            <label key={group.id}>
              <input
                type="checkbox"
                checked={normalizeArray(drawer?.groupIds).includes(group.id)}
                onChange={() => toggleGroup(group.id)}
              />
              <span>{group.name}</span>
            </label>
          ))}
        </div>
        <button className="admin-button solid" type="button" disabled={busy === "key"} onClick={() => void saveKey()}>
          {drawer?.mode === "edit" ? "Save key" : "Create key"}
        </button>
      </AdminDrawer>
    </>
  );
};

export default SystemApiPage;
