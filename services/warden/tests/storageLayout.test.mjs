/**
 * @file Scriptarr Warden module: services/warden/tests/storageLayout.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  buildScriptarrStorageLayout,
  ensureScriptarrStorageFolders,
  resolveEphemeralTestDataRoot,
  resolveHostFilesystemPath,
  resolveScriptarrDataRoot
} from "../filesystem/storageLayout.mjs";

test("resolve scriptarr data root uses the Windows roaming profile by default", () => {
  const dataRoot = resolveScriptarrDataRoot({
    env: {
      APPDATA: "C:\\Users\\nohea\\AppData\\Roaming"
    },
    platform: "win32"
  });

  assert.equal(dataRoot, "C:\\Users\\nohea\\AppData\\Roaming\\scriptarr");
});

test("build scriptarr storage layout keeps per-service folders small and explicit", () => {
  const layout = buildScriptarrStorageLayout("/mnt/user/scriptarr");
  assert.equal(layout.services["scriptarr-mysql"].data.containerPath, "/var/lib/mysql");
  assert.equal(layout.services["scriptarr-raven"].downloads.containerPath, "/downloads");
  assert.equal(layout.services["scriptarr-warden"].runtime.hostPath, path.normalize("/mnt/user/scriptarr/warden/runtime"));
  assert.equal(layout.services["scriptarr-warden"].runtime.containerPath, "/var/lib/scriptarr");
});

test("resolve ephemeral test data root creates an isolated suffix", () => {
  const root = resolveEphemeralTestDataRoot({
    stackId: "demo",
    tmpDir: "/tmp",
    now: 123456
  });
  assert.equal(root, path.normalize("/tmp/scriptarr-test-stack-demo-123456"));
});

test("resolve host filesystem path converts Windows host paths for linux containers", () => {
  const runtimePath = resolveHostFilesystemPath("C:\\scriptarr\\warden", {
    platform: "linux"
  });

  assert.equal(runtimePath, "/run/desktop/mnt/host/c/scriptarr/warden");
});

test("docker socket mounts keep their posix path on windows hosts", () => {
  const runtimePath = resolveHostFilesystemPath("/var/run/docker.sock", {
    platform: "win32"
  });

  assert.equal(runtimePath, "/var/run/docker.sock");
});

test("ensure scriptarr storage folders creates docker-desktop host paths from linux containers", async () => {
  const created = [];
  await ensureScriptarrStorageFolders("C:\\scriptarr", {
    platform: "linux",
    fsModule: {
      mkdir: async (folderPath) => {
        created.push(folderPath);
      }
    }
  });

  assert.ok(created.includes("/run/desktop/mnt/host/c/scriptarr"));
  assert.ok(created.includes("/run/desktop/mnt/host/c/scriptarr/warden/logs"));
  assert.ok(created.includes("/run/desktop/mnt/host/c/scriptarr/warden/runtime"));
});

