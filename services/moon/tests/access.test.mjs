import test from "node:test";
import assert from "node:assert/strict";

import {filterRoutesForUser, hasAdminGrant} from "../apps/admin/assets/access.js";
import {adminRoutes} from "../apps/admin/assets/routes.js";

test("admin access helpers honor canonical domain grants", () => {
  const user = {
    role: "member",
    adminGrants: {
      requests: "root",
      users: "read"
    }
  };

  assert.equal(hasAdminGrant(user, "requests", "write"), true);
  assert.equal(hasAdminGrant(user, "requests", "root"), true);
  assert.equal(hasAdminGrant(user, "users", "write"), false);
  assert.equal(hasAdminGrant(user, "library", "read"), false);
});

test("admin navigation only renders routes granted to the current user", () => {
  const filtered = filterRoutesForUser(adminRoutes, {
    role: "member",
    adminGrants: {
      requests: "read",
      users: "root"
    }
  });

  const routeIds = filtered.map((route) => route.id);
  assert.equal(routeIds.includes("requests"), true);
  assert.equal(routeIds.includes("users"), true);
  assert.equal(routeIds.includes("library"), false);
  assert.equal(routeIds.includes("system-status"), false);
});
