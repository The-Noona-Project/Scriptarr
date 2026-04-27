import test from "node:test";
import assert from "node:assert/strict";

import {filterRoutesForUser, hasAdminGrant} from "../apps/admin-next/lib/access.js";
import {adminRoutes, matchAdminRoute} from "../apps/admin-next/lib/routes.js";

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

test("wanted metadata route is canonical while legacy path still resolves", () => {
  const metadataRoute = adminRoutes.find((route) => route.id === "wanted-metadata");

  assert.equal(metadataRoute?.path, "/admin/wanted/metadata");
  assert.equal(metadataRoute?.navLabel, "Metadata");
  assert.equal(matchAdminRoute("/admin/wanted/metadata-gaps").id, "wanted-metadata");
});
