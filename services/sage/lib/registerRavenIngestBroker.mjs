/** @file Narrow authenticated conversion control and binary worker transport. */
import {sageFetch as fetch} from "./httpTransport.mjs";
import {Readable, Transform} from "node:stream";
import {pipeline} from "node:stream/promises";

const PREFIX = "/api/internal/raven-ingest";
const COORDINATOR = ["scriptarr-raven"];
const WORKER = ["scriptarr-raven-worker"];
const MAX_BYTES = 20 * 1024 ** 3;
const MAX_STREAM_MS = 15 * 60 * 1000;
const fail = (status, code, message) => Object.assign(new Error(message), {status, code});
const workerView = job => job ? {jobId: job.jobId, status: job.status, spec: {input: job.spec.input, profile: job.spec.profile}, lease: job.lease, progress: job.progress, result: job.result?.artifact ? {artifact: job.result.artifact} : {}} : null;
const epochValue = value => typeof value === "number" ? value : /^[1-9]\d*$/.test(String(value || "")) ? Number(value) : -1;
const proof = req => ({workerId: req.query.workerId || req.body?.workerId, epoch: epochValue(req.query.epoch ?? req.body?.epoch), leaseToken: req.headers["x-scriptarr-lease-token"], artifactSha256: req.query.artifactSha256 || req.headers["x-scriptarr-artifact-sha256"]});
const limiter = () => {
  let bytes = 0;
  return new Transform({transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > MAX_BYTES ? fail(413, "CONVERSION_TOO_LARGE", "Conversion stream exceeds its limit.") : null, bytes > MAX_BYTES ? undefined : chunk);
  }});
};

/**
 * Register conversion routes; workers receive only their leased chapter and binary streams.
 * @param {import("express").Express} app Sage application.
 * @param {{config: object, vaultClient: object, requireService: Function, fetchImpl?: typeof fetch, secureWorkerTransport?: Function}} options Broker dependencies.
 * @returns {void} Registers routes in place.
 */
