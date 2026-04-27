"use client";

/**
 * @file Purpose-built Users access-control page for Moon admin.
 */

import {useEffect, useMemo, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {
  buildGroupDraft,
  buildUserMetrics,
  filterUsers,
  grantLevels,
  patchGroupGrant,
  serializeGroupDraft
} from "../lib/adminUsers.js";
import {formatDate, formatDisplayValue, normalizeString} from "../lib/format.js";
import {AdminActionBanner, AdminDenseTable, AdminDrawer, AdminFilterBar, AdminStatusBadge} from "./AdminUi.jsx";
import {useAdminToast} from "./AdminToasts.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const emptyPayload = Object.freeze({
  users: [],
  groups: [],
  domains: [],
  defaultGroupId: "",
  events: []
});

const userKey = (user) => normalizeString(user.discordUserId, normalizeString(user.id));

const groupNames = (user) => normalizeArray(user.groups).map((group) => normalizeString(group.name, group.id)).join(", ") || "No groups";

const accessTone = (user) => {
  if (user.isOwner || user.role === "owner") {
    return "good";
  }
  return normalizeArray(user.accessSummary?.adminDomains).length ? "warning" : "";
};

/**
 * Render the group grant matrix.
 *
 * @param {{domains: string[], draft: any, disabled: boolean, onChange: (draft: any) => void}} props
 * @returns {import("react").ReactNode}
 */
const GrantMatrix = ({domains, draft, disabled, onChange}) => (
  <div className="admin-grant-matrix">
    {normalizeArray(domains).map((domain) => (
      <label key={domain}>
        <span>{domain}</span>
        <select
          disabled={disabled}
          value={draft.adminGrants?.[domain] || ""}
          onChange={(event) => onChange(patchGroupGrant(draft, domain, event.target.value))}
        >
          {grantLevels.map((level) => (
            <option key={level || "none"} value={level}>{level || "none"}</option>
          ))}
        </select>
      </label>
    ))}
  </div>
);

/**
 * Render the Moon admin users access-control console.
 *
 * @param {{user: any}} props
 * @returns {import("react").ReactNode}
 */
