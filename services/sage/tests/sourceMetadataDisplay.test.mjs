/** @file Metadata provenance and repair authorization regression coverage. */
import test from "node:test";
import assert from "node:assert/strict";
import {sourceMetadataDisplay} from "../lib/sourceMetadataDisplay.mjs";
import {registerSourceMetadataRoutes} from "../lib/registerSourceMetadataRoutes.mjs";

test("display keeps provider and source facts separate and rejects executable URLs", () => {
  const value = sourceMetadataDisplay({provider: "mangadex", providerSeriesId: "2020", details: {
    title: "The King's Avatar", releaseLabel: "2020", status: "hiatus", url: "javascript:alert(1)", tags: ["Action", "Video Games"],
    tagGroups: [{tag: "Action", group: "genre"}, {tag: "Video Games", group: "theme"}],
    sourceBinding: {decision: "verified-provider", source: {title: "The King's Avatar (Reboot)", year: "2020", status: "ongoing", adultContent: false, url: "https://weebcentral.com/series/source"}}
  }});
  assert.equal(value.provider.url, "");
  assert.equal(value.source.adultContent, false);
  assert.equal(value.provider.status, "hiatus");
  assert.equal(value.source.status, "ongoing");
  assert.deepEqual(value.tagGroups.map((row) => row.group), ["genre", "theme"]);
  assert.equal(value.conflicts.length, 1);
  assert.equal(sourceMetadataDisplay(null).decision, "unverified");
  assert.equal(sourceMetadataDisplay({details: {status: "cancelled", sourceBinding: {source: {status: "Canceled"}}}}).conflicts.length, 0);
});

test("owner repair cannot cross ownership and forwards only captured decision identifiers", async () => {
  const routes = new Map();
  const app = {get: (path, handler) => routes.set(`GET ${path}`, handler), post: (path, handler) => routes.set(`POST ${path}`, handler)};
  const calls = [];
  let runOwner = "owner";
  registerSourceMetadataRoutes(app, {
    userRead: (fn) => fn, adminRead: (fn) => fn, ownerWrite: (fn) => fn,
    readOwnerId: async () => "owner", loadTitle: async () => null, loadUserSummary: async () => null,
    vaultClient: {}, ravenBaseUrl: "http://raven", serviceJson: async (_base, path, options) => {
      calls.push({path, options}); return {ok: true, status: 200, payload: options ? {started: false} : {requestedBy: runOwner}};
    }
  });
  const handler = routes.get("POST /api/moon-v3/admin/activity/bulk-runs/:runId/recheck-metadata");
  const res = {statusCode: 200, status(code) {this.statusCode = code; return this;}, json(value) {this.body = value;}};
  await handler({user: {discordUserId: "other"}, params: {runId: "run"}, body: {}}, res);
  assert.equal(res.statusCode, 403); assert.equal(calls.length, 0);
  res.statusCode = 200; runOwner = "other";
  await handler({user: {discordUserId: "owner"}, params: {runId: "run"}, body: {}}, res);
  assert.equal(res.statusCode, 403); assert.equal(calls.length, 1);
  res.statusCode = 200; runOwner = "owner";
  await handler({user: {discordUserId: "owner"}, params: {runId: "run"}, body: {approvalId: "approval", requestId: "request", start: true}}, res);
  assert.deepEqual(calls.at(-1).options.body, {approvalId: "approval", requestId: "request"});
  assert.equal(res.body.started, false);
});