export const registerRavenIngestBroker = (app, {config, vaultClient, requireService, fetchImpl = fetch, secureWorkerTransport = req => Boolean(req.socket.encrypted)}) => {
  const call = (method, path, body) => vaultClient.ravenIngest(method, path, body);
  const route = (method, path, services, action) => app[method](PREFIX + path, requireService(services), async (req, res) => {
    try {
      if (req.serviceName === "scriptarr-raven-worker" && !secureWorkerTransport(req)) throw fail(426, "CONVERSION_HTTPS_REQUIRED", "Workers must use the verified HTTPS broker.");
      await action(req, res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = Number(error.status) || 502;
      res.status(status).json({error: status >= 500 ? "Conversion broker is unavailable." : error.payload?.error || error.message, code: error.payload?.code || error.code || "CONVERSION_BROKER_ERROR"});
    }
  });
  const send = async (res, pending, map = value => value) => {
    const response = await pending;
    if (response.status === 204) { res.status(204).end(); return; }
    res.status(response.status).json(map(response.payload));
  };
  const jobPath = req => `/jobs/${encodeURIComponent(req.params.jobId)}`;
  route("get", "/pool", [...COORDINATOR, "scriptarr-warden"], (_req, res) => send(res, call("GET", "/pool")));
  route("get", "/workers/status", WORKER, (_req, res) => res.json({ok: true, protocolVersion: 1, format: "webp"}));
  route("post", "/workers/heartbeat", WORKER, (req, res) => send(res, call("POST", "/workers/heartbeat", req.body)));
  route("post", "/jobs", COORDINATOR, (req, res) => send(res, call("POST", "/jobs", req.body)));
  route("get", "/jobs", COORDINATOR, (req, res) => send(res, call("GET", `/jobs?${new URLSearchParams(req.query)}`)));
  route("get", "/jobs/:jobId", COORDINATOR, (req, res) => send(res, call("GET", jobPath(req))));
  route("post", "/claims", WORKER, (req, res) => send(res, call("POST", "/claims", req.body), value => ({job: workerView(value.job), lease: value.lease})));
  route("post", "/jobs/:jobId/lease", COORDINATOR, (req, res) => send(res, call("POST", `${jobPath(req)}/lease`, {...req.body, leaseToken: req.headers["x-scriptarr-lease-token"]})));
  route("post", "/jobs/:jobId/heartbeat", [...COORDINATOR, ...WORKER], (req, res) => send(res, call("POST", `${jobPath(req)}/heartbeat`, {...req.body, leaseToken: req.headers["x-scriptarr-lease-token"], coordinator: req.serviceName === "scriptarr-raven"}), value => req.serviceName === "scriptarr-raven-worker" ? workerView(value) : value));
  route("post", "/jobs/:jobId/fail", WORKER, (req, res) => send(res, call("POST", `${jobPath(req)}/fail`, {...req.body, leaseToken: req.headers["x-scriptarr-lease-token"]}), workerView));
  for (const suffix of ["submit", "publish", "complete", "cancel", "retry"]) route("post", `/jobs/:jobId/${suffix}`, COORDINATOR,
    (req, res) => send(res, call("POST", `${jobPath(req)}/${suffix}`, {...req.body, ...(suffix === "submit" ? {leaseToken: req.headers["x-scriptarr-lease-token"]} : {})})));
  for (const suffix of ["preview", "begin", "apply", "finish"]) route("post", `/content-reset/${suffix}`, COORDINATOR, (req, res) => send(res, call("POST", `/content-reset/${suffix}`, req.body)));

  const operations = [["content-reset", "preview", "system/scoped-content-reset"], ["content-reset", "apply", "system/scoped-content-reset"],
    ...["start", "pause", "resume", "retry", "status"].map(suffix => ["webp-migration", suffix, "ingest/migration"])];
  for (const [operation, suffix, upstreamPath] of operations) app.post(`/api/internal/warden/raven/${operation}/${suffix}`, requireService(["scriptarr-warden"]), async (req, res) => {
    try {
      const token = config.serviceTokens?.["scriptarr-raven"];
      if (!token) throw fail(503, "CONVERSION_COORDINATOR_UNCONFIGURED", "The conversion coordinator credential is unavailable.");
      const upstream = await fetchImpl(`${config.ravenBaseUrl}/v1/${upstreamPath}/${suffix}`, {
        method: "POST", headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
        body: JSON.stringify(req.body), signal: AbortSignal.timeout(MAX_STREAM_MS), redirect: "error"
      });
      const chunks = []; let bytes = 0;
      for await (const chunk of upstream.body || []) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) throw fail(502, "CONTENT_RESET_RESPONSE_TOO_LARGE", "The scoped reset response exceeds its limit.");
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let payload;
      try { payload = JSON.parse(raw); } catch { throw fail(502, "CONTENT_RESET_INVALID_RESPONSE", "The scoped reset coordinator returned an invalid response."); }
      res.status(upstream.status).json(payload);
    } catch (error) { res.status(Number(error.status) || 502).json({error: Number(error.status) < 500 ? error.message : "The scoped reset coordinator is unavailable.", code: error.code || "CONTENT_RESET_BROKER_ERROR"}); }
  });

  const stream = async (req, res, upload) => {
    if (upload && !["application/octet-stream", "application/zip"].includes(String(req.headers["content-type"] || "").split(";")[0].toLowerCase())) throw fail(415, "CONVERSION_BINARY_REQUIRED", "Upload a binary artifact, not JSON or base64.");
    const length = req.headers["content-length"];
    if (upload && length != null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw fail(413, "CONVERSION_TOO_LARGE", "Conversion stream exceeds its limit.");
    const lease = proof(req);
    await call("POST", `${jobPath(req)}/lease`, {...lease, artifactReplay: upload});
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_STREAM_MS);
    let finished = false;
    const abort = () => { if (!finished) controller.abort(); };
    req.on("aborted", abort); res.on("close", abort);
    const limited = limiter();
    limited.on("error", abort);
    let upstream, succeeded = false;
    try {
      const query = new URLSearchParams({workerId: String(lease.workerId || ""), epoch: String(lease.epoch)});
      const coordinatorToken = config.serviceTokens?.["scriptarr-raven"];
      if (!coordinatorToken) throw fail(503, "CONVERSION_COORDINATOR_UNCONFIGURED", "The conversion coordinator credential is unavailable.");
      const headers = {Authorization: `Bearer ${coordinatorToken}`, "X-Scriptarr-Lease-Token": lease.leaseToken};
      if (lease.artifactSha256) headers["X-Scriptarr-Artifact-Sha256"] = String(lease.artifactSha256);
      if (upload) { headers["Content-Type"] = "application/octet-stream"; if (length) headers["Content-Length"] = length; }
      upstream = await fetchImpl(`${config.ravenBaseUrl}/v1/ingest/work/jobs/${encodeURIComponent(req.params.jobId)}/${upload ? "artifact" : "input"}?${query}`, {
        method: upload ? "POST" : "GET", headers, signal: controller.signal, redirect: "error",
        ...(upload ? {body: req.pipe(limited), duplex: "half"} : {})
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw fail(upstream.status, "CONVERSION_COORDINATOR_REJECTED", "The coordinator rejected this conversion transfer.");
      }
      const upstreamLength = upstream.headers.get("content-length");
      if (upstreamLength && Number(upstreamLength) > MAX_BYTES) { await upstream.body?.cancel(); throw fail(413, "CONVERSION_TOO_LARGE", "Conversion stream exceeds its limit."); }
      res.status(upstream.status);
      for (const name of ["content-type", "content-length", "etag", "x-scriptarr-artifact-sha256"]) {
        const value = upstream.headers.get(name); if (value) res.setHeader(name, value);
      }
      res.setHeader("Cache-Control", "no-store");
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), ...(upload ? [] : [limited]), res);
      else res.end();
      succeeded = true;
    } finally {
      if (!succeeded) controller.abort();
      finished = true; clearTimeout(timeout); req.off("aborted", abort); res.off("close", abort);
      req.unpipe(limited);
      if (!succeeded && upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {});
      if (!limited.destroyed) limited.destroy();
    }
  };
  route("get", "/jobs/:jobId/input", WORKER, (req, res) => stream(req, res, false));
  route("post", "/jobs/:jobId/artifact", WORKER, (req, res) => stream(req, res, true));
};
