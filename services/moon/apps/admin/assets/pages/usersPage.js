import {escapeHtml, renderAvatar, renderChipList, renderEmptyState, renderStatusBadge} from "../dom.js";
import {formatDate} from "../format.js";

const BASELINE_CAPABILITIES = Object.freeze([
  {id: "read_library", label: "Read library"},
  {id: "create_requests", label: "Create requests"},
  {id: "read_requests", label: "Read requests"},
  {id: "read_ai_status", label: "Read AI status"}
]);

const ACCESS_LEVELS = Object.freeze([
  {id: "", label: "None"},
  {id: "read", label: "Read"},
  {id: "write", label: "Write"},
  {id: "root", label: "Root"}
]);

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const encodeJson = (value) => JSON.stringify(value)
  .replace(/</g, "\\u003c")
  .replace(/>/g, "\\u003e")
  .replace(/&/g, "\\u0026")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");

const parseJsonNode = (root, selector, fallback = null) => {
  try {
    return JSON.parse(root.querySelector(selector)?.textContent || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};

const userIdentity = (user) => normalizeString(user?.discordUserId);
const groupIdentity = (group) => normalizeString(group?.id);

const buildUserEventIndex = (events = []) => {
  const index = new Map();
  for (const event of normalizeArray(events)) {
    const candidates = [
      normalizeString(event.actorId),
      normalizeString(event.targetType) === "user" ? normalizeString(event.targetId) : "",
      normalizeString(event.metadata?.discordUserId)
    ].filter(Boolean);
    for (const discordUserId of candidates) {
      const existing = index.get(discordUserId) || {lastActivityAt: "", lastLoginAt: ""};
      const createdAt = normalizeString(event.createdAt);
      if (!existing.lastActivityAt || createdAt > existing.lastActivityAt) {
        existing.lastActivityAt = createdAt;
      }
      if (
        normalizeString(event.domain) === "auth"
        && ["login", "logout", "bootstrap-owner"].includes(normalizeString(event.eventType))
        && (!existing.lastLoginAt || createdAt > existing.lastLoginAt)
      ) {
        existing.lastLoginAt = createdAt;
      }
      index.set(discordUserId, existing);
    }
  }
  return index;
};

const buildGroupMemberCounts = (groups = [], users = []) => {
  const counts = new Map(normalizeArray(groups).map((group) => [groupIdentity(group), 0]));
  for (const user of normalizeArray(users)) {
    for (const group of normalizeArray(user.groups)) {
      const groupId = groupIdentity(group);
      counts.set(groupId, (counts.get(groupId) || 0) + 1);
    }
  }
  return counts;
};

const matchesUserSearch = (user, query) => {
  const normalizedQuery = normalizeString(query).toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const haystack = [
    normalizeString(user.username),
    normalizeString(user.discordUserId),
    normalizeString(user.role),
    normalizeString(user.accessSummary?.label),
    ...normalizeArray(user.groups).map((group) => normalizeString(group.name)),
    ...normalizeArray(user.baselinePermissions)
  ].join(" ").toLowerCase();
  return haystack.includes(normalizedQuery);
};

const summarizeUserGrants = (user) => {
  const summary = user?.accessSummary || {};
  const rootDomains = normalizeArray(summary.rootDomains).map((domain) => `${domain}.root`);
  const adminDomains = normalizeArray(summary.adminDomains)
    .filter((domain) => !normalizeArray(summary.rootDomains).includes(domain))
    .slice(0, 6)
    .map((domain) => `${domain}.${normalizeString(user?.adminGrants?.[domain], "read")}`);
  return [...rootDomains, ...adminDomains];
};

const renderEventFeed = (events = []) => {
  const items = normalizeArray(events);
  if (!items.length) {
    return renderEmptyState("No recent access activity", "Auth, group changes, and access updates will land here once Scriptarr starts recording them.");
  }

  return `
    <div class="event-feed">
      ${items.map((event) => `
        <article class="event-feed-card">
          <div class="event-feed-head">
            <div>
              <strong>${escapeHtml(normalizeString(event.message, "Scriptarr recorded an event."))}</strong>
              <div class="event-feed-meta">
                ${renderStatusBadge(normalizeString(event.domain, "system"))}
                ${renderStatusBadge(normalizeString(event.eventType, "updated"))}
                <span>${escapeHtml(normalizeString(event.actorLabel, normalizeString(event.actorId, "system")))}</span>
              </div>
            </div>
            <span class="muted-copy">${escapeHtml(formatDate(event.createdAt, {includeTime: true}))}</span>
          </div>
          ${Object.keys(event.metadata || {}).length ? `<p>${escapeHtml(JSON.stringify(event.metadata))}</p>` : ""}
        </article>
      `).join("")}
    </div>
  `;
};

const renderUserCard = (user, selectedUserId, eventIndex) => {
  const discordUserId = userIdentity(user);
  const activity = eventIndex.get(discordUserId) || {};
  const isSelected = discordUserId === selectedUserId;
  return `
    <article class="access-user-card ${isSelected ? "is-selected" : ""} ${user.isOwner ? "is-owner" : ""}" data-user-id="${escapeHtml(discordUserId)}">
      <div class="access-user-card-main" data-action="select-user" data-user-id="${escapeHtml(discordUserId)}">
        <div class="access-user-card-head">
          <div class="access-user-identity">
            ${renderAvatar(user.username, user.avatarUrl, "session-avatar")}
            <div>
              <strong>${escapeHtml(normalizeString(user.username, "Unknown user"))}</strong>
              <div class="access-user-meta">
                <span>${escapeHtml(discordUserId || "No Discord id")}</span>
                ${renderStatusBadge(normalizeString(user.role, "member"))}
              </div>
            </div>
          </div>
          ${user.isOwner ? renderStatusBadge("owner") : ""}
        </div>
        <div class="access-user-chip-stack">
          ${renderChipList(normalizeArray(user.groups).map((group) => normalizeString(group.name)).slice(0, 6))}
          ${summarizeUserGrants(user).length ? renderChipList(summarizeUserGrants(user).slice(0, 6)) : `<span class="muted-copy">No admin domains</span>`}
        </div>
        <div class="access-user-foot">
          <span>${escapeHtml(normalizeString(user.accessSummary?.label, "Reader access"))}</span>
          <span>${escapeHtml(activity.lastActivityAt ? formatDate(activity.lastActivityAt, {includeTime: true}) : "No recent activity")}</span>
        </div>
      </div>
    </article>
  `;
};

const renderUserDirectory = ({users, selectedUserId, searchValue, eventIndex}) => {
  const visibleUsers = normalizeArray(users).filter((user) => matchesUserSearch(user, searchValue));
  return `
    <div class="access-list-toolbar">
      <input id="admin-users-search" type="search" placeholder="Search username, Discord id, group, or capability" value="${escapeHtml(searchValue)}">
      <span class="muted-copy">${escapeHtml(`${visibleUsers.length} user${visibleUsers.length === 1 ? "" : "s"}`)}</span>
    </div>
    ${visibleUsers.length
      ? `<div class="access-user-list">${visibleUsers.map((user) => renderUserCard(user, selectedUserId, eventIndex)).join("")}</div>`
      : renderEmptyState("No matching users", "Try a different search term or wait for a Discord user to sign in.")}
  `;
};

const renderUserSummaryCard = (title, body, extra = "") => `
  <article class="detail-stack-card access-summary-card">
    <div>
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(body)}</span>
    </div>
    ${extra}
  </article>
`;

const renderUserDetails = ({user, groups, eventIndex}) => {
  if (!user) {
    return renderEmptyState("Pick a user", "Select a user from the directory to review their groups, admin domains, and recent activity.");
  }

  const activity = eventIndex.get(userIdentity(user)) || {};
  const assignedGroupIds = new Set(normalizeArray(user.groups).map((group) => groupIdentity(group)));
  const visibleGroups = normalizeArray(groups);

  return `
    <div class="section-heading">
      <div>
        <span class="section-kicker">Assignment</span>
        <h2>${escapeHtml(normalizeString(user.username, "Unknown user"))}</h2>
      </div>
      <div class="action-row">
        ${renderStatusBadge(normalizeString(user.role, "member"))}
        ${user.isOwner ? renderStatusBadge("protected owner") : ""}
      </div>
    </div>
    <div class="request-detail-meta-grid access-detail-grid">
      ${renderUserSummaryCard("Discord", normalizeString(user.discordUserId, "Not available"), "")}
      ${renderUserSummaryCard("Last login", activity.lastLoginAt ? formatDate(activity.lastLoginAt, {includeTime: true}) : "Not recorded yet")}
      ${renderUserSummaryCard("Last activity", activity.lastActivityAt ? formatDate(activity.lastActivityAt, {includeTime: true}) : "No durable event yet")}
    </div>
    <section class="detail-subsection">
      <h3>Assigned groups</h3>
      <p class="field-note">Group assignments union together. Use them to make moderators or other admins without mutating a special role field.</p>
      <form id="admin-user-group-form" class="settings-form">
        <input type="hidden" id="admin-selected-user-id" value="${escapeHtml(userIdentity(user))}">
        <div class="capability-grid">
          ${visibleGroups.map((group) => `
            <label class="access-toggle-card ${assignedGroupIds.has(groupIdentity(group)) ? "is-selected-group" : ""} ${user.isOwner ? "is-disabled-access" : ""}">
              <input
                type="checkbox"
                data-group-assignment="${escapeHtml(groupIdentity(group))}"
                ${assignedGroupIds.has(groupIdentity(group)) ? "checked" : ""}
                ${user.isOwner ? "disabled" : ""}
              >
              <strong>${escapeHtml(normalizeString(group.name, "Group"))}</strong>
              <span>${escapeHtml(normalizeString(group.description, group.isDefault ? "Default onboarding group" : "Custom permission group"))}</span>
              ${group.isDefault ? renderStatusBadge("default") : ""}
            </label>
          `).join("")}
        </div>
        <div class="action-row">
          <button class="solid-button" type="submit" ${user.isOwner ? "disabled" : ""}>Save assignments</button>
          <button class="ghost-button" type="button" data-action="delete-user" ${user.isOwner ? "disabled" : ""}>Delete user</button>
        </div>
      </form>
      ${user.isOwner
        ? `<section class="callout subtle"><strong>Protected owner</strong><p>The bootstrap owner bypasses normal grants and cannot be deleted or demoted from this page.</p></section>`
        : ""}
    </section>
    <section class="detail-subsection">
      <h3>Effective access</h3>
      <div class="access-detail-columns">
        <article class="detail-stack-card access-detail-column">
          <strong>Baseline capabilities</strong>
          ${renderChipList(normalizeArray(user.baselinePermissions))}
        </article>
        <article class="detail-stack-card access-detail-column">
          <strong>Admin domains</strong>
          ${summarizeUserGrants(user).length ? renderChipList(summarizeUserGrants(user)) : `<span class="muted-copy">This user does not have admin-route visibility.</span>`}
        </article>
      </div>
    </section>
  `;
};

const renderGroupCard = (group, memberCounts, selectedGroupId) => {
  const groupId = groupIdentity(group);
  const isSelected = groupId === selectedGroupId;
  const memberCount = memberCounts.get(groupId) || 0;
  return `
    <article class="access-group-card ${isSelected ? "is-selected-group" : ""}" data-group-id="${escapeHtml(groupId)}">
      <button class="access-group-card-main" type="button" data-action="select-group" data-group-id="${escapeHtml(groupId)}">
        <div class="access-group-card-head">
          <strong>${escapeHtml(normalizeString(group.name, "Group"))}</strong>
          <div class="action-row">
            ${group.isDefault ? renderStatusBadge("default") : ""}
            ${renderStatusBadge(`${memberCount} member${memberCount === 1 ? "" : "s"}`)}
          </div>
        </div>
        <p>${escapeHtml(normalizeString(group.description, "Permission group"))}</p>
        <div class="access-user-chip-stack">
          ${renderChipList(normalizeArray(group.permissions))}
          ${renderChipList(Object.entries(group.adminGrants || {})
            .filter(([, level]) => normalizeString(level))
            .map(([domain, level]) => `${domain}.${normalizeString(level)}`))}
        </div>
      </button>
    </article>
  `;
};

const renderGroupEditor = ({group, domains, memberCounts, isNew}) => {
  const memberCount = memberCounts.get(groupIdentity(group)) || 0;
  const title = isNew ? "Create permission group" : `Edit ${normalizeString(group.name, "group")}`;
  return `
    <div class="section-heading">
      <div>
        <span class="section-kicker">Permission groups</span>
        <h2>${escapeHtml(title)}</h2>
      </div>
      <div class="action-row">
        ${!isNew ? renderStatusBadge(`${memberCount} member${memberCount === 1 ? "" : "s"}`) : ""}
        ${group.isDefault ? renderStatusBadge("default") : ""}
      </div>
    </div>
    <form id="admin-group-form" class="settings-form">
      <input type="hidden" id="admin-group-id" value="${escapeHtml(isNew ? "" : groupIdentity(group))}">
      <label class="wide-field">
        <span>Group name</span>
        <input id="admin-group-name" type="text" value="${escapeHtml(normalizeString(group.name))}" placeholder="Moderator" required>
      </label>
      <label class="wide-field">
        <span>Description</span>
        <textarea id="admin-group-description" placeholder="What is this group used for?">${escapeHtml(normalizeString(group.description))}</textarea>
      </label>
      <label class="switch-row">
        <input id="admin-group-default" type="checkbox" ${group.isDefault ? "checked" : ""}>
        <span>Default onboarding group</span>
      </label>

      <section class="detail-subsection">
        <h3>Baseline user capabilities</h3>
        <div class="capability-grid">
          ${BASELINE_CAPABILITIES.map((capability) => `
            <label class="access-toggle-card ${normalizeArray(group.permissions).includes(capability.id) ? "is-selected-group" : ""}">
              <input type="checkbox" data-group-capability="${escapeHtml(capability.id)}" ${normalizeArray(group.permissions).includes(capability.id) ? "checked" : ""}>
              <strong>${escapeHtml(capability.label)}</strong>
              <span>${escapeHtml(capability.id)}</span>
            </label>
          `).join("")}
        </div>
      </section>

      <section class="detail-subsection">
        <h3>Admin route grants</h3>
        <div class="permission-matrix">
          ${normalizeArray(domains).map((domain) => `
            <label class="permission-matrix-row">
              <span>${escapeHtml(normalizeString(domain.label, domain.id))}</span>
              <select data-group-domain="${escapeHtml(normalizeString(domain.id))}">
                ${ACCESS_LEVELS.map((level) => `
                  <option value="${escapeHtml(level.id)}" ${normalizeString(group.adminGrants?.[domain.id]) === level.id ? "selected" : ""}>
                    ${escapeHtml(level.label)}
                  </option>
                `).join("")}
              </select>
            </label>
          `).join("")}
        </div>
      </section>

      <div class="action-row">
        <button class="solid-button" type="submit">${isNew ? "Create group" : "Save group"}</button>
        ${!isNew ? `<button class="ghost-button" type="button" data-action="delete-group">Delete group</button>` : ""}
      </div>
    </form>
  `;
};

/**
 * Load the admin users access payload.
 *
 * @param {{api: ReturnType<import("../api.js").createAdminApi>}} context
 * @returns {Promise<import("../api.js").ApiResult>}
 */
export const loadUsersPage = ({api}) => api.get("/api/moon/v3/admin/users");

/**
 * Render the admin users page.
 *
 * @param {Awaited<ReturnType<typeof loadUsersPage>>} result
 * @returns {string}
 */
export const renderUsersPage = (result) => {
  if (!result.ok) {
    return renderEmptyState("Users unavailable", result.payload?.error || "Unable to load Scriptarr user records.");
  }

  const users = normalizeArray(result.payload?.users);
  const groups = normalizeArray(result.payload?.groups);
  const domains = normalizeArray(result.payload?.domains);
  const events = normalizeArray(result.payload?.events);
  const selectedUserId = userIdentity(users[0]);
  const selectedGroupId = groupIdentity(groups[0]);
  const eventIndex = buildUserEventIndex(events);
  const memberCounts = buildGroupMemberCounts(groups, users);
  const adminUsers = users.filter((user) => normalizeArray(user.accessSummary?.adminDomains).length > 0 || user.isOwner).length;

  return `
    <section class="panel-section">
      <script type="application/json" id="admin-users-data">${encodeJson({
        users,
        groups,
        domains,
        events,
        defaultGroupId: normalizeString(result.payload?.defaultGroupId)
      })}</script>
      <div class="section-heading">
        <div>
          <span class="section-kicker">Access control</span>
          <h2>Users and permission groups</h2>
          <p class="field-note">Moon access is group-based for everyone except the protected owner. Use permission groups to grant read, write, or root access per admin route family.</p>
        </div>
        <div class="action-row">
          ${renderStatusBadge(`${groups.length} groups`)}
          ${renderStatusBadge(`${adminUsers} admins`)}
        </div>
      </div>

      <div class="metric-grid access-metric-grid">
        <article class="metric-card">
          <span>Known users</span>
          <strong>${escapeHtml(users.length)}</strong>
        </article>
        <article class="metric-card">
          <span>Permission groups</span>
          <strong>${escapeHtml(groups.length)}</strong>
        </article>
        <article class="metric-card">
          <span>Admin-capable users</span>
          <strong>${escapeHtml(adminUsers)}</strong>
        </article>
        <article class="metric-card">
          <span>Default onboarding group</span>
          <strong>${escapeHtml(normalizeString(groups.find((group) => group.isDefault)?.name, "Not set"))}</strong>
        </article>
      </div>

      <div class="access-workspace">
        <section class="panel-section access-directory-panel">
          ${renderUserDirectory({
            users,
            selectedUserId,
            searchValue: "",
            eventIndex
          })}
        </section>
        <section class="panel-section access-detail-panel" id="admin-user-detail">
          ${renderUserDetails({
            user: users[0] || null,
            groups,
            eventIndex
          })}
        </section>
      </div>

      <div class="content-grid two-up access-groups-grid">
        <section class="panel-section access-groups-panel">
          <div class="section-heading">
            <div>
              <span class="section-kicker">Groups</span>
              <h2>Reusable permission groups</h2>
            </div>
            <button class="solid-button small" type="button" id="admin-new-group">New group</button>
          </div>
          <div id="admin-group-list" class="access-group-list">
            ${groups.length
              ? groups.map((group) => renderGroupCard(group, memberCounts, selectedGroupId)).join("")
              : renderEmptyState("No groups yet", "Create the first permission group to start managing access.")}
          </div>
        </section>
        <section class="panel-section access-group-editor-panel" id="admin-group-editor">
          ${renderGroupEditor({
            group: groups[0] || {
              name: "",
              description: "",
              isDefault: false,
              permissions: [],
              adminGrants: {}
            },
            domains,
            memberCounts,
            isNew: groups.length === 0
          })}
        </section>
      </div>

      <section class="panel-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">Recent activity</span>
            <h2>Auth and access events</h2>
          </div>
        </div>
        <div id="admin-access-events">
          ${renderEventFeed(events)}
        </div>
      </section>
    </section>
  `;
};

/**
 * Wire the admin users page interactions.
 *
 * @param {HTMLElement} root
 * @param {{
 *   api: ReturnType<import("../api.js").createAdminApi>,
 *   rerender: () => Promise<void>,
 *   setFlash: (tone: string, text: string) => void
 * }} context
 * @returns {Promise<void>}
 */
export const enhanceUsersPage = async (root, {api, rerender, setFlash}) => {
  const payload = parseJsonNode(root, "#admin-users-data", {
    users: [],
    groups: [],
    domains: [],
    events: [],
    defaultGroupId: ""
  });
  const users = normalizeArray(payload?.users);
  const groups = normalizeArray(payload?.groups);
  const domains = normalizeArray(payload?.domains);
  const events = normalizeArray(payload?.events);
  const memberCounts = buildGroupMemberCounts(groups, users);
  const eventIndex = buildUserEventIndex(events);

  const directoryRoot = root.querySelector(".access-directory-panel");
  const detailRoot = root.querySelector("#admin-user-detail");
  const groupListRoot = root.querySelector("#admin-group-list");
  const groupEditorRoot = root.querySelector("#admin-group-editor");

  let selectedUserId = userIdentity(users[0]);
  let selectedGroupId = groupIdentity(groups[0]);
  let searchValue = "";
  let draftingNewGroup = groups.length === 0;

  const selectedUser = () => normalizeArray(users).find((user) => userIdentity(user) === selectedUserId) || null;
  const selectedGroup = () => normalizeArray(groups).find((group) => groupIdentity(group) === selectedGroupId) || null;

  const renderUserState = () => {
    if (directoryRoot) {
      directoryRoot.innerHTML = renderUserDirectory({
        users,
        selectedUserId,
        searchValue,
        eventIndex
      });
      directoryRoot.querySelector("#admin-users-search")?.addEventListener("input", (event) => {
        searchValue = event.target.value || "";
        renderUserState();
      });
      directoryRoot.querySelectorAll("[data-action='select-user']").forEach((button) => {
        button.addEventListener("click", () => {
          selectedUserId = button.dataset.userId || "";
          renderUserState();
          renderUserDetail();
        });
      });
    }
  };

  const renderUserDetail = () => {
    if (!detailRoot) {
      return;
    }
    detailRoot.innerHTML = renderUserDetails({
      user: selectedUser(),
      groups,
      eventIndex
    });

    detailRoot.querySelector("#admin-user-group-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const user = selectedUser();
      if (!user || user.isOwner) {
        return;
      }
      const groupIds = Array.from(detailRoot.querySelectorAll("[data-group-assignment]:checked"))
        .map((input) => input.getAttribute("data-group-assignment"))
        .filter(Boolean);
      const result = await api.put(`/api/moon/v3/admin/users/${encodeURIComponent(userIdentity(user))}/groups`, {groupIds});
      setFlash(result.ok ? "good" : "bad", result.ok
        ? `Updated groups for ${normalizeString(user.username, "that user")}.`
        : result.payload?.error || "Unable to update that user's groups.");
      await rerender();
    });

    detailRoot.querySelector("[data-action='delete-user']")?.addEventListener("click", async () => {
      const user = selectedUser();
      if (!user || user.isOwner) {
        return;
      }
      const confirmed = globalThis.confirm(`Delete ${normalizeString(user.username, "this user")} from local Moon access? Their requests, bookmarks, follows, progress, and audit history will stay.`);
      if (!confirmed) {
        return;
      }
      const result = await api.delete(`/api/moon/v3/admin/users/${encodeURIComponent(userIdentity(user))}`);
      setFlash(result.ok ? "good" : "bad", result.ok
        ? `Removed ${normalizeString(user.username, "that user")} from local access.`
        : result.payload?.error || "Unable to delete that user.");
      await rerender();
    });
  };

  const renderGroupState = () => {
    if (groupListRoot) {
      groupListRoot.innerHTML = normalizeArray(groups).length
        ? groups.map((group) => renderGroupCard(group, memberCounts, draftingNewGroup ? "" : selectedGroupId)).join("")
        : renderEmptyState("No groups yet", "Create the first permission group to start managing access.");
      groupListRoot.querySelectorAll("[data-action='select-group']").forEach((button) => {
        button.addEventListener("click", () => {
          draftingNewGroup = false;
          selectedGroupId = button.dataset.groupId || "";
          renderGroupState();
          renderGroupEditorState();
        });
      });
    }
  };

  const renderGroupEditorState = () => {
    if (!groupEditorRoot) {
      return;
    }

    const group = draftingNewGroup
      ? {
        name: "",
        description: "",
        isDefault: false,
        permissions: [],
        adminGrants: {}
      }
      : (selectedGroup() || {
        name: "",
        description: "",
        isDefault: false,
        permissions: [],
        adminGrants: {}
      });

    groupEditorRoot.innerHTML = renderGroupEditor({
      group,
      domains,
      memberCounts,
      isNew: draftingNewGroup
    });

    groupEditorRoot.querySelector("#admin-group-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = {
        name: groupEditorRoot.querySelector("#admin-group-name")?.value || "",
        description: groupEditorRoot.querySelector("#admin-group-description")?.value || "",
        isDefault: groupEditorRoot.querySelector("#admin-group-default")?.checked === true,
        permissions: Array.from(groupEditorRoot.querySelectorAll("[data-group-capability]:checked"))
          .map((input) => input.getAttribute("data-group-capability"))
          .filter(Boolean),
        adminGrants: Object.fromEntries(normalizeArray(domains).map((domain) => {
          const domainId = normalizeString(domain.id);
          const select = Array.from(groupEditorRoot.querySelectorAll("[data-group-domain]"))
            .find((entry) => entry.getAttribute("data-group-domain") === domainId);
          return [domainId, select?.value || ""];
        }))
      };

      const result = draftingNewGroup
        ? await api.post("/api/moon/v3/admin/users/groups", payload)
        : await api.patch(`/api/moon/v3/admin/users/groups/${encodeURIComponent(groupIdentity(group))}`, payload);

      setFlash(result.ok ? "good" : "bad", result.ok
        ? (draftingNewGroup ? "Created the permission group." : "Saved the permission group.")
        : result.payload?.error || "Unable to save that permission group.");
      await rerender();
    });

    groupEditorRoot.querySelector("[data-action='delete-group']")?.addEventListener("click", async () => {
      if (draftingNewGroup) {
        return;
      }
      const confirmed = globalThis.confirm(`Delete ${normalizeString(group.name, "this group")}? Users assigned to it will lose those grants immediately.`);
      if (!confirmed) {
        return;
      }
      const result = await api.delete(`/api/moon/v3/admin/users/groups/${encodeURIComponent(groupIdentity(group))}`);
      setFlash(result.ok ? "good" : "bad", result.ok
        ? `Deleted ${normalizeString(group.name, "that group")}.`
        : result.payload?.error || "Unable to delete that permission group.");
      await rerender();
    });
  };

  root.querySelector("#admin-new-group")?.addEventListener("click", () => {
    draftingNewGroup = true;
    renderGroupState();
    renderGroupEditorState();
  });

  const stream = new EventSource("/api/moon/v3/admin/events/stream?domain=auth&domain=users&domain=access");
  const refreshSoon = () => {
    globalThis.setTimeout(() => {
      void rerender();
    }, 150);
  };
  stream.addEventListener("admin-event", refreshSoon);
  stream.addEventListener("error", () => {
    stream.close();
  });
  root.addEventListener("DOMNodeRemoved", () => {
    stream.close();
  }, {once: true});

  renderUserState();
  renderUserDetail();
  renderGroupState();
  renderGroupEditorState();
};

export default {
  enhanceUsersPage,
  loadUsersPage,
  renderUsersPage
};
