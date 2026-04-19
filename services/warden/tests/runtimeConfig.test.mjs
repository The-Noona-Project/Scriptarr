/**
 * @file Scriptarr Warden module: services/warden/tests/runtimeConfig.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {resolveWardenRuntimeSnapshot} from "../config/runtimeConfig.mjs";

test("warden runtime snapshot carries self runtime status and managed service health", () => {
  const runtime = resolveWardenRuntimeSnapshot({
    env: {
      SCRIPTARR_NETWORK_NAME: "scriptarr-network-test-demo",
      SCRIPTARR_STACK_MODE: "test",
      SCRIPTARR_WARDEN_CONTAINER_NAME: "scriptarr-test-demo-warden",
      SCRIPTARR_MYSQL_URL: "SELFHOST",
      SCRIPTARR_MYSQL_USER: "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: "secret"
    },
    runtimeStatus: {
      warden: {
        containerName: "scriptarr-test-demo-warden",
        dockerSocketAvailable: true,
        attachedToManagedNetwork: true,
        lastReconciledAt: "2026-04-18T00:00:00.000Z",
        lastError: null
      },
      managedServices: [{
        name: "scriptarr-moon",
        containerName: "scriptarr-test-demo-moon",
        status: "running",
        health: "healthy",
        running: true
      }]
    }
  });

  assert.equal(runtime.stackMode, "test");
  assert.equal(runtime.managedNetworkName, "scriptarr-network-test-demo");
  assert.equal(runtime.warden.containerName, "scriptarr-test-demo-warden");
  assert.equal(runtime.warden.dockerSocketAvailable, true);
  assert.equal(runtime.warden.attachedToManagedNetwork, true);
  assert.equal(runtime.managedServices[0].containerName, "scriptarr-test-demo-moon");
  assert.equal(runtime.managedServices[0].health, "healthy");
});
