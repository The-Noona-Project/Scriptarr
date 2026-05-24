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
  assert.equal(profile.image, "localai/localai:latest-aio-gpu-intel");
  assert.deepEqual(profile.runtimeArgs, ["--device", "/dev/dri", "--group-add", "video"]);
  delete process.env.SCRIPTARR_GPU_HINT;
});

test("resolve localai profile uses explicit NVIDIA runtime and gpu all binding", async () => {
  process.env.SCRIPTARR_GPU_HINT = "nvidia";
  const {resolveLocalAiProfile} = await import(`../config/localAiProfiles.mjs?${Date.now()}`);
  const profile = resolveLocalAiProfile();
  assert.equal(profile.key, "nvidia");
  assert.deepEqual(profile.runtimeArgs, ["--runtime", "nvidia", "--gpus", "all"]);
  delete process.env.SCRIPTARR_GPU_HINT;
});

test("resolve localai profile detects NVIDIA through Docker runtime metadata", async () => {
  process.env.SCRIPTARR_DOCKER_INFO_RUNTIMES_JSON = JSON.stringify({
    runc: {path: "runc"},
    nvidia: {path: "/usr/bin/nvidia-container-runtime"}
  });
  const {resolveLocalAiProfile} = await import(`../config/localAiProfiles.mjs?${Date.now()}`);
  const profile = resolveLocalAiProfile();
  assert.equal(profile.key, "nvidia");
  assert.equal(profile.detectedDetails.includes("docker-runtime:nvidia"), true);
  assert.deepEqual(profile.runtimeArgs.slice(0, 4), ["--runtime", "nvidia", "--gpus", "all"]);
  delete process.env.SCRIPTARR_DOCKER_INFO_RUNTIMES_JSON;
});

test("resolve localai profile lets explicit CPU hint override Docker NVIDIA metadata", async () => {
  process.env.SCRIPTARR_GPU_HINT = "cpu";
  process.env.SCRIPTARR_DOCKER_INFO_RUNTIMES_JSON = JSON.stringify({
    runc: {path: "runc"},
    nvidia: {path: "/usr/bin/nvidia-container-runtime"}
  });
  const {resolveLocalAiProfile} = await import(`../config/localAiProfiles.mjs?${Date.now()}`);
  const profile = resolveLocalAiProfile();
  assert.equal(profile.key, "cpu");
  assert.deepEqual(profile.runtimeArgs, []);
  delete process.env.SCRIPTARR_GPU_HINT;
  delete process.env.SCRIPTARR_DOCKER_INFO_RUNTIMES_JSON;
});

test("warden runtime snapshot keeps localai manual and off first boot", async () => {
  const {resolveWardenRuntimeSnapshot} = await import(`../config/runtimeConfig.mjs?plan=${Date.now()}`);
  const runtime = resolveWardenRuntimeSnapshot();
  assert.equal(runtime.localAi.installOnFirstBoot, false);
  assert.equal(runtime.localAi.lifecycle, "manual");
});

