/**
 * @file Scriptarr Warden module: services/warden/config/localAiProfiles.mjs.
 */
import os from "node:os";
import fs from "node:fs";
import {execFileSync} from "node:child_process";

const NVIDIA_DEVICE_PATHS = Object.freeze([
  "/dev/nvidia0",
  "/dev/nvidiactl",
  "/dev/nvidia-uvm",
  "/dev/nvidia-uvm-tools"
]);

const PROFILE_MAP = Object.freeze({
  cpu: {
    key: "cpu",
    image: "localai/localai:latest-aio-cpu",
    reason: "No supported GPU acceleration detected; using the LocalAI AIO CPU image.",
    runtimeArgs: []
  },
  nvidia: {
    key: "nvidia",
    image: "localai/localai:latest-aio-gpu-nvidia-cuda-12",
    reason: "Detected an NVIDIA GPU; using the LocalAI AIO CUDA 12 image.",
    runtimeArgs: ["--runtime", "nvidia", "--gpus", "all"]
  },
  intel: {
    key: "intel",
    image: "localai/localai:latest-aio-gpu-intel",
    reason: "Detected an Intel GPU; using the LocalAI AIO Intel image.",
    runtimeArgs: ["--device", "/dev/dri", "--group-add", "video"]
  },
  amd: {
    key: "amd",
    image: "localai/localai:latest-aio-gpu-hipblas",
    reason: "Detected an AMD GPU; using the LocalAI AIO HIPBLAS image.",
    runtimeArgs: ["--device", "/dev/kfd", "--device", "/dev/dri", "--group-add", "video"]
  }
});

const normalizeString = (value) => String(value ?? "").trim().toLowerCase();

const wantsExplicitNvidiaDevices = (env = process.env) => ["1", "true", "yes", "on"].includes(normalizeString(env.SCRIPTARR_NVIDIA_DEVICE_BINDINGS));

const resolveNvidiaDeviceArgs = (env = process.env) => {
  if (!wantsExplicitNvidiaDevices(env)) {
    return [];
  }
  const rawPaths = String(env.SCRIPTARR_NVIDIA_DEVICE_PATHS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const paths = rawPaths.length ? rawPaths : NVIDIA_DEVICE_PATHS;
  return paths
    .filter((path) => fs.existsSync(path))
    .flatMap((path) => ["--device", path]);
};

const withNvidiaRuntimeArgs = (profile, env) => ({
  ...profile,
  runtimeArgs: [...profile.runtimeArgs, ...resolveNvidiaDeviceArgs(env)]
});

const runProbe = (command, args) => {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return "";
  }
};

const detectWindowsGpu = () => {
  const output = runProbe("powershell", [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"
  ]);

  return output
    .split(/\r?\n/)
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
};

const detectNvidia = () => {
  const output = runProbe("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  return output
    .split(/\r?\n/)
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
};

const detectDockerNvidiaRuntime = (env = process.env) => {
  const explicit = normalizeString(env.SCRIPTARR_DOCKER_INFO_RUNTIMES_JSON);
  const output = explicit || runProbe("docker", ["info", "--format", "{{json .Runtimes}}"]);
  if (!output) {
    return [];
  }
  try {
    const runtimes = JSON.parse(output);
    return runtimes && Object.hasOwn(runtimes, "nvidia") ? ["docker-runtime:nvidia"] : [];
  } catch {
    return normalizeString(output).includes("nvidia") ? ["docker-runtime:nvidia"] : [];
  }
};

const detectIntel = () => {
  const output = runProbe("sycl-ls", []);
  return normalizeString(output).includes("intel") ? ["intel"] : [];
};

const detectAmd = () => {
  const outputs = [
    runProbe("rocminfo", []),
    runProbe("rocm-smi", ["--showproductname"])
  ].join("\n");

  return normalizeString(outputs).includes("amd") || normalizeString(outputs).includes("radeon") ? ["amd"] : [];
};

/**
 * Resolve the LocalAI image profile that best matches the current host.
 *
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform}} [options]
 * @returns {{
 *   key: string,
 *   image: string,
 *   reason: string,
 *   detectedVendor: string,
 *   detectedDetails: string[],
 *   host: {platform: NodeJS.Platform, arch: string}
 * }}
 */
export const resolveLocalAiProfile = ({env = process.env, platform = process.platform} = {}) => {
  const explicit = normalizeString(env.SCRIPTARR_GPU_HINT);
  if (explicit && PROFILE_MAP[explicit]) {
    const profile = explicit === "nvidia" ? withNvidiaRuntimeArgs(PROFILE_MAP[explicit], env) : PROFILE_MAP[explicit];
    return {
      ...profile,
      detectedVendor: explicit,
      detectedDetails: [`Explicit GPU hint: ${explicit}`],
      host: {
        platform,
        arch: os.arch()
      }
    };
  }

  const details = [];
  const dockerNvidia = detectDockerNvidiaRuntime(env);
  if (dockerNvidia.length > 0) {
    details.push(...dockerNvidia);
    return {
      ...withNvidiaRuntimeArgs(PROFILE_MAP.nvidia, env),
      detectedVendor: "nvidia",
      detectedDetails: details,
      host: {platform, arch: os.arch()}
    };
  }

  const nvidia = detectNvidia();
  if (nvidia.length > 0) {
    details.push(...nvidia.map((name) => `nvidia:${name}`));
    return {
      ...withNvidiaRuntimeArgs(PROFILE_MAP.nvidia, env),
      detectedVendor: "nvidia",
      detectedDetails: details,
      host: {platform, arch: os.arch()}
    };
  }

  const intel = detectIntel();
  if (intel.length > 0) {
    details.push(...intel.map((name) => `intel:${name}`));
    return {
      ...PROFILE_MAP.intel,
      detectedVendor: "intel",
      detectedDetails: details,
      host: {platform, arch: os.arch()}
    };
  }

  const amd = detectAmd();
  if (amd.length > 0) {
    details.push(...amd.map((name) => `amd:${name}`));
    return {
      ...PROFILE_MAP.amd,
      detectedVendor: "amd",
      detectedDetails: details,
      host: {platform, arch: os.arch()}
    };
  }

  if (platform === "win32") {
    const names = detectWindowsGpu();
    details.push(...names.map((name) => `windows:${name}`));
    if (names.some((name) => name.includes("nvidia"))) {
      return {
        ...withNvidiaRuntimeArgs(PROFILE_MAP.nvidia, env),
        detectedVendor: "nvidia",
        detectedDetails: details,
        host: {platform, arch: os.arch()}
      };
    }
    if (names.some((name) => name.includes("intel"))) {
      return {
        ...PROFILE_MAP.intel,
        detectedVendor: "intel",
        detectedDetails: details,
        host: {platform, arch: os.arch()}
      };
    }
    if (names.some((name) => name.includes("amd") || name.includes("radeon"))) {
      return {
        ...PROFILE_MAP.amd,
        detectedVendor: "amd",
        detectedDetails: details,
        host: {platform, arch: os.arch()}
      };
    }
  }

  return {
    ...PROFILE_MAP.cpu,
    detectedVendor: "cpu",
    detectedDetails: details,
    host: {
      platform,
      arch: os.arch()
    }
  };
};

export const localAiProfiles = PROFILE_MAP;

