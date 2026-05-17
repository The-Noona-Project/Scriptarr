import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiscordCommandRows,
  normalizeDiscordSettings
} from "../apps/admin-next/lib/adminDiscord.js";

test("discord settings helper preserves notification channel and command role rules", () => {
  const settings = normalizeDiscordSettings({
    guildId: " guild ",
    notifications: {releaseChannelId: " release-channel ", updateChannelId: " updates-channel "},
    noonaChat: {
      enabled: true,
      allowedChannelIds: [" general ", "", "trivia"],
      memoryEnabled: false,
      publicReplies: false,
      proposalMode: "off"
    },
    commands: {
      request: {enabled: false, roleId: "role-1"},
      downloadall: {enabled: true, roleId: "ignored"}
    }
  });

  assert.equal(settings.guildId, "guild");
  assert.equal(settings.notifications.releaseChannelId, "release-channel");
  assert.equal(settings.notifications.updateChannelId, "updates-channel");
  assert.equal(settings.noonaChat.enabled, true);
  assert.deepEqual(settings.noonaChat.allowedChannelIds, ["general", "trivia"]);
  assert.equal(settings.noonaChat.memoryEnabled, false);
  assert.equal(settings.noonaChat.publicReplies, true);
  assert.equal(settings.noonaChat.proposalMode, "off");
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

test("discord settings helper preserves Appa command gates and split ownership", () => {
  const settings = normalizeDiscordSettings({
    appa: {
      enabled: true,
      adminMentionChannelIds: [" admins ", "", "ops"],
      reviewEnabled: false,
      correctionMode: "off",
      commands: {
        status: {enabled: false, roleId: "role-appa-status"},
        trivia: {enabled: true, roleId: "role-appa-trivia"},
        downloadall: {enabled: true, roleId: "ignored"}
      }
    },
    commands: {
      trivia: {enabled: false, roleId: "role-noona-trivia"}
    }
  });
  const rows = buildDiscordCommandRows(settings, [{
    id: "trivia",
    name: "trivia",
    label: "/trivia",
    splitOwner: "both",
    roleManaged: true,
    appaRoleId: "runtime-appa-role"
  }, {
    id: "status",
    name: "status",
    label: "/status",
    splitOwner: "appa",
    roleManaged: true
  }], []);
  const trivia = rows.find((row) => row.id === "trivia");
  const status = rows.find((row) => row.id === "status");

  assert.equal(settings.appa.enabled, true);
  assert.deepEqual(settings.appa.adminMentionChannelIds, ["admins", "ops"]);
  assert.equal(settings.appa.reviewEnabled, false);
  assert.equal(settings.appa.commands.downloadall.roleId, "");
  assert.equal(trivia.owner, "both");
  assert.equal(trivia.enabled, false);
  assert.equal(trivia.appaEnabled, true);
  assert.equal(trivia.roleId, "role-noona-trivia");
  assert.equal(trivia.appaRoleId, "role-appa-trivia");
  assert.equal(status.owner, "appa");
  assert.equal(status.appaEnabled, false);
  assert.equal(status.appaRoleId, "role-appa-status");
});
