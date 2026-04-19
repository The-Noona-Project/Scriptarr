import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  buildScriptarrStorageLayout,
  resolveEphemeralTestDataRoot,
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
});

test("resolve ephemeral test data root creates an isolated suffix", () => {
  const root = resolveEphemeralTestDataRoot({
    stackId: "demo",
    tmpDir: "/tmp",
    now: 123456
  });
  assert.equal(root, path.normalize("/tmp/scriptarr-test-stack-demo-123456"));
});
