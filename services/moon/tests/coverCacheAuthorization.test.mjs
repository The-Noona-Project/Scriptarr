import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import {registerMoonV3ProxyRoutes} from "../lib/registerMoonV3ProxyRoutes.mjs";

test("cover fallback cache retains exact Sage authorization for sessions and API keys", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-cover-auth-"));
  const avif = await sharp({create: {width: 8, height: 12, channels: 3, background: "#19a276"}}).avif().toBuffer();
  const pagePath = "/api/moon-v3/user/reader/title/title-1/chapter/chapter-1/page/0?rev=avif-1234567890abcdef";
  let sourceStatus = 200, pageStatus = 200, revoked = false, invalidPath = false;
  let sourceCalls = 0, pageCalls = 0;
  const sage = http.createServer((req, res) => {
    const authorized = req.headers.authorization === "Bearer member-session" && !revoked || req.headers["x-scriptarr-api-key"] === "member-api-key";
    const json = (status, body) => {res.writeHead(status, {"Content-Type": "application/json"}); res.end(JSON.stringify(body));};
    if (!authorized) {json(401, {error: "Unauthorized"}); return;}
    if (req.url === "/api/moon-v3/admin/system/tasks") {json(200, {tasks: []}); return;}
    if (req.url.startsWith("/api/moon-v3/user/library?")) {
      json(200, {titles: [{id: "title-1", coverUrl: ""}, {id: "no-art"}, {id: "broken-source"}], pageInfo: {nextCursor: ""}}); return;
    }
    if (req.url === "/api/moon-v3/user/library/cover/no-art/source") {json(404, {error: "No artwork"}); return;}
    if (req.url === "/api/moon-v3/user/library/cover/broken-source/source") {json(503, {error: "Broker unavailable"}); return;}
    if (req.url === "/api/moon-v3/user/library/cover/title-1/source") {
      sourceCalls++;
      json(sourceStatus, sourceStatus === 200 ? {titleId: "title-1", coverUrl: "", coverRevision: "revision-1",
        fallbackPagePath: invalidPath ? pagePath.replace("title-1", "foreign-title") : pagePath} : {error: "Not available"});
      return;
    }
    if (req.url === pagePath) {
      pageCalls++;
      if (pageStatus !== 200) {json(pageStatus, {error: "Page not available"}); return;}
      res.writeHead(200, {"Content-Type": "image/avif"}); res.end(avif); return;
    }
    json(404, {error: "Unknown route"});
  });
  await new Promise(resolve => sage.listen(0, "127.0.0.1", resolve));
  const app = express();
  registerMoonV3ProxyRoutes(app, {config: {sageBaseUrl: `http://127.0.0.1:${sage.address().port}`, coverCacheDir: directory},
    getSessionToken: req => (req.headers.cookie || "").match(/scriptarr_session=([^;]+)/)?.[1] || "", logger: {warn() {}}});
  const moon = app.listen(0, "127.0.0.1");
  await new Promise(resolve => moon.once("listening", resolve));
  t.after(async () => {
    moon.closeAllConnections(); sage.closeAllConnections();
    await Promise.all([new Promise(resolve => moon.close(resolve)), new Promise(resolve => sage.close(resolve))]);
    await fs.rm(directory, {recursive: true, force: true});
  });
  const url = `http://127.0.0.1:${moon.address().port}/api/moon-v3/user/covers/title-1.webp?rev=revision-1`;
  const headers = {cookie: "scriptarr_session=member-session"};
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {headers});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(response.headers.get("cache-control"), "private, no-cache, must-revalidate");
    assert.match(response.headers.get("vary"), /Cookie/);
    assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format, "webp");
  }
  assert.equal(sourceCalls, 2); assert.equal(pageCalls, 2, "warm fallback cache still fetches the exact authorized page");
  assert.equal((await fetch(url)).status, 401);
  revoked = true;
  assert.equal((await fetch(url, {headers})).status, 401);
  assert.equal((await fetch(url, {headers: {"X-Scriptarr-Api-Key": "member-api-key"}})).status, 200);
  revoked = false;
  for (const status of [401, 403, 503]) {
    pageStatus = status;
    assert.equal((await fetch(url, {headers})).status, status, "a warm cache cannot mask page denial or broker failure");
  }
  pageStatus = 200; sourceStatus = 503;
  const before = pageCalls;
  assert.equal((await fetch(url, {headers})).status, 503);
  assert.equal(pageCalls, before, "source authentication/availability must succeed before a fallback read");
  sourceStatus = 204;
  assert.equal((await fetch(url, {headers})).status, 502, "an empty successful source response is a real broker error");
  assert.equal(pageCalls, before);
  sourceStatus = 200; invalidPath = true;
  assert.equal((await fetch(url, {headers})).status, 502);
  assert.equal(pageCalls, before, "a cross-title path must never be fetched");
  invalidPath = false;
  const optimizer = url.replace("user/covers/title-1.webp?rev=revision-1", "admin/system/tasks/cover-cache/optimize");
  assert.equal((await fetch(optimizer, {method: "POST"})).status, 401);
  const response = await fetch(optimizer, {method: "POST", headers});
  const optimized = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual({scanned: optimized.scanned, converted: optimized.converted, skipped: optimized.skipped, failed: optimized.failed},
    {scanned: 3, converted: 0, skipped: 2, failed: 1});
  assert.equal(pageCalls, before + 1, "the optimizer processes blank primary art with the same authenticated fallback");
});
