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
  assert.equal(layout.services["scriptarr-moon"].readerPageCache.containerPath, "/app/reader-page-cache");
  assert.equal(layout.services["scriptarr-moon"].readerPageCache.hostPath, path.normalize("/mnt/user/scriptarr/moon/reader-page-cache"));
  assert.equal(layout.services["scriptarr-warden"].runtime.hostPath, path.normalize("/mnt/user/scriptarr/warden/runtime"));
  assert.equal(layout.services["scriptarr-warden"].runtime.containerPath, "/var/lib/scriptarr");
});

test("separate media storage retains application, VPN and policy state in the data root", async () => {
  const root = path.normalize("/appdata/scriptarr"), mediaRoot = path.normalize("/array/scriptarr-media");
  const layout = buildScriptarrStorageLayout(root, {mediaRoot});
  assert.equal(layout.mediaRoot, mediaRoot);
  assert.equal(layout.services["scriptarr-raven"].downloads.hostPath, path.join(mediaRoot, "raven", "downloads"));
  assert.equal(layout.services["scriptarr-raven"].vpn.hostPath, path.join(root, "raven", "downloads", "vpn"));
  assert.equal(layout.services["scriptarr-raven"].operations.containerPath, "/downloads/.operations");
  assert.equal(layout.services["scriptarr-raven"].operations.hostPath, path.join(root, "raven", "downloads", ".operations"));
  assert.equal(layout.services["scriptarr-moon"].readerPageCache.hostPath, path.join(mediaRoot, "moon", "reader-page-cache"));
  assert.equal(layout.services["scriptarr-mysql"].data.hostPath, path.join(root, "mysql", "data"));
  assert.equal(layout.services["scriptarr-localai"].models.hostPath, path.join(root, "localai", "models"));
  assert.equal(layout.services["scriptarr-raven-worker"].scratch.hostPath, path.join(root, "raven-worker", "scratch"));
  const created = [];
  await ensureScriptarrStorageFolders(root, {mediaRoot, fsModule: {mkdir: async folder => created.push(folder)}});
  assert.ok(created.includes(path.join(mediaRoot, "raven", "downloads")));
  assert.ok(created.includes(path.join(root, "raven", "downloads", "vpn")));
});

test("media root requires a dedicated absolute directory and same-root configuration keeps legacy mounts", () => {
  for (const mediaRoot of ["relative/media", "/", "C:\\", 42]) assert.throws(() => buildScriptarrStorageLayout("/appdata", {mediaRoot}), /SCRIPTARR_MEDIA_ROOT/);
  const layout = buildScriptarrStorageLayout("/appdata", {mediaRoot: "/appdata"});
  assert.equal(layout.services["scriptarr-raven"].vpn, undefined);
  assert.equal(layout.services["scriptarr-raven"].downloads.hostPath, path.join(path.normalize("/appdata"), "raven", "downloads"));
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

