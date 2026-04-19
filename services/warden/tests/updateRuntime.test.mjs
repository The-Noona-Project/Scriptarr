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
    }
  });

  const started = await runtime.installUpdates(["scriptarr-moon"]);
  assert.equal(started.job.status, "running");

  await new Promise((resolve) => setTimeout(resolve, 25));
  const status = await runtime.getStatus();
  assert.equal(status.job.status, "completed");
  assert.deepEqual(reconciled, [["scriptarr-moon"]]);
});
