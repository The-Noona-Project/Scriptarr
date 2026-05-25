import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGroupDraft,
  buildUserMetrics,
  filterUsers,
  hasNoonaChatAccess,
  patchGroupCapability,
  patchGroupGrant,
  resolveExistingUserSelection,
  serializeGroupDraft,
  userRowKey
} from "../apps/admin-next/lib/adminUsers.js";

test("admin users helpers count and filter access buckets", () => {
  const users = [
    {discordUserId: "owner", username: "Owner", role: "owner", isOwner: true, accessSummary: {adminDomains: ["settings"]}},
    {discordUserId: "admin", username: "Admin", role: "admin", accessSummary: {adminDomains: ["users"]}, groups: [{name: "Managers"}]},
    {discordUserId: "reader", username: "Reader", role: "member", permissions: ["use_noona_chat"], accessSummary: {adminDomains: []}, groups: []}
  ];

  const metrics = buildUserMetrics(users, [{id: "member"}, {id: "managers"}]);

  assert.equal(metrics.total, 3);
  assert.equal(metrics.owners, 1);
  assert.equal(metrics.admins, 2);
  assert.equal(metrics.readers, 1);
  assert.equal(metrics.noonaChat, 1);
  assert.deepEqual(filterUsers(users, {filter: "admins", query: "manager"}).map((user) => user.discordUserId), ["admin"]);
  assert.deepEqual(filterUsers(users, {filter: "noona-chat"}).map((user) => user.discordUserId), ["reader"]);
  assert.equal(hasNoonaChatAccess(users[2]), true);
});

test("admin users helpers normalize group grant drafts", () => {
  const draft = buildGroupDraft({
    id: "staff",
    name: "Staff",
    permissions: ["read_library"],
    adminGrants: {users: "read"}
  });
  const patched = patchGroupGrant(draft, "requests", "root");
  const withNoonaChat = patchGroupCapability(patched, undefined, true);
  const serialized = serializeGroupDraft({
    ...withNoonaChat,
    ...patched,
    permissionsText: `${withNoonaChat.permissionsText}, create_requests`
  });

  assert.equal(serialized.adminGrants.users, "read");
  assert.equal(serialized.adminGrants.requests, "root");
  assert.deepEqual(serialized.permissions, ["create_requests", "read_library", "use_noona_chat"]);
});

test("admin users selection helper never auto-opens the first visible user", () => {
  const users = [
    {discordUserId: "first", username: "First"},
    {id: "fallback-id", username: "Fallback"}
  ];

  assert.equal(userRowKey(users[0]), "first");
  assert.equal(userRowKey(users[1]), "fallback-id");
  assert.equal(resolveExistingUserSelection(users, ""), "");
  assert.equal(resolveExistingUserSelection(users, "first"), "first");
  assert.equal(resolveExistingUserSelection(users, "missing"), "");
});
