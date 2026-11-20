/** @file The owner slash command forwards explicit automatic advancement without changing legacy payloads. */
import test from "node:test";
import assert from "node:assert/strict";
import {createDownloadAllCommand} from "../lib/discord/commands/downloadAllCommand.mjs";

test("automatic A-Z opt-in and Discord creation identity survive Portal parsing", async () => {
  const calls = [];
  const command = createDownloadAllCommand({getSettings: () => ({superuserId: "owner"}),
    sage: {createBulkRun: async payload => { calls.push(payload); return {ok: true, payload: {runId: "run", status: "queued"}}; }}});
  assert.ok(command.definition.options.find(option => option.name === "run").options.some(option => option.name === "autoadvance" && option.type === 5));
  for (const automatic of [true, false]) {
    const values = {type: "all", nsfw: false, titlegroup: "all", groupsize: 4, autoadvance: automatic};
    await command.execute({id: "interaction", user: {id: "owner"}, deferReply: async () => {}, editReply: async () => {}, deferred: true,
      options: {getSubcommand: () => "run", getString: key => values[key], getBoolean: key => values[key], getInteger: key => values[key]}});
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {providerId: "weebcentral", type: "all", nsfw: false, titlePrefix: "all", batchesPerApproval: 4,
    groupsize: 4, autoAdvance: true, requestedBy: "owner", requestId: "discord:interaction:interaction"});
  assert.equal(Object.hasOwn(calls[1], "autoAdvance"), false);
});
