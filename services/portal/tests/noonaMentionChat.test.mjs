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
  const calls = {reply: [], send: [], edit: [], typing: 0};
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
      const editable = {
        id: `reply-${calls.reply.length}`,
        ...payload,
        edit: async (nextPayload) => {
          calls.edit.push(nextPayload);
          Object.assign(editable, nextPayload);
          return editable;
        }
      };
      return editable;
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
    onRuntimeEvent: (event) => events.push(event)
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

test("Noona mention handler sends Thinking, edits the public reply, and preserves trivia by handling only mentioned chat", async () => {
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
  assert.equal(message.__calls.reply[0].content, "<@user-1> Thinking...");
  assert.equal(message.__calls.edit[0].content, "<@user-1> LONG LIVE NOONA.");
  assert.deepEqual(message.__calls.edit[0].allowedMentions, {users: ["user-1"], repliedUser: false, parse: []});
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
  assert.match(message.__calls.reply[0].content, /<@user-1> .*permission/i);
});

test("Noona mention handler edits the first long chunk and sends overflow chunks", async () => {
  const longReply = "Noona ".repeat(420);
  const handler = createHandler({
    sage: {
      async noonaChat() {
        return {ok: true, payload: {reply: longReply}};
      }
    }
  });
  const first = createMessage();

  assert.equal(await handler(first), true);
  assert.equal(first.__calls.reply.length, 1);
  assert.equal(first.__calls.send.length > 0, true);
  assert.equal(first.__calls.reply[0].content, "<@user-1> Thinking...");
  assert.equal(first.__calls.edit[0].content.length <= 1800, true);
  assert.match(first.__calls.edit[0].content, /^<@user-1> Noona/);
  assert.equal(first.__calls.send.every((entry) => entry.content.length <= 1800), true);
});

test("Noona mention handler queues concurrent requests per bot", async () => {
  let releaseFirst;
  const handler = createHandler({
    sage: {
      async noonaChat(payload) {
        if (payload.message === "are you alive?") {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
          return {ok: true, payload: {reply: "first done"}};
        }
        return {ok: true, payload: {reply: "second done"}};
      }
    }
  });
  const first = createMessage();
  const second = createMessage({content: "<@bot-1> again"});

  const firstRun = handler(first);
  await new Promise((resolve) => setImmediate(resolve));
  const secondRun = handler(second);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(first.__calls.reply[0].content, "<@user-1> Thinking...");
  assert.equal(second.__calls.reply[0].content, "<@user-1> Working on 1 request ahead of you. Please wait.");

  releaseFirst();
  await Promise.all([firstRun, secondRun]);
  assert.equal(first.__calls.edit[0].content, "<@user-1> first done");
  assert.equal(second.__calls.edit[0].content, "<@user-1> Thinking...");
  assert.equal(second.__calls.edit[1].content, "<@user-1> second done");
});
