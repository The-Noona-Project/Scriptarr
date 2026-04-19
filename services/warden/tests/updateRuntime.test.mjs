/**
 * @file Scriptarr Warden module: services/warden/tests/updateRuntime.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {createUpdateRuntime} from "../core/updateRuntime.mjs";

test("update runtime marks a service as update-available after pulling a newer local image", async () => {
  const images = new Map([
    ["scriptarr-moon:latest", {Id: "sha256:new-image"}]
  ]);
  const containers = new Map([
    ["scriptarr-moon", {Image: "sha256:old-image", State: {Running: true, Health: {Status: "healthy"}}}]
  ]);

  const runtime = createUpdateRuntime({
    env: {},
    logger: {info() {}, warn() {}, error() {}},
    managedStack: {
      async refreshStatus() {
        return {};
      },
      async reconcileSelectedServices() {
        return [];
      }
    },
    resolvePlan: () => ({
      services: [{
        name: "scriptarr-moon",
        image: "scriptarr-moon:latest",
        containerName: "scriptarr-moon"
      }]
    }),
    dockerOps: {
      inspectDockerContainer: async (containerName) => containers.get(containerName) || null,
      inspectDockerImage: async (image) => images.get(image) || null,
      pullDockerImage: async () => {}
    },
    brokerClient: {
      async listJobs() { return []; },
      async getJob() { return null; },
      async upsertJob(_jobId, payload) { return payload; },
      async listJobTasks() { return []; },
      async upsertJobTask(_jobId, _taskId, payload) { return payload; }
    }
  });

  const checked = await runtime.checkForUpdates(["scriptarr-moon"]);
  assert.equal(checked.services[0].updateAvailable, true);
  assert.equal(checked.services[0].runningImageLabel, "old-image");
  assert.equal(checked.services[0].localImageLabel, "new-image");
});

test("update runtime starts an async install job and reconciles only changed services", async () => {
  const reconciled = [];
  const runtime = createUpdateRuntime({
    env: {},
    logger: {info() {}, warn() {}, error() {}},
    managedStack: {
      async refreshStatus() {
        return {};
      },
      async reconcileSelectedServices(serviceNames) {
        reconciled.push(serviceNames);
        return [];
      }
    },
    resolvePlan: () => ({
      services: [{
        name: "scriptarr-moon",
        image: "scriptarr-moon:latest",
        containerName: "scriptarr-moon"
      }]
    }),
    dockerOps: {
      inspectDockerContainer: async () => ({Image: "sha256:old-image", State: {Running: true, Health: {Status: "healthy"}}}),
      inspectDockerImage: async () => ({Id: "sha256:new-image"}),
      pullDockerImage: async () => {}
    },
    brokerClient: {
      async listJobs() { return []; },
      async getJob() { return null; },
      async upsertJob(_jobId, payload) { return payload; },
      async listJobTasks(jobId) {
        return [{
          taskId: `${jobId}_pull-images`,
          jobId,
          taskKey: "pull-images",
          label: "Pull candidate images",
          status: "completed"
        }];
      },
      async upsertJobTask(_jobId, _taskId, payload) { return payload; }
    }
  });

  const started = await runtime.installUpdates(["scriptarr-moon"]);
  assert.equal(started.job.status, "running");

  await new Promise((resolve) => setTimeout(resolve, 25));
  const status = await runtime.getStatus();
  assert.equal(status.job.status, "completed");
  assert.deepEqual(reconciled, [["scriptarr-moon"]]);
});

test("update runtime hydrates the latest persisted broker job when memory is empty", async () => {
  const runtime = createUpdateRuntime({
    env: {},
    logger: {info() {}, warn() {}, error() {}},
    managedStack: {
      async refreshStatus() {
        return {};
      },
      async reconcileSelectedServices() {
        return [];
      }
    },
    resolvePlan: () => ({
      services: [{
        name: "scriptarr-moon",
        image: "scriptarr-moon:latest",
        containerName: "scriptarr-moon"
      }]
    }),
    dockerOps: {
      inspectDockerContainer: async () => ({Image: "sha256:same-image", State: {Running: true, Health: {Status: "healthy"}}}),
      inspectDockerImage: async () => ({Id: "sha256:same-image"}),
      pullDockerImage: async () => {}
    },
    brokerClient: {
      async listJobs() {
        return [{
          jobId: "update_saved",
          kind: "service-update",
          ownerService: "scriptarr-warden",
          status: "completed",
          label: "Managed service update"
        }];
      },
      async getJob() { return null; },
      async upsertJob(_jobId, payload) { return payload; },
      async listJobTasks(jobId) {
        return [{
          taskId: `${jobId}_pull-images`,
          jobId,
          taskKey: "pull-images",
          label: "Pull candidate images",
          status: "completed"
        }];
      },
      async upsertJobTask(_jobId, _taskId, payload) { return payload; }
    }
  });

  const status = await runtime.getStatus();
  assert.equal(status.job.jobId, "update_saved");
  assert.equal(status.job.tasks[0].taskKey, "pull-images");
});
