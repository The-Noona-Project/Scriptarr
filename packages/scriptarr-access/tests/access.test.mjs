import test from "node:test";
import assert from "node:assert/strict";

import {
  ADMIN_ACCESS_DOMAIN_IDS,
  canAccessAdmin,
  deriveLegacyPermissions,
  hasGrant,
  mergeAdminGrantMaps,
  normalizeAdminGrants,
  seedPermissionGroups
} from "../index.mjs";

test("normalize and merge admin grant maps keep the highest level per domain", () => {
  const merged = mergeAdminGrantMaps([
    {requests: "read", library: "write"},
    {requests: "root", users: "read"}
  ]);

  assert.equal(merged.requests, "root");
  assert.equal(merged.library, "write");
  assert.equal(merged.users, "read");
  assert.equal(merged.settings, "");
});

test("hasGrant respects read-write-root hierarchy", () => {
  const grants = normalizeAdminGrants({
    requests: "write",
    users: "root"
  });

  assert.equal(hasGrant(grants, "requests", "read"), true);
  assert.equal(hasGrant(grants, "requests", "write"), true);
  assert.equal(hasGrant(grants, "requests", "root"), false);
  assert.equal(hasGrant(grants, "users", "write"), true);
});

test("legacy permission derivation keeps baseline capabilities and admin compatibility", () => {
  const permissions = deriveLegacyPermissions({
    permissions: ["create_requests", "read_library"],
    adminGrants: {
      requests: "root",
      settings: "write"
    }
  });

  assert.equal(permissions.includes("create_requests"), true);
  assert.equal(permissions.includes("moderate_requests"), true);
  assert.equal(permissions.includes("manage_settings"), true);
  assert.equal(permissions.includes("admin"), true);
});

test("seed permission groups include member as the only default and admin covers all domains", () => {
  const groups = seedPermissionGroups();
  assert.equal(groups.filter((group) => group.isDefault).length, 1);
  assert.equal(groups.find((group) => group.id === "member")?.isDefault, true);
  const adminGroup = groups.find((group) => group.id === "admin");
  assert.ok(adminGroup);
  for (const domainId of ADMIN_ACCESS_DOMAIN_IDS) {
    assert.equal(adminGroup.adminGrants[domainId], "root");
  }
  assert.equal(canAccessAdmin({adminGrants: adminGroup.adminGrants}), true);
});
