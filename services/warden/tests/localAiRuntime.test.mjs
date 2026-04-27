/**
 * @file Scriptarr Warden module: services/warden/tests/localAiRuntime.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {createLocalAiRuntime} from "../core/localAiRuntime.mjs";

const createLogger = () => ({
  info() {},
  warn() {},
  error() {}
});

const createDockerOps = (overrides = {}) => ({
  ensureDockerNetwork: async () => {},
  imageExists: async () => false,
  pullDockerImage: async () => {},
  removeDockerImage: async () => {},
  removeDockerContainer: async () => {},
  runDetachedContainer: async () => {},
  containerExists: async () => false,
  ...overrides
});

const waitForStatus = async (runtime, predicate, timeoutMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  let status = runtime.getStatus();
  while (Date.now() < deadline) {
    status = runtime.getStatus();
    if (predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for LocalAI status. Last status: ${JSON.stringify(status)}`);
};

test("localai runtime loads the last Sage-synced selection from runtime storage on initialize", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-warden-localai-"));
  await fs.writeFile(path.join(runtimeDir, "localai-config.json"), JSON.stringify({
    profileKey: "intel",
    imageMode: "preset",
    customImage: ""
  }));

  const runtime = createLocalAiRuntime({
    env: {
      SCRIPTARR_DATA_ROOT: runtimeDir
    },
    logger: createLogger(),
    brokerClient: {
      async getSetting() {
        throw new Error("sage unavailable");
      }
    },
    dockerOps: createDockerOps(),
    runtimeDir
  });

  const status = await runtime.initialize();
  assert.equal(status.configuredProfile.key, "intel");
  assert.equal(status.configuredImage, "localai/localai:latest-aio-gpu-intel");
  assert.equal(status.ready, false);
});

test("localai runtime prefers the Sage-backed selection over the cached runtime copy", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-warden-localai-"));
  await fs.writeFile(path.join(runtimeDir, "localai-config.json"), JSON.stringify({
    profileKey: "cpu",
    imageMode: "preset",
    customImage: ""
  }));

  const runtime = createLocalAiRuntime({
    env: {
      SCRIPTARR_DATA_ROOT: runtimeDir
    },
    logger: createLogger(),
    brokerClient: {
      async getSetting(key) {
        assert.equal(key, "oracle.settings");
        return {
          key,
          value: {
            localAiProfileKey: "amd",
            localAiImageMode: "custom",
            localAiCustomImage: "localai/localai:custom-aio"
          }
        };
      }
    },
    dockerOps: createDockerOps(),
    runtimeDir
  });

  const status = await runtime.refreshStatus();
  assert.equal(status.configuredProfile.key, "amd");
  assert.equal(status.configuredImage, "localai/localai:custom-aio");
  assert.equal(status.ready, false);
});

test("localai runtime install pulls the Sage-selected custom image", async () => {
  let pulledImage = "";
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-warden-localai-"));
  const runtime = createLocalAiRuntime({
    env: {
      SCRIPTARR_DATA_ROOT: runtimeDir
    },
    logger: createLogger(),
    brokerClient: {
      async getSetting() {
        return {
          value: {
            localAiProfileKey: "nvidia",
            localAiImageMode: "custom",
            localAiCustomImage: "localai/localai:nightly-aio"
          }
        };
      }
    },
    dockerOps: createDockerOps({
      pullDockerImage: async (image) => {
        pulledImage = image;
      },
      imageExists: async (image) => image === "localai/localai:nightly-aio"
    }),
    runtimeDir
  });

  const initialStatus = await runtime.install({discordUserId: "owner-1", username: "Owner"});
  assert.equal(initialStatus.phase, "installing");
  assert.equal(initialStatus.job.payload.requestedByDiscordId, "owner-1");
  const status = await waitForStatus(runtime, (current) => current.job?.status === "completed");
  assert.equal(pulledImage, "localai/localai:nightly-aio");
  assert.equal(status.installed, true);
  assert.equal(status.ready, false);
  assert.equal(status.job.progressPercent, 100);
});

test("localai runtime start mounts persistent folders, applies hardware flags, and accepts the models fallback probe", async () => {
  /** @type {Record<string, unknown> | null} */
  let descriptor = null;
  /** @type {string[]} */
  const requestedUrls = [];
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-warden-localai-"));
  const runtime = createLocalAiRuntime({
    env: {
      SCRIPTARR_DATA_ROOT: runtimeDir,
      SCRIPTARR_STACK_MODE: "test",
      SCRIPTARR_STACK_ID: "demo"
    },
    logger: createLogger(),
    brokerClient: {
      async getSetting() {
        return {
          value: {
            localAiProfileKey: "amd",
            localAiImageMode: "preset",
            localAiCustomImage: ""
          }
        };
      }
    },
    dockerOps: createDockerOps({
      runDetachedContainer: async (value) => {
        descriptor = value;
      },
      imageExists: async () => true,
      containerExists: async () => true
    }),
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return {
        ok: String(url).endsWith("/v1/models"),
        status: String(url).endsWith("/v1/models") ? 200 : 404
      };
    },
    runtimeDir,
    readinessTimeoutMs: 100,
    readinessIntervalMs: 1
  });

  const initialStatus = await runtime.start();
  assert.equal(initialStatus.phase, "starting");
  const status = await waitForStatus(runtime, (current) => current.job?.status === "completed");
  assert.equal(status.running, true);
  assert.equal(status.ready, true);
  assert.equal(status.message, "LocalAI container started and is ready.");
  assert.ok(descriptor);
  assert.deepEqual(descriptor.env, {
    PROFILE: "gpu-8g",
    MODELS: "/aio/gpu-8g/text-to-text.yaml"
  });
  assert.deepEqual(descriptor.extraArgs, ["--device", "/dev/kfd", "--device", "/dev/dri", "--group-add", "video"]);
  assert.deepEqual(
    descriptor.mounts.map((entry) => entry.containerPath),
    ["/models", "/data"]
  );
  assert.deepEqual(descriptor.labels, {
    "scriptarr.service": "scriptarr-localai",
    "scriptarr.stack-id": "demo",
    "scriptarr.stack-mode": "test"
  });
  assert.equal(requestedUrls.some((url) => url.endsWith("/readyz")), true);
  assert.equal(requestedUrls.some((url) => url.endsWith("/v1/models")), true);
});

