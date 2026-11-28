/** @file Real HTTP release artwork and service authorization regressions. */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import {registerReleaseFeedRoutes} from "../lib/registerReleaseFeedRoutes.mjs";
import {buildReleaseFeedEvent, releaseTitleJobId} from "../lib/releaseFeed.mjs";

const event = buildReleaseFeedEvent({title: {id: "title", title: "Title", libraryTypeSlug: "manga"},
  chapters: [{id: "c1", chapterNumber: "1"}], kind: "title", channelId: "123", publicBaseUrl: "https://pax-kun.com"});

test("artwork broker authenticates Portal, binds the canonical event, and never exposes the coordinator credential", async t => {
  let calls = 0, mode = "valid";
  const job = {jobId: releaseTitleJobId("title"), result: {pending: {event}}};
  const app = express(); app.use(express.json());
  registerReleaseFeedRoutes(app, {config: {ravenBaseUrl: "http://coordinator", serviceTokens: {"scriptarr-raven": "private-coordinator-token"}},
    vaultClient: {async getJob(id) {return id === job.jobId ? job : null;}},
    requireService: services => (req, res, next) => {assert.deepEqual(services, ["scriptarr-portal"]); if (req.headers.authorization !== "Bearer portal") res.sendStatus(403); else next();},
    async fetchImpl(url, options) {
      calls++; assert.equal(url, "http://coordinator/v1/library/title/notification-art");
      assert.equal(options.headers.Authorization, "Bearer private-coordinator-token"); assert.equal(options.redirect, "error");
      return new Response(mode === "large" ? Buffer.alloc(2 * 1024 * 1024 + 1) : "raster", {headers: {"Content-Type": mode === "html" ? "text/html" : "image/webp", "X-Scriptarr-Art-Source": "first-page"}});
    }});
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const path = `http://127.0.0.1:${server.address().port}/api/internal/portal/notifications/releases/${encodeURIComponent(event.id)}/art`;
  assert.equal((await fetch(path)).status, 403); assert.equal(calls, 0);
  const response = await fetch(path, {headers: {Authorization: "Bearer portal"}});
  assert.equal(response.status, 200); assert.equal(await response.text(), "raster");
  assert.equal(response.headers.get("x-scriptarr-art-source"), "first-page"); assert.equal(response.headers.get("authorization"), null);
  for (mode of ["html", "large"]) assert.equal((await fetch(path, {headers: {Authorization: "Bearer portal"}})).status, 503);
  assert.equal((await fetch(path.replace(encodeURIComponent(event.id), "release-feed:invalid"), {headers: {Authorization: "Bearer portal"}})).status, 400);
});
