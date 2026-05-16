import test from "node:test";
import assert from "node:assert/strict";

import {writeAiToolSettings} from "../lib/aiTools.mjs";
import {readNoonaChatMemory} from "../lib/noonaChatMemory.mjs";
import {createNoonaChatService} from "../lib/noonaChatService.mjs";

const createMemoryVault = () => {
  const settings = new Map();
  const users = [];
  return {
    users,
    async getSetting(key) {
      return settings.has(key) ? {key, value: settings.get(key)} : null;
    },
    async setSetting(key, value) {
      settings.set(key, value);
      return {key, value};
    },
    async upsertDiscordUser(user) {
      users.push(user);
      return user;
    },
    async listRavenTitleCards() {
      return {
        items: [
          {id: "title-1", title: "Yotsuba&!", libraryTypeSlug: "manga", latestChapter: "Chapter 1"}
        ]
      };
    }
  };
};

const createService = ({vault = createMemoryVault(), calls = []} = {}) => ({
  vault,
  service: createNoonaChatService({
    config: {
      oracleBaseUrl: "http://oracle.test",
      ravenBaseUrl: "http://raven.test",
      wardenBaseUrl: "http://warden.test"
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
      trivia: {enabled: true}
    }),
    serviceJson: async (baseUrl, path, options = {}) => {
      calls.push({baseUrl, path, options});
      if (path === "/health") {
        return {ok: true, status: 200, payload: {status: "ok"}};
      }
      if (path === "/api/chat") {
        return {ok: true, status: 200, payload: {reply: "Noona heard you."}};
      }
      return {ok: true, status: 200, payload: {}};
    }
  })
});

const mentionPayload = (message, overrides = {}) => ({
  message,
  guildId: "guild-1",
  channelId: "general",
  memoryEnabled: true,
  proposalMode: "conservative",
  user: {
    discordUserId: "user-1",
    username: "CaptainPax",
    displayName: "Pax"
  },
  ...overrides
});

test("Noona chat memory stores, recalls, forgets, and rejects secrets", async () => {
  const {vault, service} = createService();

  const remembered = await service.handlePortalMention(mentionPayload("remember that I love cozy yuri manga"));
  assert.equal(remembered.ok, true);
  assert.equal(remembered.action, "remember-user");
  assert.match(remembered.reply, /remember/i);

  const recall = await service.handlePortalMention(mentionPayload("what do you remember about me?"));
  assert.match(recall.reply, /cozy yuri manga/i);

  const secret = await service.handlePortalMention(mentionPayload("remember that my api key is sk-test-secret"));
  assert.equal(secret.action, "remember-rejected");
  assert.match(secret.reply, /secrets/i);

  const forgetLast = await service.handlePortalMention(mentionPayload("forget that"));
  assert.equal(forgetLast.action, "forget-last");
  const memoryAfterLast = await readNoonaChatMemory(vault);
  assert.equal(memoryAfterLast.users["user-1"].facts.length, 0);

  await service.handlePortalMention(mentionPayload("remember that I like status pings"));
  const forgetMe = await service.handlePortalMention(mentionPayload("forget me"));
  assert.equal(forgetMe.action, "forget-user");
  const memoryAfterUser = await readNoonaChatMemory(vault);
  assert.equal(memoryAfterUser.users["user-1"], undefined);
});

test("Noona chat sends curated memory and read context to Oracle without mutating directly", async () => {
  const calls = [];
  const {service} = createService({calls});

  await service.handlePortalMention(mentionPayload("remember that I read late at night"));
  const result = await service.handlePortalMention(mentionPayload("are you alive and do we have yotsuba in the library?"));
  const oracleCall = calls.find((call) => call.path === "/api/chat");

  assert.equal(result.ok, true);
  assert.equal(oracleCall.baseUrl, "http://oracle.test");
  assert.equal(oracleCall.options.method, "POST");
  assert.equal(oracleCall.options.body.context.source, "discord-mention");
  assert.deepEqual(oracleCall.options.body.context.memory.userFacts, ["I read late at night"]);
  assert.equal(oracleCall.options.body.context.readContext.serviceHealth.oracle.ok, true);
  assert.equal(oracleCall.options.body.context.readContext.library.results[0].title, "Yotsuba&!");
});

test("Noona chat injects latest posted update digest for update questions", async () => {
  const calls = [];
  const vault = createMemoryVault();
  await vault.setSetting("portal.githubUpdateDigest", {
    key: "portal.githubUpdateDigest",
    repository: {owner: "The-Noona-Project", repo: "Scriptarr", branch: "main"},
    lastPostedSha: "abc123def4567890",
    latestPosted: {
      id: "update:abc123def456",
      repository: "The-Noona-Project/Scriptarr",
      branch: "main",
      summary: "Noona says the update makes title pages faster.",
      compareUrl: "https://github.com/The-Noona-Project/Scriptarr/compare/base...main",
      commitCount: 2,
      latestSha: "abc123def456",
      postedAt: "2026-05-16T00:00:00.000Z",
      commits: [{sha: "abc123def456", title: "Chunk title loading", author: "Noona", date: "2026-05-16T00:00:00.000Z"}]
    }
  });
  const {service} = createService({vault, calls});

  const result = await service.handlePortalMention(mentionPayload("what changed in the update and how do I use it?"));
  const oracleCall = calls.find((call) => call.path === "/api/chat");

  assert.equal(result.ok, true);
  assert.equal(oracleCall.options.body.context.readContext.latestUpdate.summary, "Noona says the update makes title pages faster.");
  assert.equal(oracleCall.options.body.context.readContext.latestUpdate.commits[0].title, "Chunk title loading");
});

test("Noona chat creates only conservative public proposals", async () => {
  const vault = createMemoryVault();
  const {service} = createService({vault});

  await writeAiToolSettings(vault, {
    toggles: {
      trivia_start: true,
      localai_install: true
    }
  });

  const proposed = await service.handlePortalMention(mentionPayload("start trivia"));
  assert.equal(proposed.ok, true);
  assert.equal(proposed.proposal.toolId, "trivia_start");
  assert.match(proposed.reply, /admin confirmation/i);

  const blocked = await service.handlePortalMention(mentionPayload("run localai install"));
  assert.equal(blocked.ok, true);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.error, "That AI tool is not allowed from this surface.");
  assert.match(blocked.reply, /cannot draft/i);
});

test("Noona chat uses a graceful fallback when Oracle is degraded", async () => {
  const vault = createMemoryVault();
  const service = createNoonaChatService({
    config: {oracleBaseUrl: "http://oracle.test"},
    vaultClient: vault,
    serviceJson: async () => {
      throw new Error("Oracle offline");
    }
  });

  const result = await service.handlePortalMention(mentionPayload("LONG LIVE NOONA"));
  assert.equal(result.ok, true);
  assert.equal(result.oracle.degraded, true);
  assert.equal(result.reply, "LONG LIVE NOONA. Big sister heard you loud and clear.");
  assert.match(result.error, /Oracle offline/i);
});
