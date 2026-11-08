import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {createCoverCache, validateCoverFallbackPath} from "../lib/coverCache.mjs";

const fallbackPagePath = "/api/moon-v3/user/reader/title/title-1/chapter/chapter-1/page/0?rev=avif-1234567890abcdef";

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
  let remoteRequests = 0, pageRequests = 0, status = 200, now = 1000;
  const ensure = createCoverCache({cacheDir: directory, now: () => now,
    fetchImpl: async () => {remoteRequests++; return new Response("unavailable", {status: 404});}});
  const source = {titleId: "title-1", coverRevision: "revision-1", fallbackPagePath,
    fetchFallback: async (value) => {assert.equal(value, fallbackPagePath); pageRequests++; return {status, headers: {"content-type": "image/avif"}, body: avif};}};
  const blank = await ensure(source);
  assert.equal(blank.sourceKind, "reader");
  assert.equal((await sharp(blank.buffer).metadata()).format, "webp");
  const broken = await ensure({...source, coverUrl: "https://covers.invalid/missing.jpg"});
  assert.equal(broken.sourceKind, "reader");
  const warm = await ensure({...source, coverUrl: "https://covers.invalid/missing.jpg"});
  assert.equal(warm.status, "cached");
  assert.equal(remoteRequests, 1);
  assert.equal(pageRequests, 3);
  for (const denied of [401, 403, 503]) {
    status = denied;
    await assert.rejects(ensure({...source, coverUrl: "https://covers.invalid/missing.jpg"}), error => error.status === denied);
  }
  status = 200; now += 60_001;
  await ensure({...source, coverUrl: "https://covers.invalid/missing.jpg"});
  assert.equal(remoteRequests, 2, "failed metadata art is retried after the short negative cache expires");
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