export const UsersPage = ({user}) => {
  const canRoot = hasAdminGrant(user, "users", "root");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedGroupIds, setSelectedGroupIds] = useState([]);
  const [groupDrawer, setGroupDrawer] = useState(null);
  const [flash, setFlash] = useState("");
  const [flashTone, setFlashTone] = useState("");
  const [busy, setBusy] = useState("");
  const {notify} = useAdminToast();
  const {loading, refreshing, error, data, refresh} = useAdminJson("/api/moon/v3/admin/users", {
    fallback: emptyPayload
  });
  useAdminEventStaleness({
    domains: ["auth", "users", "access"],
    enabled: true,
    locked: Boolean(busy || groupDrawer),
    onStale: () => {},
    onRefresh: refresh
  });

  const payload = data || emptyPayload;
  const users = normalizeArray(payload.users);
  const groups = normalizeArray(payload.groups);
  const domains = normalizeArray(payload.domains);
  const metrics = useMemo(() => buildUserMetrics(users, groups), [users, groups]);
  const visibleUsers = useMemo(() => filterUsers(users, {query, filter}), [users, query, filter]);
  const selectedUser = users.find((entry) => userKey(entry) === selectedUserId) || null;

  useEffect(() => {
    if (!selectedUserId && visibleUsers[0]) {
      setSelectedUserId(userKey(visibleUsers[0]));
    }
  }, [selectedUserId, visibleUsers]);

  useEffect(() => {
    setSelectedGroupIds(normalizeArray(selectedUser?.groups).map((group) => normalizeString(group.id)).filter(Boolean));
  }, [selectedUserId, selectedUser]);

  const setResult = (ok, message) => {
    setFlash(message);
    setFlashTone(ok ? "good" : "bad");
    notify({message, tone: ok ? "good" : "bad", category: "action"});
  };

  const toggleSelectedGroup = (groupId) => setSelectedGroupIds((current) => {
    const next = new Set(current);
    if (next.has(groupId)) {
      next.delete(groupId);
    } else {
      next.add(groupId);
    }
    return Array.from(next).sort();
  });

  const saveUserGroups = async () => {
    if (!selectedUser) {
      return;
    }
    setBusy("user-groups");
    const result = await requestJson(`/api/moon/v3/admin/users/${encodeURIComponent(userKey(selectedUser))}/groups`, {
      method: "PUT",
      json: {groupIds: selectedGroupIds}
    });
    setBusy("");
    setResult(result.ok, result.ok ? "User access groups saved." : result.payload?.error || "Moon could not save user groups.");
    if (result.ok) {
      await refresh();
    }
  };

  const deleteSelectedUser = async () => {
    if (!selectedUser || !window.confirm(`Remove local access for ${selectedUser.username}?`)) {
      return;
    }
    setBusy("delete-user");
    const result = await requestJson(`/api/moon/v3/admin/users/${encodeURIComponent(userKey(selectedUser))}`, {
      method: "DELETE"
    });
    setBusy("");
    setResult(result.ok, result.ok ? "User access removed." : result.payload?.error || "Moon could not remove that user.");
    if (result.ok) {
      setSelectedUserId("");
      await refresh();
    }
  };

  const openGroupDrawer = (group = null) => setGroupDrawer({
    mode: group ? "edit" : "create",
    draft: buildGroupDraft(group || {name: "", description: "", permissions: [], adminGrants: {}})
  });

  const saveGroup = async () => {
    const draft = groupDrawer?.draft;
    if (!draft) {
      return;
    }
    const payloadBody = serializeGroupDraft(draft);
    setBusy("group");
    const result = await requestJson(groupDrawer.mode === "edit"
      ? `/api/moon/v3/admin/users/groups/${encodeURIComponent(draft.id)}`
      : "/api/moon/v3/admin/users/groups", {
      method: groupDrawer.mode === "edit" ? "PATCH" : "POST",
      json: payloadBody
    });
    setBusy("");
    setResult(result.ok, result.ok ? "Permission group saved." : result.payload?.error || "Moon could not save that permission group.");
    if (result.ok) {
      setGroupDrawer(null);
      await refresh();
    }
  };

  const deleteGroup = async (group) => {
    if (!group || !window.confirm(`Delete the ${group.name} permission group?`)) {
      return;
    }
    setBusy(`group-${group.id}`);
    const result = await requestJson(`/api/moon/v3/admin/users/groups/${encodeURIComponent(group.id)}`, {
      method: "DELETE"
    });
    setBusy("");
    setResult(result.ok, result.ok ? "Permission group deleted." : result.payload?.error || "Moon could not delete that group.");
    if (result.ok) {
      await refresh();
    }
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">Community</div>
        <h2>Loading Users</h2>
        <p>Moon is loading Discord-linked users, permission groups, and access events.</p>
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
            <div className="admin-kicker">Community</div>
            <h2>Users</h2>
            <p className="admin-muted">Discord-linked members, reusable permission groups, assignments, and access events.</p>
          </div>
          <AdminStatusBadge tone={refreshing ? "warning" : "good"}>{refreshing ? "Refreshing" : "Live"}</AdminStatusBadge>
        </div>
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Total users</span><strong>{metrics.total}</strong></article>
          <article className="admin-metric-card"><span>Admins</span><strong>{metrics.admins}</strong></article>
          <article className="admin-metric-card"><span>Readers</span><strong>{metrics.readers}</strong></article>
          <article className="admin-metric-card"><span>Groups</span><strong>{metrics.groups}</strong></article>
        </div>
        <AdminFilterBar>
          <label className="admin-filter-grow">
            <span>Search</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="User, Discord id, group..." />
          </label>
          <label>
            <span>Filter</span>
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">All</option>
              <option value="owners">Owners</option>
              <option value="admins">Admins</option>
              <option value="readers">Readers</option>
            </select>
          </label>
        </AdminFilterBar>
      </section>

      <section className="admin-users-layout">
        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Directory</div>
              <h2>{visibleUsers.length} visible</h2>
            </div>
          </div>
          <AdminDenseTable
            rows={visibleUsers}
            getKey={(row) => userKey(row)}
            selectedKey={selectedUserId}
            onRowClick={(row) => setSelectedUserId(userKey(row))}
            columns={[
              {key: "username", label: "User", render: (row) => <strong>{formatDisplayValue(row.username, "Unknown")}</strong>},
              {key: "role", label: "Access", render: (row) => <AdminStatusBadge tone={accessTone(row)}>{formatDisplayValue(row.accessSummary?.label, row.role)}</AdminStatusBadge>},
              {key: "groups", label: "Groups", render: groupNames},
              {key: "updatedAt", label: "Updated", render: (row) => formatDate(row.updatedAt)}
            ]}
            empty="No users match this filter."
          />
        </article>

        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Groups</div>
              <h2>Permission groups</h2>
            </div>
            <button className="admin-button solid" type="button" disabled={!canRoot} onClick={() => openGroupDrawer()}>Create group</button>
          </div>
          <AdminDenseTable
            rows={groups}
            getKey={(row) => row.id}
            columns={[
              {key: "name", label: "Name", render: (row) => <strong>{row.name}</strong>},
              {key: "default", label: "Default", render: (row) => row.isDefault ? <AdminStatusBadge tone="good">default</AdminStatusBadge> : ""},
              {key: "grants", label: "Admin grants", render: (row) => Object.entries(row.adminGrants || {}).map(([domain, level]) => `${domain}:${level}`).join(", ") || "Reader only"},
              {key: "actions", label: "", render: (row) => (
                <div className="admin-table-actions">
                  <button className="admin-button ghost small" type="button" disabled={!canRoot} onClick={() => openGroupDrawer(row)}>Edit</button>
                  <button className="admin-button ghost danger small" type="button" disabled={!canRoot || row.isDefault || busy === `group-${row.id}`} onClick={() => void deleteGroup(row)}>Delete</button>
                </div>
              )}
            ]}
            empty="No permission groups exist yet."
          />
        </article>
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Audit</div>
            <h2>Recent access events</h2>
          </div>
        </div>
        <AdminDenseTable
          rows={normalizeArray(payload.events).slice(0, 20)}
          getKey={(row, index) => normalizeString(row.eventId, `event-${index}`)}
          columns={[
            {key: "createdAt", label: "Time", render: (row) => formatDate(row.createdAt)},
            {key: "eventType", label: "Event", render: (row) => <strong>{row.eventType}</strong>},
            {key: "actor", label: "Actor", render: (row) => formatDisplayValue(row.actorLabel, row.actorId || row.actorType)},
            {key: "message", label: "Message", render: (row) => <span className="admin-table-message">{row.message}</span>}
          ]}
          empty="No recent access events."
        />
      </section>

      <AdminDrawer
        open={Boolean(selectedUser)}
        title={normalizeString(selectedUser?.username, "User detail")}
        kicker="User"
        onClose={() => setSelectedUserId("")}
      >
        {selectedUser ? (
          <div className="admin-drawer-stack">
            <div className="admin-detail-grid">
              <span><strong>Discord id</strong>{selectedUser.discordUserId}</span>
              <span><strong>Role</strong>{selectedUser.role}</span>
              <span><strong>Access</strong>{formatDisplayValue(selectedUser.accessSummary?.label, "Reader access")}</span>
              <span><strong>Updated</strong>{formatDate(selectedUser.updatedAt)}</span>
            </div>
            <div className="admin-checkbox-grid">
              {groups.map((group) => (
                <label key={group.id}>
                  <input
                    type="checkbox"
                    checked={selectedGroupIds.includes(group.id)}
                    disabled={!canRoot || selectedUser.isOwner || selectedUser.role === "owner"}
                    onChange={() => toggleSelectedGroup(group.id)}
                  />
                  <span>{group.name}</span>
                </label>
              ))}
            </div>
            <div className="admin-action-row">
              <button className="admin-button solid" type="button" disabled={!canRoot || selectedUser.isOwner || selectedUser.role === "owner" || busy === "user-groups"} onClick={() => void saveUserGroups()}>Save groups</button>
              <button className="admin-button ghost danger" type="button" disabled={!canRoot || selectedUser.isOwner || selectedUser.role === "owner" || busy === "delete-user"} onClick={() => void deleteSelectedUser()}>Remove local access</button>
            </div>
            {(selectedUser.isOwner || selectedUser.role === "owner") ? <AdminActionBanner tone="warning">The bootstrap owner is protected from reassignment and removal.</AdminActionBanner> : null}
          </div>
        ) : null}
      </AdminDrawer>

      <AdminDrawer
        open={Boolean(groupDrawer)}
        title={groupDrawer?.mode === "edit" ? "Edit permission group" : "Create permission group"}
        kicker="Access"
        onClose={() => setGroupDrawer(null)}
      >
        {groupDrawer ? (
          <div className="admin-drawer-stack">
            <div className="admin-task-form">
              <label>
                <span>Name</span>
                <input value={groupDrawer.draft.name} onChange={(event) => setGroupDrawer((current) => ({...current, draft: {...current.draft, name: event.target.value}}))} />
              </label>
              <label>
                <span>Default group</span>
                <select value={groupDrawer.draft.isDefault ? "true" : "false"} onChange={(event) => setGroupDrawer((current) => ({...current, draft: {...current.draft, isDefault: event.target.value === "true"}}))}>
                  <option value="false">No</option>
                  <option value="true">Yes</option>
                </select>
              </label>
              <label>
                <span>Capabilities</span>
                <input value={groupDrawer.draft.permissionsText} onChange={(event) => setGroupDrawer((current) => ({...current, draft: {...current.draft, permissionsText: event.target.value}}))} placeholder="read_library, create_requests" />
              </label>
            </div>
            <label className="admin-full-field">
              <span>Description</span>
              <textarea rows={3} value={groupDrawer.draft.description} onChange={(event) => setGroupDrawer((current) => ({...current, draft: {...current.draft, description: event.target.value}}))} />
            </label>
            <GrantMatrix
              domains={domains}
              draft={groupDrawer.draft}
              disabled={!canRoot}
              onChange={(draft) => setGroupDrawer((current) => ({...current, draft}))}
            />
            <button className="admin-button solid" type="button" disabled={!canRoot || busy === "group"} onClick={() => void saveGroup()}>Save group</button>
          </div>
        ) : null}
      </AdminDrawer>
    </>
  );
};

export default UsersPage;
