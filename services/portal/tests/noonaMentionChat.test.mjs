import test from "node:test";
import assert from "node:assert/strict";

import {createNoonaMentionHandler} from "../lib/discord/noonaMentionChat.mjs";
import {createRoleManager} from "../lib/discord/roleManager.mjs";

const createMessage = ({
  content = "<@bot-1> are you alive?",
  guildId = "guild-1",
  channelId = "general",
  author = {id: "user-1", username: "CaptainPax", bot: false},
  roleIds = ["role-chat"],
  mentionIds = ["bot-1"],
  editThrows = false
} = {}) => {
  const calls = {reply: [], send: [], edit: [], typing: 0};
  return {
    id: "message-1",
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
        id: `reply-${calls.reply.length}`,
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

const createHandler = ({
  settings = {},
  sage = {},
  events = [],
  getPeerBotUserIds,
  onReviewCandidate,
  onPeerMentionFollowup,
  isPeerMentionAllowed,
  allowBotAuthoredMessage,
  preparePrompt
} = {}) => {
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
    onReviewCandidate,
    onPeerMentionFollowup,
    getPeerBotUserIds,
    isPeerMentionAllowed,
    allowBotAuthoredMessage,
    preparePrompt
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

test("Noona mention handler strips peer bot mentions before calling Sage", async () => {
  const payloads = [];
  const handler = createHandler({
    getPeerBotUserIds: () => ["appa-1"],
    sage: {
      async noonaChat(payload) {
        payloads.push(payload);
        return {ok: true, payload: {reply: "Noona leads this one."}};
      }
    }
  });
  const message = createMessage({
    content: "<@bot-1> and <@appa-1> are you online?",
    mentionIds: ["bot-1", "appa-1"]
  });

  assert.equal(await handler(message), true);
  assert.equal(payloads[0].message, "are you online?");
  assert.equal(message.__calls.edit[0].content, "<@user-1> Noona leads this one.");
});

test("Noona mention handler awaits review before peer follow-up on dual mentions", async () => {
  const order = [];
  const handler = createHandler({
    getPeerBotUserIds: () => ["appa-1"],
    onReviewCandidate: async (candidate) => {
      order.push(`review:${candidate.reply}`);
    },
    onPeerMentionFollowup: async (candidate) => {
      order.push(`appa:${candidate.reply}`);
    },
    sage: {
      async noonaChat() {
        order.push("noona");
        return {ok: true, payload: {reply: "Noona answers first."}};
      }
    }
  });
  const message = createMessage({
    content: "<@bot-1> and <@appa-1> tell me what you can do",
    mentionIds: ["bot-1", "appa-1"]
  });

  assert.equal(await handler(message), true);
  assert.deepEqual(order, [
    "noona",
    "review:Noona answers first.",
    "appa:Noona answers first."
  ]);
});

test("Noona mention handler still runs peer follow-up after a Noona failure fallback", async () => {
  const followups = [];
  const handler = createHandler({
    getPeerBotUserIds: () => ["appa-1"],
    onPeerMentionFollowup: async (candidate) => {
      followups.push(candidate);
    },
    sage: {
      async noonaChat() {
        throw new Error("fetch failed");
      }
    }
  });
  const message = createMessage({
    content: "<@bot-1> and <@appa-1> are you okay?",
    mentionIds: ["bot-1", "appa-1"]
  });

  assert.equal(await handler(message), true);
  assert.match(message.__calls.edit[0].content, /trouble reaching her brain/);
  assert.equal(followups.length, 1);
  assert.equal(followups[0].noonaOk, false);
  assert.equal(followups[0].noonaErrorReason, "sage-timeout");
});

test("Noona mention handler can allow Appa-channel dual mentions outside normal Noona channels", async () => {
  const payloads = [];
  const handler = createHandler({
    settings: {
      noonaChat: {
        enabled: true,
        memoryEnabled: true,
        proposalMode: "conservative",
        allowedChannelIds: ["public-only"]
      }
    },
    getPeerBotUserIds: () => ["appa-1"],
    isPeerMentionAllowed: ({channelId}) => channelId === "admins",
    sage: {
      async noonaChat(payload) {
        payloads.push(payload);
        return {ok: true, payload: {reply: "Noona can lead here for admins."}};
      }
    }
  });
  const message = createMessage({
    channelId: "admins",
    content: "<@bot-1> and <@appa-1> help",
    mentionIds: ["bot-1", "appa-1"]
  });

  assert.equal(await handler(message), true);
  assert.equal(payloads[0].channelId, "admins");
});

test("Noona mention handler allows one guarded Appa smoke message", async () => {
  const payloads = [];
  const handler = createHandler({
    allowBotAuthoredMessage: () => true,
    preparePrompt: ({prompt}) => prompt.replace(/\[smoke:[^\]]+\]/, "").replace(/\s+/g, " ").trim(),
    sage: {
      async noonaChat(payload) {
        payloads.push(payload);
        return {ok: true, payload: {reply: "I am online."}};
      }
    }
  });
  const message = createMessage({
    content: "<@bot-1> [smoke:abc123] are you online?",
    author: {id: "appa-1", username: "Appa", bot: true},
    mentionIds: ["bot-1"]
  });

  assert.equal(await handler(message), true);
  assert.equal(payloads[0].message, "are you online?");
  assert.equal(message.__calls.edit[0].content, "<@appa-1> I am online.");
});

test("Noona mention handler relies on Sage for Noona chat permission denials", async () => {
  const calls = {sage: 0};
  const handler = createHandler({
    sage: {
      async noonaChat() {
        calls.sage += 1;
        return {
          ok: false,
          status: 403,
          payload: {
            reply: "You do not have Noona chat access yet."
          }
        };
      }
    }
  });
  const message = createMessage({roleIds: []});

  assert.equal(await handler(message), true);
  assert.equal(calls.sage, 1);
  assert.match(message.__calls.edit[0].content, /<@user-1> .*Noona chat access/i);
});

test("Noona mention handler suppresses raw Sage errors in public replies", async () => {
  const events = [];
  const handler = createHandler({
    events,
    sage: {
      async noonaChat() {
        return {ok: false, payload: {error: "fetch failed token=secret"}};
      }
    }
  });
  const message = createMessage();

  assert.equal(await handler(message), true);
  assert.doesNotMatch(message.__calls.edit[0].content, /fetch failed|token=secret/i);
  assert.match(message.__calls.edit[0].content, /trouble reaching her brain/i);
  assert.equal(events[0].type, "noona-chat-error");
  assert.equal(events[0].message, "sage-error");
});

test("Noona mention handler falls back when placeholder edit fails", async () => {
  const events = [];
  const handler = createHandler({
    events,
    sage: {
      async noonaChat() {
        return {ok: true, payload: {reply: "fallback delivery worked"}};
      }
    }
  });
  const message = createMessage({editThrows: true});

  assert.equal(await handler(message), true);
  assert.equal(message.__calls.send[0].content, "<@user-1> fallback delivery worked");
  assert.equal(events.some((event) => event.type === "noona-chat-delivery-degraded"), true);
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
