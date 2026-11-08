import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import {registerMoonV3ProxyRoutes} from "../lib/registerMoonV3ProxyRoutes.mjs";

const PRIVATE_PAGE = "synthetic-private-reader-page";

/**
 * Verify warm reader cache entries never replace Sage's current authorization.
 */
test("cached reader pages recheck sessions, API keys and page access before returning bytes", async (t) => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-reader-cache-auth-"));
  const previousTimeout = process.env.SCRIPTARR_MOON_V3_JSON_PROXY_TIMEOUT_MS;
  process.env.SCRIPTARR_MOON_V3_JSON_PROXY_TIMEOUT_MS = "100";
  let mode = "ready";
  let imageRequests = 0;
  let probes = 0;
  let revoked = false;
  const sage = http.createServer((req, res) => {
    const session = req.headers.authorization;
    const apiKey = req.headers["x-scriptarr-api-key"];
    const authorized = session === "Bearer valid-session" && !revoked || apiKey === "valid-api-key";
    const send = (status, payload) => {
      res.writeHead(status, {"Content-Type": "application/json", "Cache-Control": "no-store"});
      res.end(JSON.stringify(payload));
    };
    if (session === "Bearer page-forbidden-session") {
      send(403, {error: "This account cannot read this title."});
      return;
    }
    if (!authorized) {
      send(401, {error: "Invalid or expired session."});
      return;
    }
    if (req.url.includes("/status")) {
      probes += 1;
      if (mode === "unavailable") {
        send(503, {error: "Broker unavailable."});
      } else if (mode === "missing") {
        send(200, {ok: false, status: 404, failureCode: "missing_page"});
      } else if (mode === "malformed") {
        res.writeHead(200, {"Content-Type": "text/html"});
        res.end("not an authorization response");
      } else if (mode === "timeout") {
        const timer = setTimeout(() => { if (!res.destroyed) { send(200, {ok: true, status: 200}); } }, 1000);
        res.on("close", () => clearTimeout(timer));
      } else {
        send(200, {ok: true, status: 200, cacheable: true});
      }
      return;
    }
    imageRequests += 1;
    res.writeHead(200, {"Content-Type": "image/avif", "Cache-Control": "private, max-age=604800", "ETag": "\"qa-revision\""});
    res.end(PRIVATE_PAGE);
  });
  await new Promise((resolve) => sage.listen(0, "127.0.0.1", resolve));
  const app = express();
  registerMoonV3ProxyRoutes(app, {
    config: {sageBaseUrl: `http://127.0.0.1:${sage.address().port}`, readerPageCacheDir: cacheRoot},
    getSessionToken: (req) => (req.headers.cookie || "").match(/scriptarr_session=([^;]+)/)?.[1] || "",
    logger: {warn() {}}
  });
  const moon = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => moon.once("listening", resolve));
  const url = `http://127.0.0.1:${moon.address().port}/api/moon-v3/user/reader/title/private-title/chapter/private-chapter/page/0?rev=qa-revision`;
  const validHeaders = {Cookie: "scriptarr_session=valid-session"};

  t.after(async () => {
    if (previousTimeout == null) {
      delete process.env.SCRIPTARR_MOON_V3_JSON_PROXY_TIMEOUT_MS;
    } else {
      process.env.SCRIPTARR_MOON_V3_JSON_PROXY_TIMEOUT_MS = previousTimeout;
    }
    moon.closeAllConnections();
    sage.closeAllConnections();
    await Promise.all([new Promise((resolve) => moon.close(resolve)), new Promise((resolve) => sage.close(resolve))]);
    assert.ok(cacheRoot.startsWith(path.join(os.tmpdir(), "scriptarr-reader-cache-auth-")));
    await fs.rm(cacheRoot, {recursive: true, force: true});
  });

  const warm = await fetch(url, {headers: validHeaders});
  assert.equal(warm.status, 200);
  assert.equal(await warm.text(), PRIVATE_PAGE);
  let hit = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    hit = await fetch(url, {headers: validHeaders});
    assert.equal(await hit.text(), PRIVATE_PAGE);
    if (hit.headers.get("x-scriptarr-reader-cache") === "hit") {
      break;
    }
  }
  assert.equal(hit.headers.get("x-scriptarr-reader-cache"), "hit");
  assert.equal(imageRequests, 1);
  assert.ok(probes > 0);

  for (const [name, headers, status] of [
    ["signed out", {}, 401],
    ["invalid session", {Cookie: "scriptarr_session=invalid-session"}, 401],
    ["title access denied", {Cookie: "scriptarr_session=page-forbidden-session"}, 403],
    ["invalid API key", {"X-Scriptarr-Api-Key": "invalid-api-key"}, 401]
  ]) {
    await t.test(name, async () => {
      const response = await fetch(url, {headers});
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await response.text(), /synthetic-private-reader-page/);
    });
  }

  await t.test("revoked sessions cannot reuse a previously authorized cache hit", async () => {
    revoked = true;
    const response = await fetch(url, {headers: validHeaders});
    assert.equal(response.status, 401);
    assert.doesNotMatch(await response.text(), /synthetic-private-reader-page/);
    revoked = false;
  });

  await t.test("authorized API keys can use the byte cache", async () => {
    const response = await fetch(url, {headers: {"X-Scriptarr-Api-Key": "valid-api-key"}});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-scriptarr-reader-cache"), "hit");
    assert.equal(await response.text(), PRIVATE_PAGE);
  });

  for (const [failureMode, expectedStatus] of [["missing", 404], ["unavailable", 503], ["malformed", 503], ["timeout", 503]]) {
    await t.test(`authorization ${failureMode} never serves stale private bytes`, async () => {
      mode = failureMode;
      const response = await fetch(url, {headers: validHeaders});
      assert.equal(response.status, expectedStatus);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await response.text(), /synthetic-private-reader-page/);
      mode = "ready";
    });
  }

  assert.equal(imageRequests, 1, "Only the initial warm request fetches upstream image bytes.");
});
