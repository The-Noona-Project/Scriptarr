/**
 * @file Verify slow image checks return accepted jobs before any remote probe deadline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {registerRuntimeRoutes} from "../api/registerRuntimeRoutes.mjs";
import {createUpdateRuntime} from "../core/updateRuntime.mjs";
import {createClusterRuntime} from "../core/clusterRuntime.mjs";

test("a remote image check responds with a pollable job while the pull remains blocked", async () => {
  let releasePull;
  const pull = new Promise((resolve) => {releasePull = resolve;});
  const persisted = [], reconciled = [];
  let pulled = false;
  const workerUpdates = createUpdateRuntime({
    env: {SCRIPTARR_WARDEN_HOST_ID: "ai"},
    logger: {info() {}, warn() {}, error() {}},
    managedStack: {refreshStatus: async () => ({}), reconcileSelectedServices: async (...args) => {reconciled.push(args);return []; }},
    resolvePlan: () => ({services: [{name: "scriptarr-oracle", image: "oracle:release", containerName: "scriptarr-oracle"}]}),
    brokerClient: {
      upsertJob: async (_id, job) => {persisted.push(structuredClone(job));return job;},
      upsertJobTask: async (_job, _id, task) => task,
      listJobTasks: async () => []
    },
    dockerOps: {
      inspectDockerContainer: async () => ({Image: "old", State: {Running: true}}),
      inspectDockerImage: async () => ({Id: pulled ? "new" : "old"}),
      pullDockerImage: async () => {await pull;pulled = true;}
    }
  });
  const app = express();
  app.use(express.json());
  registerRuntimeRoutes(app, {checkUpdates: workerUpdates.startCheck, installUpdates: workerUpdates.installUpdates, getUpdates: workerUpdates.getStatus});
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({error: error.message}));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const topology = {primaryHostId: "core", hosts: [
    {id: "core", address: "192.168.50.6", agentUrl: "https://192.168.50.6:4401", services: ["scriptarr-mysql", "scriptarr-vault", "scriptarr-sage", "scriptarr-moon", "scriptarr-raven"]},
    {id: "ai", address: "192.168.50.7", agentUrl: "https://192.168.50.7:4401", services: ["scriptarr-oracle", "scriptarr-portal"]}
  ]};
  const primary = createClusterRuntime({
    env: {SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(topology), SCRIPTARR_WARDEN_HOST_ID: "core"},
    local: {getUpdates: async () => ({services: [], job: null})},
    client: {request: async (_host, path, options = {}) => {
      const response = await fetch(base + path, {
        method: options.method || "GET", headers: {"Content-Type": "application/json"},
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(1000)
      });
      if (path.endsWith("/check")) assert.equal(response.status, 202);
      if (!response.ok) throw Object.assign(new Error(`Worker HTTP ${response.status}`), {status: response.status});
      return response.json();
    }}
  });
  try {
    const accepted = await primary.checkUpdates(["scriptarr-oracle"]);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.job.status, "running");
    assert.equal(accepted.job.payload.action, "check");
    assert.equal(pulled, false);
    assert.equal((await primary.getUpdates()).job.status, "running");
    const rejected = await primary.installUpdates(["scriptarr-oracle"]);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.hosts[0].available, true);
    assert.equal((await primary.getUpdates()).job.payload.action, "check");
    releasePull();
    let finished;
    for (let attempt = 0; attempt < 100; attempt++) {
      finished = await primary.getUpdates();
      if (finished.job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(finished.job.status, "completed");
    assert.equal(finished.services.find((service) => service.name === "scriptarr-oracle").updateAvailable, true);
    assert.ok(persisted.some((job) => job.status === "completed"));
    assert.deepEqual(reconciled, []);
    const install = await primary.installUpdates(["scriptarr-oracle"]);
    assert.equal(install.ok, true);
    for (let attempt = 0; attempt < 100 && !reconciled.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(reconciled, [[["scriptarr-oracle"], {forceRecreate: true}]]);
  } finally {
    releasePull();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
