/**
 * @file Scriptarr Warden module: services/warden/tests/managedStackRuntime.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  actualCapabilitiesForInspect,
  actualDevicesForInspect,
  actualGpuRequestForInspect,
  desiredCapabilitiesForExtraArgs,
  desiredDevicesForExtraArgs,
  desiredGpuRequestForExtraArgs
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

test("managed stack runtime detects Docker GPU request drift", () => {
  const desiredArgs = ["--gpus", "all"];
  const withGpu = {
    HostConfig: {
      DeviceRequests: [{
        Capabilities: [["gpu", "utility", "compute"]]
      }]
    }
  };
  const withoutGpu = {
    HostConfig: {
      DeviceRequests: []
    }
  };

  assert.equal(desiredGpuRequestForExtraArgs(desiredArgs), true);
  assert.equal(actualGpuRequestForInspect(withGpu), true);
  assert.equal(actualGpuRequestForInspect(withoutGpu), false);
});
