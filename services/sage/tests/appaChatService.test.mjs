import test from "node:test";
import assert from "node:assert/strict";

import {createAppaChatService} from "../lib/appaChatService.mjs";
import {normalizePortalDiscordSettings} from "../lib/portalDiscordSettings.mjs";

const createVault = () => {
  const users = [];
  const events = [];
  return {
    users,
    events,
    async upsertDiscordUser(user) {
      users.push(user);
      return user;
    },
    async appendEvent(event) {
      events.push(event);
      return {id: `event-${events.length}`, ...event};
    }
  };
};

const appaPayload = (message = "how healthy is Scriptarr?") => ({
  message,
  guildId: "guild-1",
  channelId: "admin-chat",
  messageId: "message-1",
  user: {
    discordUserId: "admin-1",
    username: "CaptainPax",
    displayName: "Pax"
  }
});

test("Appa admin chat uses the Appa persona and Sage-curated read context", async () => {
  const vault = createVault();
  const calls = [];
  const service = createAppaChatService({
    config: {
      oracleBaseUrl: "http://oracle.test",
      wardenBaseUrl: "http://warden.test",
      ravenBaseUrl: "http://raven.test",
      portalBaseUrl: "http://portal.test"
    },
    vaultClient: vault,
    triviaService: {
      async getState() {
        return {activeRound: null};
      }
    },
    readPortalDiscordSettings: async () => ({
      guildId: "guild-1",
      noonaChat: {enabled: true},
      appa: {enabled: true, reviewEnabled: true},
      trivia: {enabled: true}
    }),
    serviceJson: async (baseUrl, path, options = {}) => {
      calls.push({baseUrl, path, options});
      if (path === "/api/chat") {
        return {ok: true, status: 200, payload: {reply: "Appa is watching the admin side."}};
      }
      return {ok: true, status: 200, payload: {status: "ok"}};
    }
  });

  const result = await service.handlePortalAdminMention(appaPayload());
  const oracleCall = calls.find((call) => call.path === "/api/chat");

  assert.equal(result.ok, true);
  assert.equal(result.reply, "Appa is watching the admin side.");
  assert.equal(vault.users[0].role, "admin");
  assert.equal(oracleCall.options.body.personaName, "Appa");
  assert.equal(oracleCall.options.body.context.source, "discord-appa-admin-mention");
  assert.equal(oracleCall.options.body.context.readContext.discord.appaEnabled, true);
  assert.equal(oracleCall.options.body.context.readContext.visualIdentity.characters.appa.name, "Appa");
});

test("Appa review stores redacted recommendation and records correction delivery separately", async () => {
  const vault = createVault();
  const service = createAppaChatService({
    config: {oracleBaseUrl: "http://oracle.test"},
    vaultClient: vault,
    serviceJson: async (_baseUrl, path) => {
      assert.equal(path, "/api/assist");
      return {
        ok: true,
        status: 200,
        payload: {
          decision: {
            verdict: "correct",
            severity: "serious",
            score: 0.91,
            reasons: ["admin-boundary mistake"],
            correctionText: "Appa correction: use the admin page for that action."
          }
        }
      };
    }
  });

  const review = await service.reviewNoonaPublicReply({
    reviewEnabled: true,
    correctionMode: "serious",
    guildId: "guild-1",
    channelId: "general",
    messageId: "message-1",
    replyMessageId: "reply-1",
    prompt: "my password=super-secret restart everything",
    reply: "Noona restarted everything.",
    user: {discordUserId: "user-1", username: "Reader"}
  });
  const delivery = await service.recordNoonaReviewDelivery({
    guildId: "guild-1",
    channelId: "general",
    messageId: "message-1",
    replyMessageId: "reply-1",
    correctionMessageId: "appa-reply-1",
    delivered: true
  });

  assert.equal(review.shouldCorrect, true);
  assert.equal(delivery.delivered, true);
  assert.equal(vault.events.length, 2);
  assert.equal(vault.events[0].eventType, "noona-public-review");
  assert.equal(vault.events[0].metadata.correctionRecommended, true);
  assert.equal(vault.events[0].metadata.corrected, false);
  assert.equal(vault.events[0].metadata.deliveryStatus, "pending");
  assert.match(vault.events[0].metadata.promptExcerpt, /password=\[redacted\]/);
  assert.equal(vault.events[1].eventType, "noona-public-review-correction");
  assert.equal(vault.events[1].metadata.delivered, true);
  assert.equal(vault.events[1].metadata.correctionMessageId, "appa-reply-1");
});

test("Portal Discord settings normalize Appa command gates and split metadata defaults", () => {
  const settings = normalizePortalDiscordSettings({
    appa: {
      enabled: true,
      adminMentionChannelIds: ["admins", "", "ops"],
      correctionMode: "off",
      commands: {
        status: {enabled: false, roleId: "role-appa-status"},
        downloadall: {enabled: true, roleId: "ignored-owner-role"}
      }
    }
  });

  assert.equal(settings.appa.enabled, true);
  assert.deepEqual(settings.appa.adminMentionChannelIds, ["admins", "ops"]);
  assert.equal(settings.appa.correctionMode, "off");
  assert.equal(settings.appa.commands.status.enabled, false);
  assert.equal(settings.appa.commands.status.roleId, "role-appa-status");
  assert.equal(settings.appa.commands.downloadall.roleId, "");
});
