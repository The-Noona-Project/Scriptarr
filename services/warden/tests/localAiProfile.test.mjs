/**
 * @file Scriptarr Warden module: services/warden/tests/localAiProfile.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("resolve localai profile honors explicit GPU hint", async () => {
  process.env.SCRIPTARR_GPU_HINT = "intel";
  const {resolveLocalAiProfile} = await import(`../config/localAiProfiles.mjs?${Date.now()}`);
  const profile = resolveLocalAiProfile();
  assert.equal(profile.key, "intel");
  assert.equal(profile.image, "localai/localai:latest-gpu-intel");
  delete process.env.SCRIPTARR_GPU_HINT;
});

test("warden runtime snapshot keeps localai manual and off first boot", async () => {
  const {resolveWardenRuntimeSnapshot} = await import(`../config/runtimeConfig.mjs?plan=${Date.now()}`);
  const runtime = resolveWardenRuntimeSnapshot();
  assert.equal(runtime.localAi.installOnFirstBoot, false);
  assert.equal(runtime.localAi.lifecycle, "manual");
});

