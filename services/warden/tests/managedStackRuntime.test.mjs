/**
 * @file Scriptarr Warden module: services/warden/tests/managedStackRuntime.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  actualCapabilitiesForInspect,
  actualDevicesForInspect,
  actualGpuRequestForInspect,
  actualGpuRequestsForInspect,
  actualRuntimeForInspect,
  desiredCapabilitiesForExtraArgs,
  desiredDevicesForExtraArgs,
  desiredGpuRequestForExtraArgs,
  desiredGpuRequestsForExtraArgs,
  gpuRequestsMatchExtraArgs,
  resourceLimitsMatchExtraArgs,
  publishedPortsMatch,
  ownsManagedContainer,
  createManagedStackRuntime,
  desiredRuntimeForExtraArgs
} from "../core/managedStackRuntime.mjs";

test("managed stack detects Oracle CPU and memory ceiling drift", () => {
  const limits = ["--cpus", "4", "--memory", "8g"];
  assert.equal(resourceLimitsMatchExtraArgs(limits, {HostConfig: {NanoCpus: 4e9, Memory: 8 * 1024 ** 3}}), true);
  assert.equal(resourceLimitsMatchExtraArgs(limits, {HostConfig: {NanoCpus: 8e9, Memory: 8 * 1024 ** 3}}), false);
  assert.equal(resourceLimitsMatchExtraArgs(limits, {HostConfig: {NanoCpus: 4e9, Memory: 16 * 1024 ** 3}}), false);
  assert.equal(resourceLimitsMatchExtraArgs([], {HostConfig: {NanoCpus: 4e9, Memory: 8 * 1024 ** 3}}), false);
  assert.equal(resourceLimitsMatchExtraArgs([], {HostConfig: {NanoCpus: 0, Memory: 0}}), true);
  assert.equal(resourceLimitsMatchExtraArgs(["--cpus", "4"], {HostConfig: {NanoCpus: 4e9, Memory: 8 * 1024 ** 3}}), false);
});

test("wildcard publication addresses do not cause perpetual recreation", () => {
  for (const desired of [undefined, "0.0.0.0", "::"]) {
    for (const actual of ["", "0.0.0.0", "::"]) {
      assert.equal(publishedPortsMatch([{hostIp: desired, hostPort: 3000, containerPort: 3000}], {
        HostConfig: {PortBindings: {"3000/tcp": [{HostIp: actual, HostPort: "3000"}]}}
      }), true);
    }
  }
  assert.equal(publishedPortsMatch([{hostIp: "192.168.50.6", hostPort: 3000, containerPort: 3000}], {
    HostConfig: {PortBindings: {"3000/tcp": [{HostIp: "0.0.0.0", HostPort: "3000"}]}}
  }), false);
});

test("cluster pruning never removes another host's or unassigned containers", () => {
  const topology = {enabled: true, hostId: "core", owners: {"scriptarr-sage": "core", "scriptarr-oracle": "ai"}};
  assert.equal(ownsManagedContainer(topology, {"scriptarr.host-id": "core", "scriptarr.service": "scriptarr-sage"}), true);
  assert.equal(ownsManagedContainer(topology, {"scriptarr.host-id": "ai", "scriptarr.service": "scriptarr-oracle"}), false);
  assert.equal(ownsManagedContainer(topology, {"scriptarr.host-id": "core", "scriptarr.service": "scriptarr-oracle"}), false);
  assert.equal(ownsManagedContainer(topology, {"scriptarr.service": "scriptarr-sage"}), false);
});

test("forced updates and ordinary reconciliation never replace unmanaged or foreign-host containers", async () => {
  const topology = {primaryHostId: "core", hosts: [
    {id: "core", address: "192.168.50.6", agentUrl: "https://192.168.50.6:4401", services: ["scriptarr-mysql", "scriptarr-vault", "scriptarr-sage", "scriptarr-moon", "scriptarr-raven"]},
    {id: "ai", address: "192.168.50.7", agentUrl: "https://192.168.50.7:4401", services: ["scriptarr-oracle", "scriptarr-portal"]}
  ]};
  for (const labels of [{}, {"scriptarr.managed-by": "scriptarr-warden", "scriptarr.host-id": "ai"}]) {
    const mutations = [];
    const runtime = createManagedStackRuntime({
      env: {SCRIPTARR_WARDEN_TOPOLOGY: JSON.stringify(topology), SCRIPTARR_WARDEN_HOST_ID: "core"},
      logger: {info() {}, warn() {}, error() {}},
      resolvePlan: () => ({services: [{name: "scriptarr-sage", containerName: "scriptarr-sage", image: "sage:next", env: {}}], mysql: {mode: "external"}}),
      dockerOps: {
        dockerSocketAvailable: async () => true,
        inspectDockerContainer: async (name) => name === "scriptarr-sage" ? {Config: {Labels: labels}, State: {Running: true}} : null,
        removeDockerContainer: async () => mutations.push("remove"),
        runDetachedContainer: async () => mutations.push("create")
      }
    });
    await assert.rejects(() => runtime.reconcileSelectedServices(["scriptarr-sage"], {forceRecreate: true}), /not Warden-managed|not explicitly owned/);
    const [status] = await runtime.reconcileSelectedServices(["scriptarr-sage"]);
    assert.match(status.conflict, /not Warden-managed|not explicitly owned/);
    assert.deepEqual(mutations, []);
  }
});

test("managed stack runtime normalizes capability and device drift inputs", () => {
  const extraArgs = ["--cap-add", "NET_ADMIN", "--device", "/dev/net/tun"];
  const inspect = {
    HostConfig: {
      CapAdd: ["CAP_NET_ADMIN"],
      Devices: [{
        PathOnHost: "/dev/net/tun",
        PathInContainer: "/dev/net/tun",
        CgroupPermissions: "rwm"
      }]
    }
  };

  assert.deepEqual(desiredCapabilitiesForExtraArgs(extraArgs), ["NET_ADMIN"]);
  assert.deepEqual(actualCapabilitiesForInspect(inspect), ["NET_ADMIN"]);
  assert.deepEqual(desiredDevicesForExtraArgs(extraArgs), ["/dev/net/tun=>/dev/net/tun"]);
  assert.deepEqual(actualDevicesForInspect(inspect), ["/dev/net/tun=>/dev/net/tun"]);
});

test("managed stack runtime detects missing Raven VPN runtime capability inputs", () => {
  const extraArgs = ["--cap-add=NET_ADMIN", "--device=/dev/net/tun"];
  const inspect = {
    HostConfig: {
      CapAdd: [],
      Devices: []
    }
  };

  assert.notDeepEqual(actualCapabilitiesForInspect(inspect), desiredCapabilitiesForExtraArgs(extraArgs));
  assert.notDeepEqual(actualDevicesForInspect(inspect), desiredDevicesForExtraArgs(extraArgs));
});

test("managed stack runtime detects Docker GPU request and runtime drift", () => {
  const desiredArgs = ["--runtime", "nvidia", "--gpus", "all"];
  const withGpu = {
    HostConfig: {
      Runtime: "nvidia",
      DeviceRequests: [{
        Count: -1,
        Capabilities: [["gpu", "utility", "compute"]]
      }]
    }
  };
  const withSingleGpu = {
    HostConfig: {
      Runtime: "nvidia",
      DeviceRequests: [{
        Count: 1,
        Capabilities: [["gpu", "utility", "compute"]]
      }]
    }
  };
  const withoutGpu = {
    HostConfig: {
      Runtime: "runc",
      DeviceRequests: []
    }
  };

  assert.equal(desiredRuntimeForExtraArgs(desiredArgs), "nvidia");
  assert.equal(actualRuntimeForInspect(withGpu), "nvidia");
  assert.equal(actualRuntimeForInspect(withoutGpu), "runc");
  assert.equal(desiredGpuRequestForExtraArgs(desiredArgs), true);
  assert.equal(actualGpuRequestForInspect(withGpu), true);
  assert.equal(actualGpuRequestForInspect(withoutGpu), false);
  assert.deepEqual(desiredGpuRequestsForExtraArgs(desiredArgs), ["all"]);
  assert.deepEqual(actualGpuRequestsForInspect(withGpu), ["all"]);
  assert.deepEqual(actualGpuRequestsForInspect(withSingleGpu), ["1"]);
  assert.equal(gpuRequestsMatchExtraArgs(desiredArgs, withGpu), true);
  assert.equal(gpuRequestsMatchExtraArgs(desiredArgs, withSingleGpu), false);
  assert.equal(gpuRequestsMatchExtraArgs(desiredArgs, withoutGpu), false);
});
