import test from "node:test";
import assert from "node:assert/strict";

import {createAppaMentionHandler} from "../lib/discord/appaMentionChat.mjs";
import {createRoleManager} from "../lib/discord/roleManager.mjs";

const createMessage = ({
  content = "<@appa-1> are you online?",
  guildId = "guild-1",
  channelId = "admins",
  author = {id: "admin-1", username: "CaptainPax", bot: false},
  roleIds = ["role-appa"]
} = {}) => {
  const calls = {reply: [], send: [], edit: [], typing: 0};
  return {
    id: "appa-message-1",
    guildId,
    channelId,
    content,
    author,
    mentions: {
      users: new Set(["appa-1"]),
      has: (id) => id === "appa-1"
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
    onRuntimeEvent: (event) => events.push(event)
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
