/**
 * @file Scriptarr Warden module: services/warden/tests/dockerHealthcheck.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {resolveDockerHealthcheckOptions, waitForHealthyStack} from "../../../scripts/docker-healthcheck-lib.mjs";

test("docker healthcheck options default to a rebuild-first smoke run", () => {
  const options = resolveDockerHealthcheckOptions({}, {
    SCRIPTARR_IMAGE_NAMESPACE: "example/scriptarr",
    SCRIPTARR_IMAGE_TAG: "dev"
  });

  assert.equal(options.stackId, "healthcheck");
  assert.equal(options.skipBuild, false);
  assert.equal(options.keepRunning, false);
  assert.equal(options.timeoutMinutes, 12);
});

test("docker healthcheck options honor skip-build, keep-running, and timeout overrides", () => {
  const options = resolveDockerHealthcheckOptions({
    "stack-id": "agents",
    "skip-build": true,
    "keep-running": true,
    "timeout-minutes": "25"
  });

  assert.equal(options.stackId, "agents");
  assert.equal(options.skipBuild, true);
  assert.equal(options.keepRunning, true);
  assert.equal(options.timeoutMinutes, 25);
});

test("docker healthcheck waits for all managed services to become healthy", async () => {
  const calls = [];
  const statusManager = {
    async status() {
      calls.push(Date.now());
      return calls.length === 1
        ? {
          exists: true,
          health: {warden: true, moon: true},
          services: [{containerName: "scriptarr-vault", running: true, health: "starting"}]
        }
        : {
          exists: true,
          health: {warden: true, moon: true},
          services: [{containerName: "scriptarr-vault", running: true, health: "healthy"}]
        };
    }
  };

  const result = await waitForHealthyStack({
    statusManager,
    stackId: "agents",
    timeoutMinutes: 1
  });

  assert.equal(result.services[0].health, "healthy");
  assert.ok(calls.length >= 2);
});
