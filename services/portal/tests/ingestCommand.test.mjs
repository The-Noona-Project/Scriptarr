import test from "node:test";
import assert from "node:assert/strict";

import {createPortalCommands} from "../lib/discord/commands/index.mjs";
import {createInteractionHandler} from "../lib/discord/interactionRouter.mjs";
import {createRoleManager} from "../lib/discord/roleManager.mjs";
import {INGEST_CONFIRM_TTL_MS} from "../lib/discord/constants.mjs";

const createLogger = () => ({
  info() {},
  warn() {},
  error() {}
});

const createInteraction = ({
  commandName = "ingest",
  guildId = "guild-1",
  channelId = "admin-channel",
  roleIds = [],
  strings = {},
  userId = "admin-1"
} = {}) => {
  const calls = {reply: [], editReply: [], deferReply: []};
  const interaction = {
    commandName,
    guildId,
    channelId,
    user: {
      id: userId,
      username: "CaptainPax",
      globalName: "CaptainPax"
    },
    member: {
      roles: {
        cache: new Set(roleIds)
      }
    },
    options: {
      getString: (name) => strings[name] || null
    },
    isChatInputCommand: () => true,
    isButton: () => false,
    reply: async (payload) => {
      calls.reply.push(payload);
      return payload;
    },
    editReply: async (payload) => {
      calls.editReply.push(payload);
      return payload;
    },
    deferReply: async (payload) => {
      calls.deferReply.push(payload);
      interaction.deferred = true;
      return payload;
    },
    deferred: false,
    replied: false,
    __calls: calls
  };
  return interaction;
};

const createButtonInteraction = ({customId, userId = "admin-1"} = {}) => {
  const calls = {reply: [], editReply: []};
  return {
    customId,
    user: {
      id: userId,
      username: "CaptainPax",
      globalName: "CaptainPax"
    },
    isChatInputCommand: () => false,
    isButton: () => true,
    reply: async (payload) => {
      calls.reply.push(payload);
      return payload;
    },
    editReply: async (payload) => {
      calls.editReply.push(payload);
      return payload;
    },
    deferred: false,
    replied: false,
    __calls: calls
  };
};

const createAppaIngestHandler = ({settings, sage}) => {
  const commands = createPortalCommands({
    sage,
    getBrandName: () => "Scriptarr"
  });
  return createInteractionHandler({
    commandMap: commands,
    roleManager: createRoleManager({
      getSettings: () => settings,
      getCommandSettings: (currentSettings, commandName) => currentSettings.appa?.commands?.[commandName] || {}
    }),
    logger: createLogger()
  });
};

test("Appa ingest command uses appa.commands.ingest and previews through Sage before confirming", async () => {
  const previewCalls = [];
  const runCalls = [];
  const settings = {
    guildId: "guild-1",
    appa: {
      commands: {
        ingest: {enabled: true, roleId: "role-appa-ingest"}
      }
    },
    commands: {
      ingest: {enabled: true, roleId: "legacy-ingest-role"}
    }
  };
  const handler = createAppaIngestHandler({
    settings,
    sage: {
      async previewIngestRun(payload) {
        previewCalls.push(payload);
        return {
          ok: true,
          payload: {
            previewId: "preview-1",
            message: "Three pending titles can be retried.",
            summary: {
              pendingTitles: 3,
              failedTitles: 1
            }
          }
        };
      },
      async runIngest(payload) {
        runCalls.push(payload);
        return {ok: true, payload: {runId: "ingest-run-1", status: "started"}};
      }
    }
  });

  const denied = createInteraction({
    roleIds: ["legacy-ingest-role"],
    strings: {type: "manhwa"}
  });
  await handler(denied);
  assert.match(denied.__calls.reply[0].content, /permission/i);
  assert.equal(previewCalls.length, 0);

  const allowed = createInteraction({
    roleIds: ["role-appa-ingest"],
    strings: {type: "manhwa"}
  });
  await handler(allowed);
  assert.deepEqual(previewCalls[0], {
    type: "manhwa",
    requestedBy: "admin-1",
    guildId: "guild-1",
    channelId: "admin-channel",
    source: "discord-appa-slash"
  });
  const previewReply = allowed.__calls.editReply[0];
  assert.match(previewReply.content, /ingest preview/i);
  assert.match(previewReply.content, /Confirm within 5 minutes/i);
  const confirmId = previewReply.components[0].components[0].custom_id;
  assert.match(confirmId, /^portal:ingest-confirm:/);

  const wrongUser = createButtonInteraction({customId: confirmId, userId: "admin-2"});
  await handler(wrongUser);
  assert.match(wrongUser.__calls.reply[0].content, /Only the user/i);
  assert.equal(runCalls.length, 0);
});

test("Appa ingest confirm expires after five minutes and fresh confirms call Sage run", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const runCalls = [];
  const settings = {
    guildId: "guild-1",
    appa: {
      commands: {
        ingest: {enabled: true, roleId: "role-appa-ingest"}
      }
    }
  };
  const handler = createAppaIngestHandler({
    settings,
    sage: {
      async previewIngestRun(payload) {
        return {
          ok: true,
          payload: {
            previewId: `${payload.type}-preview`,
            previewToken: `${payload.type}-token`,
            summary: {pendingTitles: 2}
          }
        };
      },
      async runIngest(payload) {
        runCalls.push(payload);
        return {
          ok: true,
          payload: {
            runId: "ingest-run-2",
            status: "started",
            queuedCount: 2
          }
        };
      }
    }
  });

  try {
    const stalePreview = createInteraction({
      roleIds: ["role-appa-ingest"],
      strings: {type: "comic"}
    });
    await handler(stalePreview);
    const staleConfirmId = stalePreview.__calls.editReply[0].components[0].components[0].custom_id;
    now += INGEST_CONFIRM_TTL_MS + 1;

    const expired = createButtonInteraction({customId: staleConfirmId});
    await handler(expired);
    assert.match(expired.__calls.reply[0].content, /expired/i);
    assert.equal(runCalls.length, 0);

    const freshPreview = createInteraction({
      roleIds: ["role-appa-ingest"],
      strings: {type: "comic"}
    });
    await handler(freshPreview);
    const freshConfirmId = freshPreview.__calls.editReply[0].components[0].components[0].custom_id;

    const confirm = createButtonInteraction({customId: freshConfirmId});
    await handler(confirm);
    assert.match(confirm.__calls.reply[0].content, /Run ID: ingest-run-2/);
    assert.equal(runCalls.length, 1);
    assert.equal(runCalls[0].type, "comic");
    assert.equal(runCalls[0].requestedBy, "admin-1");
    assert.equal(runCalls[0].confirmedBy, "admin-1");
    assert.equal(runCalls[0].previewId, "comic-preview");
    assert.equal(runCalls[0].previewToken, "comic-token");
    assert.match(runCalls[0].confirmedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    Date.now = originalNow;
  }
});
