/**
 * @file Scriptarr Warden module: services/warden/config/localAiProfiles.mjs.
 */
import os from "node:os";
import {execFileSync} from "node:child_process";

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
    runtimeArgs: ["--gpus", "all"]
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
    const profile = PROFILE_MAP[explicit];
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
  const nvidia = detectNvidia();
  if (nvidia.length > 0) {
    details.push(...nvidia.map((name) => `nvidia:${name}`));
    return {
      ...PROFILE_MAP.nvidia,
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
        ...PROFILE_MAP.nvidia,
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

