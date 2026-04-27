import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiscordCommandRows,
  normalizeDiscordSettings
} from "../apps/admin-next/lib/adminDiscord.js";

test("discord settings helper preserves notification channel and command role rules", () => {
  const settings = normalizeDiscordSettings({
    guildId: " guild ",
    notifications: {releaseChannelId: " release-channel "},
    commands: {
      request: {enabled: false, roleId: "role-1"},
      downloadall: {enabled: true, roleId: "ignored"}
    }
  });

  assert.equal(settings.guildId, "guild");
  assert.equal(settings.notifications.releaseChannelId, "release-channel");
  assert.equal(settings.commands.request.enabled, false);
  assert.equal(settings.commands.downloadall.roleId, "");
});

test("discord command rows merge runtime inventory with draft settings", () => {
  const settings = normalizeDiscordSettings({
    commands: {
      request: {enabled: true, roleId: "role-1"}
    }
  });
  const rows = buildDiscordCommandRows(settings, [{id: "request", description: "Requests"}], [{
    name: "request",
    label: "/request",
    registered: true,
    status: "Registered",
    roleManaged: true
  }]);
  const request = rows.find((row) => row.id === "request");

  assert.equal(request.registered, true);
  assert.equal(request.roleId, "role-1");
  assert.equal(request.description, "Requests");
});
