import test from "node:test";
import assert from "node:assert/strict";

import {createNoonaMentionHandler} from "../lib/discord/noonaMentionChat.mjs";
import {createRoleManager} from "../lib/discord/roleManager.mjs";

const createMessage = ({
  content = "<@bot-1> are you alive?",
  guildId = "guild-1",
  channelId = "general",
  author = {id: "user-1", username: "CaptainPax", bot: false},
  roleIds = ["role-chat"]
} = {}) => {
  const calls = {reply: [], send: [], typing: 0};
  return {
    id: "message-1",
    guildId,
    channelId,
    content,
    author,
    mentions: {
      users: new Set(["bot-1"]),
      has: (id) => id === "bot-1"
    },
    member: {
      displayName: "CaptainPax",
      roles: {
        cache: new Set(roleIds)
      }
    },
    channel: {
      id: channelId,
      sendTyping: async () => {
        calls.typing += 1;
      },
      send: async (payload) => {
        calls.send.push(payload);
        return payload;
      }
    },
    reply: async (payload) => {
      calls.reply.push(payload);
      return payload;
    },
    __calls: calls
  };
};

const createHandler = ({settings = {}, sage = {}, events = []} = {}) => {
  const mergedSettings = {
    guildId: "guild-1",
    noonaChat: {
      enabled: true,
      memoryEnabled: true,
      publicReplies: true,
      proposalMode: "conservative",
      allowedChannelIds: []
    },
    commands: {
      chat: {enabled: true, roleId: "role-chat"}
    },
    ...settings
  };
  return createNoonaMentionHandler({
    getSettings: () => mergedSettings,
    getBotUserId: () => "bot-1",
    sage,
    roleManager: createRoleManager({getSettings: () => mergedSettings}),
    onRuntimeEvent: (event) => events.push(event),
    rateLimitMs: 6000
  });
};

test("Noona mention handler ignores wrong guilds, bots, empty prompts, and unmentioned messages", async () => {
  const calls = {chat: 0};
  const handler = createHandler({
    sage: {
      async noonaChat() {
        calls.chat += 1;
        return {ok: true, payload: {reply: "hi"}};
      }
    }
  });

  assert.equal(await handler(createMessage({guildId: "guild-2"})), false);
  assert.equal(await handler(createMessage({author: {id: "bot-user", username: "Bot", bot: true}})), false);
  assert.equal(await handler(createMessage({content: "<@bot-1>"})), false);
  assert.equal(await handler({
    ...createMessage({content: "are you alive?"}),
    mentions: {users: new Set(), has: () => false}
  }), false);
  assert.equal(calls.chat, 0);
});

test("Noona mention handler replies publicly, sends typing, and preserves trivia by handling only mentioned chat", async () => {
  const payloads = [];
  const events = [];
  const handler = createHandler({
    events,
    sage: {
      async noonaChat(payload) {
        payloads.push(payload);
        return {ok: true, payload: {reply: "LONG LIVE NOONA."}};
      }
    }
  });
  const message = createMessage();

  assert.equal(await handler(message), true);
  assert.equal(message.__calls.typing, 1);
  assert.equal(payloads[0].message, "are you alive?");
  assert.equal(payloads[0].memoryEnabled, true);
  assert.equal(message.__calls.reply[0].content, "LONG LIVE NOONA.");
  assert.deepEqual(message.__calls.reply[0].allowedMentions, {repliedUser: false, parse: []});
  assert.equal(events[0].type, "noona-chat-handled");
});

test("Noona mention handler applies the chat role gate before calling Sage", async () => {
  const handler = createHandler({
    sage: {
      async noonaChat() {
        throw new Error("Sage should not be called when the chat role gate denies access.");
      }
    }
  });
  const message = createMessage({roleIds: []});

  assert.equal(await handler(message), true);
  assert.match(message.__calls.reply[0].content, /permission/i);
});

test("Noona mention handler rate-limits per user and splits long public replies", async () => {
  const longReply = "Noona ".repeat(420);
  const handler = createHandler({
    sage: {
      async noonaChat() {
        return {ok: true, payload: {reply: longReply}};
      }
    }
  });
  const first = createMessage();
  const second = createMessage({content: "<@bot-1> again"});

  assert.equal(await handler(first), true);
  assert.equal(first.__calls.reply.length, 1);
  assert.equal(first.__calls.send.length > 0, true);
  assert.equal(first.__calls.reply[0].content.length <= 1800, true);
  assert.equal(first.__calls.send.every((entry) => entry.content.length <= 1800), true);

  assert.equal(await handler(second), true);
  assert.match(second.__calls.reply[0].content, /catching up/i);
});
