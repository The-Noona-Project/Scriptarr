/**
 * @file Scriptarr Warden module: services/warden/tests/testStackManager.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {buildTestStackEnvironment, createTestStackManager, normalizeTestStackId} from "../core/testStackManager.mjs";

test("normalize test stack id produces a docker-safe identifier", () => {
  assert.equal(normalizeTestStackId("My Local Stack"), "my-local-stack");
  assert.equal(normalizeTestStackId(""), "local");
});

test("build test stack environment uses selfhost mysql and an isolated network by default", () => {
  const result = buildTestStackEnvironment({
    env: {},
    stackId: "demo",
    moonPort: 3400,
    wardenPort: 4200,
    dataRoot: "C:\\scriptarr-test"
  });

  assert.equal(result.stackId, "demo");
  assert.equal(result.env.SCRIPTARR_STACK_MODE, "test");
  assert.equal(result.env.SCRIPTARR_MYSQL_URL, "SELFHOST");
  assert.equal(result.env.SCRIPTARR_NETWORK_NAME, "scriptarr-network-test-demo");
  assert.equal(result.env.SCRIPTARR_WARDEN_BASE_URL, "http://scriptarr-warden:4001");
  assert.equal(result.env.SCRIPTARR_PUBLIC_BASE_URL, "http://127.0.0.1:3400");
  assert.equal(result.env.SCRIPTARR_WARDEN_PORT, "4001");
  assert.equal(result.wardenContainerName, "scriptarr-test-demo-warden");
});

test("containerized test stack manager persists warden container state and tears it down", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-warden-test-manager-"));
  const dataRoot = path.join(tempRoot, "data");
  const stateDirectory = path.join(tempRoot, "state");
  const startedContainers = [];
  const removedContainers = [];
  const removedNetworks = [];
  const waitedUrls = [];

  const manager = createTestStackManager({
    env: {},
    fsModule: fs,
    stateDirectory,
    ensureStorageFolders: async (rootPath) => {
      await fs.mkdir(rootPath, {recursive: true});
    },
    resolvePlan: ({env, containerNamePrefix}) => ({
      managedNetworkName: env.SCRIPTARR_NETWORK_NAME,
      mysql: {mode: "selfhost"},
      services: [{
        name: "scriptarr-moon",
        containerName: `${containerNamePrefix}-moon`,
        image: "scriptarr-moon:test"
      }],
      storageLayout: {
        services: {
          "scriptarr-warden": {
            logs: {
              hostPath: path.join(dataRoot, "warden", "logs"),
              containerPath: "/var/log/scriptarr"
            },
            runtime: {
              hostPath: path.join(dataRoot, "warden", "runtime"),
              containerPath: "/var/lib/scriptarr"
            }
          }
        }
      }
    }),
    resolveImage: () => "scriptarr-warden:test",
    dockerOps: {
      containerExists: async (containerName) => containerName === "scriptarr-test-demo-warden" || containerName === "scriptarr-test-demo-moon",
      inspectDockerContainer: async () => null,
      listContainersByLabel: async () => [],
      removeDockerContainer: async (containerName) => {
        removedContainers.push(containerName);
      },
      removeDockerNetwork: async (networkName) => {
        removedNetworks.push(networkName);
      },
      runDetachedContainer: async (descriptor) => {
        startedContainers.push(descriptor);
      },
      waitForHttp: async (url) => {
        waitedUrls.push(url);
      }
    },
    fetchImpl: async () => ({ok: true})
  });

  const started = await manager.start({
    stackId: "demo",
    dataRoot,
    removeDataRootOnStop: true
  });

  assert.equal(started.version, 2);
  assert.equal(started.warden.containerName, "scriptarr-test-demo-warden");
  assert.equal(started.warden.image, "scriptarr-warden:test");
  assert.equal(startedContainers[0].name, "scriptarr-test-demo-warden");
  assert.equal(startedContainers[0].mounts[2].hostPath, "/var/run/docker.sock");
  assert.deepEqual(waitedUrls, [
    "http://127.0.0.1:4101/health",
    "http://127.0.0.1:3300/health",
    "http://127.0.0.1:3300/api/moon/auth/bootstrap-status"
  ]);
  removedContainers.length = 0;
  removedNetworks.length = 0;

  const saved = JSON.parse(await fs.readFile(started.statePath, "utf8"));
  assert.equal(saved.warden.containerName, "scriptarr-test-demo-warden");
  assert.equal(saved.warden.image, "scriptarr-warden:test");
  assert.equal(saved.services[0].containerName, "scriptarr-test-demo-moon");

  const status = await manager.status({stackId: "demo"});
  assert.equal(status.exists, true);
  assert.equal(status.health.warden, true);
  assert.equal(status.health.wardenContainer, true);
  assert.equal(status.health.moon, true);
  assert.equal(status.services[0].running, true);

  const stopped = await manager.stop({stackId: "demo"});
  assert.equal(stopped.stopped, true);
  assert.deepEqual(removedContainers, [
    "scriptarr-test-demo-moon",
    "scriptarr-test-demo-warden"
  ]);
  assert.deepEqual(removedNetworks, ["scriptarr-network-test-demo"]);
  assert.equal(stopped.removedDataRoot, true);

  const afterStop = await manager.status({stackId: "demo"});
  assert.equal(afterStop.exists, false);

  await fs.rm(tempRoot, {recursive: true, force: true});
});

test("test stack stop cleans orphaned containers when the state file is missing", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-warden-orphan-cleanup-"));
  const removedContainers = [];
  const removedNetworks = [];

  const manager = createTestStackManager({
    env: {},
    fsModule: fs,
    stateDirectory: path.join(tempRoot, "state"),
    resolvePlan: ({env, containerNamePrefix}) => ({
      managedNetworkName: env.SCRIPTARR_NETWORK_NAME,
      mysql: {mode: "selfhost"},
      services: [
        {name: "scriptarr-mysql", containerName: `${containerNamePrefix}-mysql`, image: "scriptarr-mysql:test"},
        {name: "scriptarr-moon", containerName: `${containerNamePrefix}-moon`, image: "scriptarr-moon:test"}
      ],
      storageLayout: {
        services: {
          "scriptarr-warden": {
            logs: {hostPath: path.join(tempRoot, "logs"), containerPath: "/var/log/scriptarr"},
            runtime: {hostPath: path.join(tempRoot, "runtime"), containerPath: "/var/lib/scriptarr"}
          }
        }
      }
    }),
    dockerOps: {
      containerExists: async () => false,
      inspectDockerContainer: async () => null,
      listContainersByLabel: async () => [],
      removeDockerContainer: async (containerName) => {
        removedContainers.push(containerName);
      },
      removeDockerNetwork: async (networkName) => {
        removedNetworks.push(networkName);
      },
      runDetachedContainer: async () => {},
      waitForHttp: async () => {}
    },
    fetchImpl: async () => ({ok: false})
  });

  const result = await manager.stop({
    stackId: "demo",
    tolerateMissing: true
  });

  assert.equal(result.stopped, false);
  assert.equal(result.cleanedOrphans, true);
  assert.deepEqual(removedContainers, [
    "scriptarr-test-demo-mysql",
    "scriptarr-test-demo-moon",
    "scriptarr-test-demo-warden"
  ]);
  assert.deepEqual(removedNetworks, ["scriptarr-network-test-demo"]);

  await fs.rm(tempRoot, {recursive: true, force: true});
});

test("test stack stop removes stack-owned LocalAI before deleting the network", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-warden-localai-stop-"));
  const dataRoot = path.join(tempRoot, "data");
  const stateDirectory = path.join(tempRoot, "state");
  const removedContainers = [];
  const removedNetworks = [];

  const manager = createTestStackManager({
    env: {},
    fsModule: fs,
    stateDirectory,
    ensureStorageFolders: async (rootPath) => {
      await fs.mkdir(rootPath, {recursive: true});
    },
    resolvePlan: ({env, containerNamePrefix}) => ({
      managedNetworkName: env.SCRIPTARR_NETWORK_NAME,
      mysql: {mode: "selfhost"},
      services: [{
        name: "scriptarr-moon",
        containerName: `${containerNamePrefix}-moon`,
        image: "scriptarr-moon:test"
      }],
      storageLayout: {
        services: {
          "scriptarr-warden": {
            logs: {
              hostPath: path.join(dataRoot, "warden", "logs"),
              containerPath: "/var/log/scriptarr"
            },
            runtime: {
              hostPath: path.join(dataRoot, "warden", "runtime"),
              containerPath: "/var/lib/scriptarr"
            }
          }
        }
      }
    }),
    resolveImage: () => "scriptarr-warden:test",
    dockerOps: {
      containerExists: async () => false,
      inspectDockerContainer: async (containerName) => containerName === "scriptarr-localai"
        ? {
          NetworkSettings: {
            Networks: {
              "scriptarr-network-test-demo": {}
            }
          }
        }
        : null,
      listContainersByLabel: async () => [],
      removeDockerContainer: async (containerName) => {
        removedContainers.push(containerName);
      },
      removeDockerNetwork: async (networkName) => {
        removedNetworks.push(networkName);
      },
      runDetachedContainer: async () => {},
      waitForHttp: async () => {}
    },
    fetchImpl: async () => ({ok: true})
  });

  const started = await manager.start({
    stackId: "demo",
    dataRoot
  });

  removedContainers.length = 0;
  removedNetworks.length = 0;

  const stopped = await manager.stop({stackId: "demo"});
  assert.equal(stopped.stopped, true);
  assert.deepEqual(removedContainers, [
    "scriptarr-test-demo-moon",
    "scriptarr-localai",
    "scriptarr-test-demo-warden"
  ]);
  assert.deepEqual(stopped.removedContainers, [
    "scriptarr-test-demo-moon",
    "scriptarr-localai",
    "scriptarr-test-demo-warden"
  ]);
  assert.deepEqual(removedNetworks, ["scriptarr-network-test-demo"]);

  await fs.rm(tempRoot, {recursive: true, force: true});
});

test("orphan cleanup removes a labeled stack-owned LocalAI container", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-warden-localai-orphan-"));
  const removedContainers = [];
  const removedNetworks = [];

  const manager = createTestStackManager({
    env: {},
    fsModule: fs,
    stateDirectory: path.join(tempRoot, "state"),
    resolvePlan: ({env, containerNamePrefix}) => ({
      managedNetworkName: env.SCRIPTARR_NETWORK_NAME,
      mysql: {mode: "selfhost"},
      services: [
        {name: "scriptarr-mysql", containerName: `${containerNamePrefix}-mysql`, image: "scriptarr-mysql:test"},
        {name: "scriptarr-moon", containerName: `${containerNamePrefix}-moon`, image: "scriptarr-moon:test"}
      ],
      storageLayout: {
        services: {
          "scriptarr-warden": {
            logs: {hostPath: path.join(tempRoot, "logs"), containerPath: "/var/log/scriptarr"},
            runtime: {hostPath: path.join(tempRoot, "runtime"), containerPath: "/var/lib/scriptarr"}
          }
        }
      }
    }),
    dockerOps: {
      containerExists: async () => false,
      inspectDockerContainer: async () => null,
      listContainersByLabel: async () => [{
        id: "abc123",
        name: "scriptarr-localai",
        image: "localai/localai:latest-aio-cpu",
        labels: {
          "scriptarr.stack-id": "demo",
          "scriptarr.stack-mode": "test"
        }
      }],
      removeDockerContainer: async (containerName) => {
        removedContainers.push(containerName);
      },
      removeDockerNetwork: async (networkName) => {
        removedNetworks.push(networkName);
      },
      runDetachedContainer: async () => {},
      waitForHttp: async () => {}
    },
    fetchImpl: async () => ({ok: false})
  });

  const result = await manager.stop({
    stackId: "demo",
    tolerateMissing: true
  });

  assert.equal(result.cleanedOrphans, true);
  assert.deepEqual(removedContainers, [
    "scriptarr-localai",
    "scriptarr-test-demo-mysql",
    "scriptarr-test-demo-moon",
    "scriptarr-test-demo-warden"
  ]);
  assert.deepEqual(removedNetworks, ["scriptarr-network-test-demo"]);

  await fs.rm(tempRoot, {recursive: true, force: true});
});

