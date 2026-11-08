/**
 * @file Verify cross-host aggregation, failure isolation and owner-routed control operations.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {createClusterRuntime} from "../core/clusterRuntime.mjs";

const topology = {primaryHostId: "core", hosts: [
  {id: "core", address: "192.168.50.6", agentUrl: "https://192.168.50.6:4401", services: ["scriptarr-mysql", "scriptarr-vault", "scriptarr-sage", "scriptarr-moon", "scriptarr-raven"]},
  {id: "ai", address: "192.168.50.7", agentUrl: "https://192.168.50.7:4401", services: ["scriptarr-oracle", "scriptarr-portal"]}
]};
const env = (hostId = "core") => ({SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(topology), SCRIPTARR_WARDEN_HOST_ID: hostId});
const makeLocal = (calls = []) => ({
  getBootstrap: () => ({services: [{name: "scriptarr-sage", image: "sage:release"}]}),
  getRuntime: async () => ({warden: {dockerSocketAvailable: true}, managedServices: [{name: "scriptarr-sage", running: true}]}),
  getHealth: async () => ({ok: true}),
  getUpdates: async () => ({services: [{name: "scriptarr-sage"}], job: null}),
  checkUpdates: async (services) => { calls.push(["check", services]); return {services: services.map((name) => ({name}))}; },
  installUpdates: async (services) => { calls.push(["install", services]); return {services: services.map((name) => ({name})), job: {jobId: "local", status: "running"}}; },
  tailLogs: async () => ({entries: ["local"]})
});

test("primary aggregates only services actually owned by each worker", async () => {
  const runtime = createClusterRuntime({env: env(), local: makeLocal(), client: {request: async () => ({managedServices: [{name: "scriptarr-oracle", running: true}, {name: "scriptarr-sage", running: false}]})}});
  const state = await runtime.getRuntime();
  assert.equal(state.managedServices.length, 2);
  assert.equal(state.managedServices.find((service) => service.name === "scriptarr-sage").running, true);
  assert.equal(state.managedServices.find((service) => service.name === "scriptarr-oracle").hostId, "ai");
  assert.equal(runtime.getBootstrap().services.length, 7);
});

test("worker outage is visible without failing core health", async () => {
  const runtime = createClusterRuntime({env: env(), local: makeLocal(), client: {request: async () => {throw new Error("connection unavailable");}}});
  const state = await runtime.getRuntime();
  assert.equal(state.degraded, true);
  assert.equal(state.managedServices.find((service) => service.name === "scriptarr-oracle").health, "unavailable");
  const health = await runtime.getHealth();
  assert.equal(health.ok, true);
  assert.equal(health.degraded, true);
});

test("a stalled worker never delays the core Docker health response", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const runtime = createClusterRuntime({env: env(), local: makeLocal(), client: {request: () => pending}});
  const health = await Promise.race([
    runtime.getHealth(),
    new Promise((_, reject) => {const timer = setTimeout(() => reject(new Error("Core health waited for a remote worker.")), 200); timer.unref();})
  ]);
  assert.equal(health.ok, true);
  assert.equal(health.degraded, true);
  release({warden: {dockerSocketAvailable: true}, managedServices: []});
  await runtime.getRuntime();
});

test("updates and logs are routed to the owner without creating remote services locally", async () => {
  const localCalls = [], remoteCalls = [];
  const runtime = createClusterRuntime({env: env(), local: makeLocal(localCalls), client: {request: async (host, path, options) => {
    remoteCalls.push([host.id, path, options]);
    return {services: [{name: "scriptarr-oracle"}], entries: ["remote"]};
  }}});
  await runtime.installUpdates(["scriptarr-oracle"]);
  assert.deepEqual(localCalls, []);
  assert.equal(remoteCalls[0][0], "ai");
  assert.equal(remoteCalls[0][1], "/api/updates/install");
  assert.deepEqual(remoteCalls[0][2].body.services, ["scriptarr-oracle"]);
  assert.equal((await runtime.tailLogs({service: "scriptarr-oracle", lines: 10})).entries[0], "remote");
  await runtime.checkUpdates(["scriptarr-sage"]);
  assert.deepEqual(localCalls, [["check", ["scriptarr-sage"]]]);
});

test("worker rejects a request for another host and never recurses into the primary", async () => {
  const runtime = createClusterRuntime({env: env("ai"), local: makeLocal(), client: {request: () => {throw new Error("must not call remote");}}});
  await assert.rejects(() => runtime.installUpdates(["scriptarr-sage"]), /only accepts updates/);
  assert.equal((await runtime.getHealth()).ok, true);
});

test("the legacy job field surfaces a remote failure instead of a completed local job", async () => {
  const local = {...makeLocal(), getUpdates: async () => ({services: [], job: {jobId: "local-complete", status: "completed"}})};
  const runtime = createClusterRuntime({env: env(), local, client: {request: async () => ({services: [], job: {jobId: "remote-failed", status: "failed"}})}});
  assert.equal((await runtime.getUpdates()).job.jobId, "remote-failed");
});

test("an active job keeps legacy UI polling while historical failures remain available", async () => {
  const local = {...makeLocal(), getUpdates: async () => ({services: [], job: {jobId: "local-running", status: "running"}})};
  const runtime = createClusterRuntime({env: env(), local, client: {request: async () => ({services: [], job: {jobId: "remote-old-failure", status: "failed"}})}});
  const result = await runtime.getUpdates();
  assert.equal(result.job.jobId, "local-running");
  assert.ok(result.jobs.some((job) => job.jobId === "remote-old-failure" && job.status === "failed"));
});

test("remote operation failures are explicit while preserving per-host diagnostics", async () => {
  const runtime = createClusterRuntime({env: env(), local: makeLocal(), client: {request: async () => {throw new Error("offline");}}});
  const result = await runtime.installUpdates(["scriptarr-oracle"]);
  assert.equal(result.ok, false);
  assert.equal(result.hosts[0].available, false);
  assert.match(result.error, /ai is unavailable/);
});

test("both topology hosts reject standalone LocalAI mutations while preserving read diagnostics", async () => {
  const mutations = ["configureLocalAi", "installLocalAi", "startLocalAi", "removeLocalAi"];
  let mutationsCalled = 0;
  const local = {
    ...makeLocal(),
    getLocalAiStatus: () => ({lifecycle: "manual"}),
    refreshLocalAiStatus: async () => ({installed: false}),
    ...Object.fromEntries(mutations.map((name) => [name, async () => {mutationsCalled += 1;}]))
  };
  for (const hostId of ["core", "ai"]) {
    const runtime = createClusterRuntime({env: env(hostId), local, client: {request: async () => ({})}});
    for (const method of mutations) {
      await assert.rejects(() => runtime[method]({}), (error) => error.status === 409 && /Standalone LocalAI/.test(error.message));
    }
    assert.deepEqual(runtime.getLocalAiStatus(), {lifecycle: "manual"});
    assert.deepEqual(await runtime.refreshLocalAiStatus(), {installed: false});
  }
  assert.equal(mutationsCalled, 0);
  const singleHost = createClusterRuntime({env: {}, local, client: {request: async () => ({})}});
  assert.equal(singleHost, local);
  for (const method of mutations) await singleHost[method]({});
  assert.equal(mutationsCalled, mutations.length);
});
