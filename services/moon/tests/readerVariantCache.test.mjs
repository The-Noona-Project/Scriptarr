/** @file Reader cache isolation for segmented pages and full-page thumbnails. */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import {registerMoonV3ProxyRoutes} from "../lib/registerMoonV3ProxyRoutes.mjs";

test("reader cache keeps tiles and whole-page thumbnails separate and rejects wrong-variant probes/bytes", async (t) => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-reader-variants-"));
  let imageRequests = 0, wrongProbe = false, wrongBytes = false;
  const sage = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    const segmentIndex = Number(url.searchParams.get("segment") || 0), thumbnail = url.searchParams.get("thumbnail") === "true";
    if (req.headers.authorization !== "Bearer fixture-member") { res.writeHead(401); res.end(); return; }
    if (url.pathname.endsWith("/status")) {
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({ok: true, status: 200, segmentIndex: wrongProbe ? 0 : segmentIndex,
        thumbnail: wrongProbe ? false : thumbnail, cacheable: true, pageIndex: 0})); return;
    }
    imageRequests++;
    res.writeHead(200, {"Content-Type": "image/webp", "Cache-Control": "private, max-age=604800",
      "X-Scriptarr-Segment-Index": String(wrongBytes ? 0 : segmentIndex), "X-Scriptarr-Thumbnail": String(wrongBytes ? false : thumbnail)});
    res.end(thumbnail ? "synthetic-whole-page" : `synthetic-tile-${segmentIndex}`);
  });
  await new Promise((resolve) => sage.listen(0, "127.0.0.1", resolve));
  const app = express();
  registerMoonV3ProxyRoutes(app, {config: {sageBaseUrl: `http://127.0.0.1:${sage.address().port}`, readerPageCacheDir: cacheRoot},
    getSessionToken: (req) => req.headers.cookie === "member=yes" ? "fixture-member" : "", logger: {warn() {}}});
  const moon = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => moon.once("listening", resolve));
  t.after(async () => {
    moon.closeAllConnections(); sage.closeAllConnections();
    await Promise.all([new Promise((resolve) => moon.close(resolve)), new Promise((resolve) => sage.close(resolve))]);
    assert.ok(path.resolve(cacheRoot).startsWith(path.resolve(os.tmpdir()) + path.sep + "scriptarr-reader-variants-"));
    await fs.rm(cacheRoot, {recursive: true, force: true});
  });
  const base = `http://127.0.0.1:${moon.address().port}/api/moon-v3/user/reader/title/t/chapter/c/page/0?rev=webp-1234567890abcdef`;
  const headers = {Cookie: "member=yes"};
  for (const [suffix, expected] of [["", "synthetic-tile-0"], ["&segment=1", "synthetic-tile-1"], ["&thumbnail=true", "synthetic-whole-page"]]) {
    const cold = await fetch(base + suffix, {headers});
    assert.equal(cold.status, 200); assert.equal(await cold.text(), expected);
    let hit;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      hit = await fetch(base + suffix, {headers});
      assert.equal(await hit.text(), expected);
      if (hit.headers.get("x-scriptarr-reader-cache") === "hit") break;
    }
    assert.equal(hit.headers.get("x-scriptarr-reader-cache"), "hit");
  }
  assert.equal(imageRequests, 3);
  const alias = await fetch(base + "&segment=0", {headers});
  assert.equal(alias.headers.get("x-scriptarr-reader-cache"), "hit"); await alias.text();
  wrongProbe = true;
  for (const suffix of ["&segment=1", "&thumbnail=true"]) {
    const denied = await fetch(base + suffix, {headers});
    assert.equal(denied.status, 503); assert.doesNotMatch(await denied.text(), /synthetic-/);
  }
  wrongProbe = false;
  const anonymous = await fetch(base + "&segment=1");
  assert.equal(anonymous.status, 401); assert.doesNotMatch(await anonymous.text(), /synthetic-/);
  wrongBytes = true;
  const wrong = await fetch(base.replace("1234567890abcdef", "abcdef1234567890") + "&segment=1", {headers});
  assert.equal(wrong.status, 502); assert.doesNotMatch(await wrong.text(), /synthetic-/);
  assert.equal((await fetch(base + "&segment=01", {headers})).status, 400);
});
