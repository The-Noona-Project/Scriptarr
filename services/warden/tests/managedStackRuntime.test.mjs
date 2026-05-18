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
  desiredRuntimeForExtraArgs
} from "../core/managedStackRuntime.mjs";

test("managed stack runtime normalizes capability and device drift inputs", () => {
  const extraArgs = ["--cap-add", "NET_ADMIN", "--device", "/dev/net/tun"];
  const inspect = {
    HostConfig: {
      CapAdd: ["NET_ADMIN"],
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
