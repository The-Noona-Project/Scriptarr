import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeDiscordAvatarMode,
  resolveDiscordBotIdentity,
  syncDiscordBotAvatar
} from "../lib/discord/botIdentity.mjs";

test("Discord bot identity resolves bundled default avatar choices", () => {
  assert.equal(resolveDiscordBotIdentity().id, "noona");
  assert.equal(resolveDiscordBotIdentity("appa").id, "appa");
  assert.equal(resolveDiscordBotIdentity("unknown").id, "noona");
  assert.equal(normalizeDiscordAvatarMode("force"), "force");
  assert.equal(normalizeDiscordAvatarMode("bad-value"), "missing");
});

test("Discord default avatar sync uploads only when the bot has no custom avatar", async () => {
  const uploaded = [];
  const client = {
    user: {
      avatar: null,
      async setAvatar(buffer) {
        uploaded.push(buffer);
        this.avatar = "synced-avatar-hash";
      }
    }
  };

  const updated = await syncDiscordBotAvatar({
    client,
    identity: resolveDiscordBotIdentity("noona"),
    mode: "missing"
  });
  const skipped = await syncDiscordBotAvatar({
    client,
    identity: resolveDiscordBotIdentity("noona"),
    mode: "missing"
  });

  assert.equal(updated.status, "updated");
  assert.equal(updated.identity, "noona");
  assert.ok(updated.bytes > 1000);
  assert.equal(uploaded.length, 1);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.reason, "custom-avatar-present");
});
