/** @file HTTP reader variant identity and compact conversion-pool admin projection. */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import {registerMoonV3Routes} from "../lib/registerMoonV3Routes.mjs";

const close = server => new Promise(resolve => {server.closeAllConnections?.(); server.close(resolve);});
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const fixture = async t => {
  const calls = [], poolCalls = [];
  let variantIdentity = true, poolUnavailable = false;
  const main = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture"); calls.push(req.url);
    const segmentIndex = Number(url.searchParams.get("segment") || 0), thumbnail = url.searchParams.get("thumbnail") === "true";
    if (url.pathname.endsWith("/status")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ok: true, status: 200, pageIndex: 0, ...(variantIdentity ? {segmentIndex, thumbnail} : {}), contentTypeFamily: "image", contentLength: 4, cacheable: true, privatePath: "/private/never-expose"}));
    } else {
      res.setHeader("Content-Type", "image/webp"); res.setHeader("ETag", '"fixture"');
      res.setHeader("X-Scriptarr-Segment-Index", segmentIndex); res.setHeader("X-Scriptarr-Thumbnail", String(thumbnail));
      res.end(`variant:${segmentIndex}:${thumbnail}`);
    }
  }); await listen(main);
  const app = express(), pool = {capacity: 1, activeJobs: 1, queuedJobs: 7, resultReadyJobs: 1, publishingJobs: 0, workers: [{workerId: "worker-1", instanceId: "instance-1", ready: true, lastSeenAt: "2026-11-08T00:00:00Z", format: "webp"}]};
  const pass = (req, _res, next) => {req.user = {discordUserId: "owner", username: "Owner", role: "owner"}; return next();};
  registerMoonV3Routes(app, {
    config: {ravenBaseUrl: `http://127.0.0.1:${main.address().port}`}, logger: {warn() {}}, requireUser: pass, requirePermission: () => pass, requireAdminGrant: () => pass,
    vaultClient: {async ravenIngest(method, pathname) {poolCalls.push({method, pathname}); if (poolUnavailable) throw new Error("offline"); return {status: 200, payload: pool};}},
    async serviceJson(base, pathname) {
      if (pathname.startsWith("/v1/ingest")) return {ok: true, status: 200, payload: {summary: {totalTitles: 5, readyTitles: 1}, runs: {active: [{runId: "run-1", status: "running"}], recent: [{runId: "run-2", status: "completed"}]}}};
      const response = await fetch(base + pathname); return {ok: response.ok, status: response.status, payload: await response.json()};
    }
  });
  const server = http.createServer(app); await listen(server);
  t.after(async () => {await close(server); await close(main);});
  return {base: `http://127.0.0.1:${server.address().port}`, calls, poolCalls, pool, noIdentity: () => {variantIdentity = false;}, unavailablePool: () => {poolUnavailable = true;}};
};

test("reader HTTP bytes and probes preserve exact tile/whole-thumbnail identity, including revision", async t => {
  const f = await fixture(t), page = `${f.base}/api/moon-v3/user/reader/title/t/chapter/c/page/0`;
  const response = await fetch(page + "?rev=webp-0123456789abcdef&segment=2&thumbnail=false");
  assert.equal(await response.text(), "variant:2:false");
  assert.equal(response.headers.get("x-scriptarr-segment-index"), "2"); assert.equal(response.headers.get("x-scriptarr-thumbnail"), "false");
  assert.equal(response.headers.get("etag"), '"fixture"');
  const probe = await (await fetch(page + "/status?rev=webp-0123456789abcdef&thumbnail=true")).json();
  assert.equal(probe.segmentIndex, 0); assert.equal(probe.thumbnail, true); assert.equal(Object.hasOwn(probe, "privatePath"), false);
  assert.equal(f.calls[0], "/v1/reader/t/c/page/0?rev=webp-0123456789abcdef&segment=2&thumbnail=false");
  assert.equal(f.calls[1], "/v1/reader/t/c/page/0/status?rev=webp-0123456789abcdef&thumbnail=true");
  f.noIdentity();
  const missing = await (await fetch(page + "/status?segment=2")).json();
  assert.equal(Object.hasOwn(missing, "segmentIndex"), false); assert.equal(Object.hasOwn(missing, "thumbnail"), false, "Sage must not invent a variant identity that could authorize the wrong warm cache entry.");
  const before = f.calls.length;
  for (const query of ["segment=-1", "segment=1&thumbnail=true", "segment=0&segment=1", "thumbnail=TRUE"]) {
    assert.equal((await fetch(page + "?" + query)).status, 400);
    assert.equal((await fetch(page + "/status?" + query)).status, 400);
  }
  assert.equal(f.calls.length, before);
});

test("ingest overview reads compact durable pool statistics without title hydration or mutation", async t => {
  const f = await fixture(t);
  for (const suffix of ["", "/overview"]) {
    const response = await fetch(f.base + "/api/moon-v3/admin/ingest" + suffix);
    assert.equal(response.status, 200);
    const payload = await response.json(); assert.deepEqual(payload.summary.conversionPool, f.pool); assert.equal(payload.summary.totalTitles, 5);
  }
  assert.deepEqual(f.poolCalls, [{method: "GET", pathname: "/pool"}, {method: "GET", pathname: "/pool"}]);
  assert.equal(f.calls.length, 0);
  f.unavailablePool();
  const degraded = await (await fetch(f.base + "/api/moon-v3/admin/ingest/overview")).json();
  assert.equal(degraded.summary.conversionPool.unavailable, true); assert.equal(degraded.summary.totalTitles, 5);
});