test("localai runtime start fails when the container never becomes ready", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-warden-localai-"));
  const runtime = createLocalAiRuntime({
    env: {
      SCRIPTARR_DATA_ROOT: runtimeDir
    },
    logger: createLogger(),
    brokerClient: {
      async getSetting() {
        return null;
      }
    },
    dockerOps: createDockerOps({
      imageExists: async () => true,
      containerExists: async () => true
    }),
    fetchImpl: async () => ({
      ok: false,
      status: 503
    }),
    runtimeDir,
    readinessTimeoutMs: 20,
    readinessIntervalMs: 1
  });

  const initialStatus = await runtime.start();
  assert.equal(initialStatus.phase, "starting");
  const status = await waitForStatus(runtime, (current) => current.job?.status === "failed");
  assert.equal(status.running, true);
  assert.equal(status.ready, false);
  assert.equal(status.message, "LocalAI start failed.");
  assert.match(status.lastError, /Timed out waiting for LocalAI readiness/);
});

test("localai runtime remove deletes the container and selected image", async () => {
  const removed = [];
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-warden-localai-"));
  const runtime = createLocalAiRuntime({
    env: {
      SCRIPTARR_DATA_ROOT: runtimeDir
    },
    logger: createLogger(),
    brokerClient: {
      async getSetting() {
        return {
          value: {
            localAiProfileKey: "cpu",
            localAiImageMode: "preset",
            localAiCustomImage: ""
          }
        };
      }
    },
    dockerOps: createDockerOps({
      imageExists: async (image) => image === "localai/localai:latest-aio-cpu" && !removed.includes(`image:${image}`),
      containerExists: async (containerName) => containerName === "scriptarr-localai" && !removed.includes(`container:${containerName}`),
      removeDockerContainer: async (containerName) => {
        removed.push(`container:${containerName}`);
      },
      removeDockerImage: async (image) => {
        removed.push(`image:${image}`);
      }
    }),
    runtimeDir
  });

  const initialStatus = await runtime.remove({discordUserId: "owner-1"});
  assert.equal(initialStatus.phase, "removing");
  const status = await waitForStatus(runtime, (current) => current.job?.status === "completed");
  assert.deepEqual(removed, [
    "container:scriptarr-localai",
    "image:localai/localai:latest-aio-cpu"
  ]);
  assert.equal(status.installed, false);
  assert.equal(status.running, false);
  assert.equal(status.ready, false);
});
