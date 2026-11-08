import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {createCoverCache, validateCoverFallbackPath} from "../lib/coverCache.mjs";

const fallbackPagePath = "/api/moon-v3/user/reader/title/title-1/chapter/chapter-1/page/0?rev=avif-1234567890abcdef";
/**
 * Build a current first-page authorization response for the synthetic cache fixture.
 * @param {number} status HTTP status.
 * @param {object} payload Probe field overrides.
 * @returns {{status: number, headers: object, body: Buffer}}
 */
const probeResponse = (status = 200, payload = {}) => ({status, headers: {"content-type": "application/json"},
  body: Buffer.from(JSON.stringify({ok: true, status: 200, pageIndex: 0, contentTypeFamily: "image", contentLength: 100, cacheable: true, ...payload}))});

test("cover fallback accepts only the authorized same-title first page revision", () => {
  assert.equal(validateCoverFallbackPath("title-1", fallbackPagePath), fallbackPagePath);
  for (const value of ["https://elsewhere.invalid/page", "//elsewhere.invalid/page", fallbackPagePath.replace("title-1", "other-title"),
    fallbackPagePath.replace("page/0", "page/1"), fallbackPagePath + "&extra=1", fallbackPagePath.replace("chapter-1", "%2e%2e"),
    fallbackPagePath.replace("chapter-1", "bad%2Fchapter"), fallbackPagePath.replace("avif-1234567890abcdef", "unknown")]) {
    assert.throws(() => validateCoverFallbackPath("title-1", value), /Invalid cover fallback/);
  }
});

test("absent or broken remote art uses a real AVIF page and reauthorizes warm cache hits", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-cover-"));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const avif = await sharp({create: {width: 8, height: 12, channels: 3, background: "#249f78"}}).avif().toBuffer();
  let remoteRequests = 0, pageRequests = 0, probeRequests = 0, status = 200, now = 1000;
  const ensure = createCoverCache({cacheDir: directory, now: () => now,
    fetchImpl: async () => {remoteRequests++; return new Response("unavailable", {status: 404});}});
  const source = {titleId: "title-1", coverRevision: "revision-1", fallbackPagePath,
    authorizeFallback: async (value) => {assert.equal(value, fallbackPagePath); probeRequests++; return probeResponse(status);},
    fetchFallback: async (value) => {assert.equal(value, fallbackPagePath); pageRequests++; return {status, headers: {"content-type": "image/avif"}, body: avif};}};
  const blank = await ensure(source);
  assert.equal(blank.sourceKind, "reader");
  assert.equal((await sharp(blank.buffer).metadata()).format, "webp");
  const broken = await ensure({...source, coverUrl: "https://covers.invalid/missing.jpg"});
  assert.equal(broken.sourceKind, "reader");
  const warm = await ensure({...source, coverUrl: "https://covers.invalid/missing.jpg"});
  assert.equal(warm.status, "cached");
  assert.equal(remoteRequests, 1);
  assert.equal(pageRequests, 2, "warm cache hits must not download a discarded AVIF body");
  assert.equal(probeRequests, 1);
  for (const denied of [401, 403, 503]) {
    status = denied;
    await assert.rejects(ensure({...source, coverUrl: "https://covers.invalid/missing.jpg"}), error => error.status === denied);
  }
  status = 200; now += 60_001;
  await ensure({...source, coverUrl: "https://covers.invalid/missing.jpg"});
  assert.equal(remoteRequests, 2, "failed metadata art is retried after the short negative cache expires");
  assert.equal(pageRequests, 2);
});

test("warm cover probes reject false-success envelopes, unavailable pages and incomplete metadata", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-cover-probe-"));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const png = await sharp({create: {width: 1, height: 1, channels: 3, background: "#aabbcc"}}).png().toBuffer();
  let pageRequests = 0;
  const ensure = createCoverCache({cacheDir: directory});
  const source = {titleId: "title-1", fallbackPagePath,
    fetchFallback: async () => {pageRequests++; return {status: 200, headers: {"content-type": "image/png"}, body: png};}};
  await ensure(source);
  assert.equal((await ensure({...source, authorizeFallback: async () => probeResponse()})).status, "cached");
  for (const [response, status] of [
    ...[401, 403, 404, 500, 502, 503, 504].map(status => [probeResponse(status), status]),
    [probeResponse(200, {ok: false, status: 404}), 404], [probeResponse(200, {ok: false, status: 503}), 503],
    ...[{ok: false}, {pageIndex: 1}, {status: "200"}, {contentLength: 0}, {contentLength: "100"},
      {contentLength: 8 * 1024 * 1024 + 1}, {contentTypeFamily: "binary"}, {cacheable: false}].map(payload => [probeResponse(200, payload), 503]),
    [{status: 200, headers: {"content-type": "application/json"}, body: Buffer.from("not json")}, 503],
    [{status: 200, headers: {"content-type": "text/html"}, body: probeResponse().body}, 503]
  ]) await assert.rejects(ensure({...source, authorizeFallback: async () => response}), error => error.status === status);
  await assert.rejects(ensure(source), error => error.status === 503);
  await assert.rejects(ensure({...source, authorizeFallback: async () => {throw new DOMException("Timed out", "TimeoutError");}}), error => error.status === 503);
  assert.equal(pageRequests, 1, "all warm validation uses metadata probes only, including failures");
});

test("HTTP success with unsupported or undecodable external bytes also falls back", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-cover-"));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const png = await sharp({create: {width: 1, height: 1, channels: 3, background: "#8899aa"}}).png().toBuffer();
  for (const [name, contentType, bytes] of [["html", "text/html", "<html>bad</html>"], ["decode", "image/png", "corrupt"], ["svg", "image/svg+xml", "<svg/>"], ["timeout", "", ""]]) {
    const ensure = createCoverCache({cacheDir: directory, fetchImpl: async () => {
      if (name === "timeout") throw new DOMException("Timed out", "TimeoutError");
      return new Response(bytes, {headers: {"content-type": contentType}});
    }});
    const result = await ensure({titleId: "title-1", coverRevision: name, coverUrl: "https://covers.invalid/" + name, fallbackPagePath,
      fetchFallback: async () => ({status: 200, headers: {"content-type": "image/png"}, body: png})});
    assert.equal(result.sourceKind, "reader");
  }
});

test("working external artwork stays preferred and missing fallback never creates placeholder art", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-cover-"));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const png = await sharp({create: {width: 1, height: 1, channels: 3, background: "#bbaa99"}}).png().toBuffer();
  let requests = 0, fallbackRequests = 0;
  const ensure = createCoverCache({cacheDir: directory, fetchImpl: async () => {requests++; return new Response(png, {headers: {"content-type": "image/png"}});}});
  const source = {titleId: "title-1", coverUrl: "https://covers.invalid/valid.png", fallbackPagePath,
    fetchFallback: async () => {fallbackRequests++; throw new Error("unexpected fallback");}};
  assert.equal((await ensure(source)).sourceKind, "remote");
  assert.equal((await ensure(source)).status, "cached");
  assert.equal(requests, 1); assert.equal(fallbackRequests, 0);
  await assert.rejects(ensure({titleId: "empty-title"}), /No usable cover/);
  await assert.rejects(ensure({titleId: "title-1", fallbackPagePath,
    fetchFallback: async () => ({status: 200, headers: {"content-type": "image/svg+xml"}, body: Buffer.from("<svg/>")})}), /supported bounded raster/);
});
