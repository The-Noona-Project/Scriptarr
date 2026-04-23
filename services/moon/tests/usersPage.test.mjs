import test from "node:test";
import assert from "node:assert/strict";

const {renderUsersPage} = await import("../apps/admin/assets/pages/usersPage.js");

test("admin users page embeds parseable access payloads for client enhancement", () => {
  const html = renderUsersPage({
    ok: true,
    payload: {
      defaultGroupId: "member",
      domains: [{
        id: "users",
        label: "Users"
      }],
      groups: [{
        id: "member",
        name: "Member",
        description: "Default onboarding group.",
        isDefault: true,
        permissions: ["read_library", "create_requests"],
        adminGrants: {}
      }, {
        id: "moderator",
        name: "Moderator",
        description: "Moderates requests.",
        isDefault: false,
        permissions: ["read_library", "read_requests"],
        adminGrants: {
          requests: "root"
        }
      }],
      users: [{
        discordUserId: "owner-1",
        username: "CaptainPax",
        role: "owner",
        isOwner: true,
        groups: [],
        baselinePermissions: ["read_library"],
        adminGrants: {
          users: "root"
        },
        accessSummary: {
          label: "Owner",
          adminDomains: ["users"],
          rootDomains: ["users"]
        }
      }, {
        discordUserId: "reader-2",
        username: "ReaderTwo",
        role: "member",
        isOwner: false,
        groups: [{
          id: "member",
          name: "Member"
        }],
        baselinePermissions: ["read_library", "create_requests"],
        adminGrants: {},
        accessSummary: {
          label: "Reader access",
          adminDomains: [],
          rootDomains: []
        }
      }],
      events: [{
        domain: "auth",
        eventType: "login",
        actorId: "reader-2",
        actorLabel: "ReaderTwo",
        targetType: "user",
        targetId: "reader-2",
        message: "ReaderTwo signed in.",
        createdAt: "2026-04-23T20:00:00.000Z",
        metadata: {}
      }]
    }
  });

  const jsonMatch = html.match(/<script type="application\/json" id="admin-users-data">([\s\S]*?)<\/script>/i);
  assert.ok(jsonMatch, "expected admin users payload script tag");
  assert.doesNotMatch(jsonMatch[1], /&quot;/, "embedded access payload should not HTML-escape quotes");

  const parsed = JSON.parse(jsonMatch[1]);
  assert.equal(parsed.defaultGroupId, "member");
  assert.equal(parsed.groups.length, 2);
  assert.equal(parsed.users[0].isOwner, true);
  assert.equal(parsed.events[0].eventType, "login");
  assert.match(html, /Users and permission groups/);
  assert.match(html, /Protected owner/i);
});
