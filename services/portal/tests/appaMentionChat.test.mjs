import test from "node:test";
import assert from "node:assert/strict";

import {createAppaMentionHandler} from "../lib/discord/appaMentionChat.mjs";
import {createRoleManager} from "../lib/discord/roleManager.mjs";

const createMessage = ({
  content = "<@appa-1> are you online?",
  guildId = "guild-1",
  channelId = "admins",
  author = {id: "admin-1", username: "CaptainPax", bot: false},
  roleIds = ["role-appa"],
  mentionIds = ["appa-1"],
  editThrows = false
} = {}) => {
  const calls = {reply: [], send: [], edit: [], typing: 0};
  return {
    id: "appa-message-1",
    guildId,
    channelId,
    content,
    author,
    mentions: {
      users: new Set(mentionIds),
      has: (id) => mentionIds.includes(id)
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
        id: `appa-reply-${calls.reply.length}`,
        ...payload,
        edit: async (nextPayload) => {
          if (editThrows) {
            throw new Error("edit failed");
          }
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

const createHandler = ({settings = {}, sage = {}, events = [], getPeerBotUserIds} = {}) => {
  const mergedSettings = {
    guildId: "guild-1",
    appa: {
      enabled: true,
      adminMentionChannelIds: [],
      commands: {
        status: {enabled: true, roleId: "role-appa"}
      }
    },
    ...settings
  };
  return createAppaMentionHandler({
    getSettings: () => mergedSettings,
    getBotUserId: () => "appa-1",
    sage,
    roleManager: createRoleManager({
      getSettings: () => mergedSettings,
      getCommandSettings: (currentSettings, commandName) => currentSettings.appa.commands[commandName] || {}
    }),
    onRuntimeEvent: (event) => events.push(event),
    getPeerBotUserIds
  });
};

test("Appa mention handler sends Thinking and edits the public admin reply", async () => {
  const payloads = [];
  const events = [];
  const handler = createHandler({
    events,
    sage: {
      async appaChat(payload) {
        payloads.push(payload);
        return {ok: true, payload: {reply: "Appa is online."}};
      }
    }
  });
  const message = createMessage();

  assert.equal(await handler(message), true);
  assert.equal(message.__calls.typing, 1);
  assert.equal(payloads[0].message, "are you online?");
  assert.equal(message.__calls.reply[0].content, "<@admin-1> Thinking...");
  assert.equal(message.__calls.edit[0].content, "<@admin-1> Appa is online.");
  assert.deepEqual(message.__calls.edit[0].allowedMentions, {users: ["admin-1"], repliedUser: false, parse: []});
  assert.equal(events[0].type, "appa-chat-handled");
});

test("Appa mention handler applies the admin role gate before calling Sage", async () => {
  const events = [];
  const handler = createHandler({
    events,
    sage: {
      async appaChat() {
        throw new Error("Sage should not be called when the Appa role gate denies access.");
      }
    }
  });
  const message = createMessage({roleIds: []});

  assert.equal(await handler(message), true);
  assert.match(message.__calls.reply[0].content, /<@admin-1> .*permission/i);
  assert.equal(events[0].type, "appa-chat-rejected");
  assert.equal(events[0].reason, "role-denied");
});

test("Appa mention handler lets Noona lead dual public mentions", async () => {
  const events = [];
  const handler = createHandler({
    events,
    getPeerBotUserIds: () => ["noona-1"],
    sage: {
      async appaChat() {
        throw new Error("Appa should not answer co-mentions.");
      }
    }
  });
  const message = createMessage({
    content: "<@noona-1> and <@appa-1> are you online?",
    mentionIds: ["noona-1", "appa-1"]
  });

  assert.equal(await handler(message), false);
  assert.equal(message.__calls.reply.length, 0);
  assert.equal(events[0].type, "appa-chat-rejected");
  assert.equal(events[0].reason, "co-mention-noona-led");
});

test("Appa mention handler suppresses raw Sage errors in public replies", async () => {
  const events = [];
  const handler = createHandler({
    events,
    sage: {
      async appaChat() {
        return {ok: false, payload: {error: "fetch failed token=secret"}};
      }
    }
  });
  const message = createMessage();

  assert.equal(await handler(message), true);
  assert.doesNotMatch(message.__calls.edit[0].content, /fetch failed|token=secret/i);
  assert.match(message.__calls.edit[0].content, /trouble reaching the admin thread/i);
  assert.equal(events[0].type, "appa-chat-error");
  assert.equal(events[0].message, "sage-error");
});

test("Appa mention handler falls back when placeholder edit fails", async () => {
  const events = [];
  const handler = createHandler({
    events,
    sage: {
      async appaChat() {
        return {ok: true, payload: {reply: "fallback delivery worked"}};
      }
    }
  });
  const message = createMessage({editThrows: true});

  assert.equal(await handler(message), true);
  assert.equal(message.__calls.send[0].content, "<@admin-1> fallback delivery worked");
  assert.equal(events.some((event) => event.type === "appa-chat-delivery-degraded"), true);
});

test("Appa mention handler queues concurrent Appa requests", async () => {
  let releaseFirst;
  const handler = createHandler({
    sage: {
      async appaChat(payload) {
        if (payload.message === "are you online?") {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
          return {ok: true, payload: {reply: "first admin answer"}};
        }
        return {ok: true, payload: {reply: "second admin answer"}};
      }
    }
  });
  const first = createMessage();
  const second = createMessage({content: "<@appa-1> second check"});

  const firstRun = handler(first);
  await new Promise((resolve) => setImmediate(resolve));
  const secondRun = handler(second);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(first.__calls.reply[0].content, "<@admin-1> Thinking...");
  assert.equal(second.__calls.reply[0].content, "<@admin-1> Working on 1 request ahead of you. Please wait.");

  releaseFirst();
  await Promise.all([firstRun, secondRun]);
  assert.equal(first.__calls.edit[0].content, "<@admin-1> first admin answer");
  assert.equal(second.__calls.edit[0].content, "<@admin-1> Thinking...");
  assert.equal(second.__calls.edit[1].content, "<@admin-1> second admin answer");
});
