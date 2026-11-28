/** @file Durable per-type title caps remain distinct from Discord approval batch windows. */
import test from "node:test";
import assert from "node:assert/strict";
import {createDownloadAllCommand} from "../lib/discord/commands/downloadAllCommand.mjs";
import {parseDownloadAllCommand, formatBulkRunSummary} from "../lib/discord/downloadAllShared.mjs";
import {buildDownloadAllDirectMessagePayload} from "../lib/followNotifier.mjs";

test("owner A pilot forwards the exact cap, scope, false policy and interaction identity", async () => {
  let body;
  const command = createDownloadAllCommand({getSettings: () => ({superuserId: "owner"}), sage: {
    createBulkRun: async value => { body = value; return {ok: true, payload: {runId: "run", status: "queued"}}; }
  }});
  const values = {type: "all", nsfw: false, titlegroup: "a", groupsize: 1, titlelimit: 30, autoadvance: false};
  await command.execute({id: "pilot", user: {id: "owner"}, deferred: true, deferReply: async () => {}, editReply: async () => {},
    options: {getSubcommand: () => "run", getString: key => values[key], getBoolean: key => values[key], getInteger: key => values[key]}});
  assert.equal(body.titleLimit, 30); assert.equal(body.batchesPerApproval, 1);
  assert.equal(body.type, "all"); assert.equal(body.titlePrefix, "a"); assert.equal(body.nsfw, false);
  assert.equal(body.requestId, "discord:interaction:pilot"); assert.equal(Object.hasOwn(body, "autoAdvance"), false);
  assert.ok(command.definition.options.find(o => o.name === "run").options.some(o => o.name === "titlelimit" && o.min_value === 1));
});

test("legacy text accepts a positive cap and rejects malformed values without changing groupsize", () => {
  const base = "downloadall type:all nsfw:false titlegroup:a groupsize:1";
  assert.equal(parseDownloadAllCommand(base).filters.titleLimit, undefined);
  const parsed = parseDownloadAllCommand(base + " titlelimit:30");
  assert.equal(parsed.valid, true); assert.equal(parsed.filters.titleLimit, 30); assert.equal(parsed.filters.batchesPerApproval, 1);
  for (const value of ["0", "-1", "1.5", "true", "2147483648", "30x"]) assert.equal(parseDownloadAllCommand(base + " titlelimit:" + value).valid, false);
});

test("capped summaries keep zero selected, deferred scope and actual failure counts separate", () => {
  const text = formatBulkRunSummary({runId: "run", status: "paused", filters: {titleLimit: 30},
    counts: {selectedCount: 0, deferredByLimitCount: 35, failedTitleTaskCount: 2}});
  assert.match(text, /Title limit: 30/); assert.match(text, /Selected: 0/); assert.match(text, /Deferred by limit: 35/);
  assert.match(text, /failed.*2|2.*failed/i);
  const dm = buildDownloadAllDirectMessagePayload({runId: "run", status: "paused", filters: {titleLimit: 30},
    counts: {selectedCount: 30, deferredByLimitCount: 5, failedTitleTaskCount: 2}});
  const fields = JSON.stringify(dm.embeds[0].fields);
  assert.match(fields, /Selected titles: \*\*30/); assert.match(fields, /Deferred by limit: \*\*5/);
  assert.match(fields, /Failed title tasks: \*\*2/);
});
