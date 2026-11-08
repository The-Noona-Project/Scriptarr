/** @file Restricted worker identity, streaming transport, TLS and durable lease boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import https from "node:https";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {createVaultApp} from "../../vault/lib/createVaultApp.mjs";
import {createVaultClient} from "../lib/vaultClient.mjs";
import {createServiceAuth} from "../lib/serviceAuth.mjs";
import {registerRavenIngestBroker} from "../lib/registerRavenIngestBroker.mjs";
import {createWorkerTlsServer} from "../lib/workerTlsServer.mjs";

const serviceTokens = {"scriptarr-sage": "sage-test-only", "scriptarr-raven": "main-test-only", "scriptarr-raven-worker": "worker-test-only", "scriptarr-warden": "warden-test-only"};
const request = {input: {titleId: "title-1", chapterId: "chapter-1", sourceFingerprint: {sha256: "a".repeat(64), size: 4096}, sourcePageCount: 1, archiveName: "chapter.cbz", entries: ["001.png"]}, owner: {privateExecutionReceipt: "coordinator-only"}};
const claim = {workerId: "worker-1", instanceId: "instance-1", claimId: "claim-1", leaseToken: "L".repeat(40), capabilities: {format: "webp", profileVersion: 1, selfTestPassed: true}};
const close = server => new Promise(resolve => {server.closeAllConnections?.(); server.close(resolve);});
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const auth = name => ({Authorization: `Bearer ${serviceTokens[name]}`, "Content-Type": "application/json"});

const fixture = async (t, {secure = true} = {}) => {
  let clock = Date.now();
  const vault = await createVaultApp({config: {driver: "memory", serviceTokens, conversionNow: () => clock}, logger: {info() {}, warn() {}}});
  const vaultServer = http.createServer(vault.app); await listen(vaultServer);
  const transfers = [], input = Buffer.alloc(128 * 1024, 0xa7);
  let aborts = 0, truncate = false;
  const main = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${serviceTokens["scriptarr-raven"]}`, "Only the main Raven credential may reach protected coordinator routes.");
    const url = new URL(req.url, "http://fixture");
    if (url.pathname.includes("scoped-content-reset") || url.pathname.startsWith("/v1/ingest/migration/")) {res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({operationId: "safe-operation", scoped: true})); return;}
    assert.equal(req.headers["x-scriptarr-lease-token"], claim.leaseToken);
    assert.equal(url.searchParams.get("workerId"), claim.workerId);
    transfers.push({path: url.pathname, query: url.search, bytes: 0});
    const transfer = transfers.at(-1);
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/zip");
      if (truncate) {res.setHeader("Content-Length", 1000); res.write("short"); setTimeout(() => res.socket?.destroy(), 10); return;}
      res.setHeader("Content-Length", input.length); res.end(input); return;
    }
    req.on("aborted", () => {aborts += 1;});
    req.on("data", bytes => {transfer.bytes += bytes.length;});
    req.on("end", () => {res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({staged: true, bytes: transfer.bytes}));});
  });
  await listen(main);
  const config = {serviceTokens, serviceToken: serviceTokens["scriptarr-sage"], vaultBaseUrl: `http://127.0.0.1:${vaultServer.address().port}`, ravenBaseUrl: `http://127.0.0.1:${main.address().port}`};
  const app = express(); app.use(express.json({limit: "10mb"}));
  registerRavenIngestBroker(app, {config, vaultClient: createVaultClient(config), requireService: createServiceAuth(config), secureWorkerTransport: () => secure});
  const server = http.createServer(app); await listen(server);
  t.after(async () => {await close(server); await close(main); await close(vaultServer); vault.close();});
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (route, body, principal = "scriptarr-raven", extra = {}) => fetch(base + "/api/internal/raven-ingest" + route,
    {method: "POST", headers: {...auth(principal), ...extra}, body: JSON.stringify(body)});
  return {app, config, base, send, vault, transfers, input, aborts: () => aborts, truncatedInput: () => {truncate = true;}, expireLease: () => {clock += 120001;}, vaultBase: config.vaultBaseUrl};
};

test("worker auth cannot impersonate coordinator, read jobs or storage, and requires encrypted transport", async t => {
  const f = await fixture(t, {secure: false});
  assert.equal((await f.send("/claims", claim, "scriptarr-raven-worker")).status, 426);
  assert.equal((await f.send("/jobs", request, "scriptarr-raven-worker")).status, 403);
  assert.equal((await fetch(f.base + "/api/internal/raven-ingest/jobs", {headers: auth("scriptarr-raven-worker")})).status, 403);
  assert.equal((await fetch(f.base + "/api/internal/raven-ingest/pool", {headers: auth("scriptarr-raven-worker")})).status, 403);
  assert.equal((await fetch(f.vaultBase + "/api/service/raven-ingest/pool", {headers: auth("scriptarr-raven-worker")})).status, 403);
  assert.throws(() => createServiceAuth({serviceTokens: {...serviceTokens, "scriptarr-raven-worker": serviceTokens["scriptarr-raven"]}}), /distinct/);
});

test("claim retries and segment heartbeat use authoritative storage, while workers see only their chapter", async t => {
  const f = await fixture(t), job = await (await f.send("/jobs", request)).json();
  const leased = await (await f.send("/claims", claim, "scriptarr-raven-worker")).json();
  assert.equal(leased.job.jobId, job.jobId); assert.equal(leased.lease.renewAfterSeconds, 20);
  assert.equal(leased.job.spec.owner, undefined); assert.equal(JSON.stringify(leased).includes("privateExecutionReceipt"), false);
  assert.equal(JSON.stringify(leased).includes("leaseToken"), false);
  assert.deepEqual(await (await f.send("/claims", claim, "scriptarr-raven-worker")).json(), leased);
  const heartbeat = await (await f.send(`/jobs/${job.jobId}/heartbeat`, {workerId: claim.workerId, epoch: leased.lease.epoch, completedLogicalPages: 0, completedSegments: 1, totalSegments: 3}, "scriptarr-raven-worker", {"X-Scriptarr-Lease-Token": claim.leaseToken})).json();
  assert.equal(heartbeat.progress.completedSegments, 1); assert.equal(heartbeat.progress.completedLogicalPages, 0);
  assert.equal((await f.send(`/jobs/${job.jobId}/complete`, {}, "scriptarr-raven-worker")).status, 403);
  const pool = await (await fetch(f.base + "/api/internal/raven-ingest/pool", {headers: auth("scriptarr-warden")})).json();
  assert.equal(pool.capacity, 1); assert.equal(pool.activeJobs, 1); assert.equal(pool.workers[0].ready, true);
});

test("input and result bytes stream exactly through Sage, stale epochs and JSON artifacts never reach main Raven", async t => {
  const f = await fixture(t), job = await (await f.send("/jobs", request)).json();
  const leased = await (await f.send("/claims", claim, "scriptarr-raven-worker")).json();
  const suffix = `?workerId=${claim.workerId}&epoch=${leased.lease.epoch}`;
  const headers = {...auth("scriptarr-raven-worker"), "X-Scriptarr-Lease-Token": claim.leaseToken};
  const source = await fetch(`${f.base}/api/internal/raven-ingest/jobs/${job.jobId}/input${suffix}`, {headers});
  assert.equal(source.status, 200); assert.equal(source.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await source.arrayBuffer()), f.input);
  const uploadUrl = `${f.base}/api/internal/raven-ingest/jobs/${job.jobId}/artifact${suffix}&artifactSha256=${"b".repeat(64)}`;
  assert.equal((await fetch(uploadUrl, {method: "POST", headers, body: "{}"})).status, 415);
  const uploaded = await fetch(uploadUrl, {method: "POST", headers: {...headers, "Content-Type": "application/octet-stream"}, body: f.input});
  assert.equal(uploaded.status, 200); assert.deepEqual(await uploaded.json(), {staged: true, bytes: f.input.length});
  const before = f.transfers.length;
  f.expireLease();
  assert.equal((await fetch(`${f.base}/api/internal/raven-ingest/jobs/${job.jobId}/input${suffix}`, {headers})).status, 409);
  assert.equal(f.transfers.length, before, "An expired lease must be rejected before any protected Raven fetch.");
  await f.send(`/jobs/${job.jobId}/cancel`, {expectedEpoch: leased.lease.epoch});
  assert.equal((await fetch(uploadUrl, {method: "POST", headers: {...headers, "Content-Type": "application/octet-stream"}, body: f.input})).status, 409);
  assert.equal(f.transfers.length, before);
});

test("a cancelled binary upload aborts upstream without an accepted artifact", async t => {
  const f = await fixture(t), job = await (await f.send("/jobs", request)).json();
  const leased = await (await f.send("/claims", claim, "scriptarr-raven-worker")).json();
  const url = new URL(`${f.base}/api/internal/raven-ingest/jobs/${job.jobId}/artifact?workerId=${claim.workerId}&epoch=${leased.lease.epoch}`);
  const pending = http.request(url, {method: "POST", headers: {...auth("scriptarr-raven-worker"), "Content-Type": "application/octet-stream", "X-Scriptarr-Lease-Token": claim.leaseToken, "Content-Length": 1000000}});
  pending.on("error", () => {}); pending.write(Buffer.alloc(4096));
  const deadline = Date.now() + 3000;
  while (!f.transfers.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.transfers.length, 1); pending.destroy();
  while (!f.aborts() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.aborts(), 1);
  assert.equal((await f.vault.store.getConversionJob(job.jobId)).status, "running");
});

test("a truncated binary input cannot complete or publish its conversion", async t => {
  const f = await fixture(t), job = await (await f.send("/jobs", request)).json();
  const leased = await (await f.send("/claims", claim, "scriptarr-raven-worker")).json();
  f.truncatedInput();
  await assert.rejects(async () => {
    const response = await fetch(`${f.base}/api/internal/raven-ingest/jobs/${job.jobId}/input?workerId=${claim.workerId}&epoch=${leased.lease.epoch}`, {headers: {...auth("scriptarr-raven-worker"), "X-Scriptarr-Lease-Token": claim.leaseToken}});
    assert.equal(response.status, 200); await response.arrayBuffer();
  });
  assert.equal((await f.vault.store.getConversionJob(job.jobId)).status, "running");
});

test("only Warden can reach exact scoped reset coordinator operations", async t => {
  const f = await fixture(t), url = f.base + "/api/internal/warden/raven/content-reset/preview";
  assert.equal((await fetch(url, {method: "POST", headers: auth("scriptarr-raven-worker"), body: "{}"})).status, 403);
  const response = await fetch(url, {method: "POST", headers: auth("scriptarr-warden"), body: JSON.stringify({operationId: "safe-operation"})});
  assert.equal(response.status, 200); assert.equal((await response.json()).scoped, true);
  for (const action of ["start", "pause", "resume", "retry", "status"]) {
    const migration = f.base + "/api/internal/warden/raven/webp-migration/" + action;
    assert.equal((await fetch(migration, {method: "POST", headers: auth("scriptarr-warden"), body: "{}"})).status, 200);
    assert.equal((await fetch(migration, {method: "POST", headers: auth("scriptarr-raven-worker"), body: "{}"})).status, 403);
  }
  assert.equal((await fetch(f.base + "/api/internal/warden/raven/content-reset/begin", {method: "POST", headers: auth("scriptarr-warden"), body: "{}"})).status, 404);
});

test("dedicated worker HTTPS validates trust and excludes settings/coordinator/reset routes", async t => {
  const f = await fixture(t), dir = mkdtempSync(path.join(tmpdir(), "scriptarr-worker-tls-test-"));
  const openssl = process.platform === "win32" && existsSync("C:/Program Files/Git/usr/bin/openssl.exe") ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl";
  const cert = path.join(dir, "leaf.crt"), key = path.join(dir, "leaf.key");
  execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], {stdio: "ignore", windowsHide: true});
  const tlsConfig = {...f.config, port: 3004, workerTlsPort: 3444, workerTlsCertFile: cert, workerTlsKeyFile: key};
  const server = createWorkerTlsServer({app: f.app, config: tlsConfig}); await listen(server);
  t.after(async () => {
    await close(server);
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith("scriptarr-worker-tls-test-"));
    rmSync(dir, {recursive: true, force: true});
  });
  const get = (pathname, principal = "scriptarr-raven-worker", trusted = true) => new Promise((resolve, reject) => {
    const req = https.get({host: "127.0.0.1", port: server.address().port, path: pathname, headers: auth(principal), ...(trusted ? {ca: readFileSync(cert)} : {})}, res => {res.resume(); res.on("end", () => resolve(res.statusCode));});
    req.on("error", reject);
  });
  assert.equal(await get("/api/internal/raven-ingest/workers/status"), 200);
  assert.equal(await get("/api/internal/raven-ingest/workers/status", "scriptarr-raven"), 403);
  for (const pathname of ["/api/internal/raven-ingest/jobs", "/api/internal/raven-ingest/pool", "/api/internal/raven-ingest/content-reset/apply", "/api/moon-v3/admin/settings"]) assert.equal(await get(pathname), 404);
  await assert.rejects(get("/api/internal/raven-ingest/workers/status", "scriptarr-raven-worker", false), /self.signed|certificate/i);
  assert.throws(() => createWorkerTlsServer({app: f.app, config: {...tlsConfig, workerTlsPort: NaN}}), /distinct port/);
  assert.equal(createWorkerTlsServer({app: f.app, config: {workerTlsPort: 0}}), null);
});
