/**
 * @file Scriptarr Warden module: services/warden/filesystem/storageLayout.mjs.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_DOCKER_DESKTOP_HOST_ROOT,
  DEFAULT_TEST_STATE_DIRECTORY_NAME,
  DEFAULT_UNIX_SCRIPTARR_DATA_ROOT,
  DEFAULT_WARDEN_LOG_DIR,
  DEFAULT_WARDEN_RUNTIME_DIR
} from "../config/constants.mjs";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

const normalizeString = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Detect whether a path is an absolute Windows drive path.
 *
 * @param {string} value
 * @returns {boolean}
 */
export const isWindowsAbsolutePath = (value) => WINDOWS_DRIVE_PATH_PATTERN.test(normalizeString(value));

/**
 * Translate a Windows host path into the Linux path Docker Desktop exposes to
 * Linux containers that talk to the shared Docker engine.
 *
 * @param {string} value
 * @param {{platform?: NodeJS.Platform, dockerDesktopHostRoot?: string}} [options]
 * @returns {string}
 */
export const toDockerDesktopHostPath = (
  value,
  {
    platform = process.platform,
    dockerDesktopHostRoot = DEFAULT_DOCKER_DESKTOP_HOST_ROOT
  } = {}
) => {
  const normalized = normalizeString(value);
  if (platform === "win32" && path.posix.isAbsolute(normalized)) {
    return path.posix.normalize(normalized);
  }

  if (platform === "win32" || !isWindowsAbsolutePath(normalized)) {
    return path.normalize(normalized);
  }

  const driveLetter = normalized.slice(0, 1).toLowerCase();
  const remainder = normalized
    .slice(2)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  return path.posix.join(dockerDesktopHostRoot, driveLetter, remainder);
};

/**
 * Resolve the filesystem path that the current runtime should use when it needs
 * to create or inspect a host-backed Scriptarr storage folder.
 *
 * @param {string} value
 * @param {{platform?: NodeJS.Platform, dockerDesktopHostRoot?: string}} [options]
 * @returns {string}
 */
export const resolveHostFilesystemPath = (
  value,
  {
    platform = process.platform,
    dockerDesktopHostRoot = DEFAULT_DOCKER_DESKTOP_HOST_ROOT
  } = {}
) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return normalized;
  }

  if (platform === "win32" && path.posix.isAbsolute(normalized)) {
    return path.posix.normalize(normalized);
  }

  return platform === "win32"
    ? path.normalize(normalized)
    : toDockerDesktopHostPath(normalized, {platform, dockerDesktopHostRoot});
};

/**
 * Convert a user path or relative path into an absolute host path.
 *
 * @param {string | null | undefined} value
 * @param {{cwd?: string}} [options]
 * @returns {string | null}
 */
export const toAbsoluteHostPath = (value, {cwd = process.cwd()} = {}) => {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return null;
  }

  if (isWindowsAbsolutePath(trimmed) || path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }

  return path.normalize(path.resolve(cwd, trimmed));
};

const resolveWindowsScriptarrDataRoot = (env = process.env) => {
  const appData = normalizeString(env.APPDATA);
  if (appData) {
    return path.join(appData, "scriptarr");
  }

  const homeDir = normalizeString(env.USERPROFILE) || os.homedir();
  return path.join(homeDir, "AppData", "Roaming", "scriptarr");
};

/**
 * Resolve Scriptarr's persistent data root.
 *
 * @param {{
 *   candidate?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   platform?: NodeJS.Platform
 * }} [options]
 * @returns {string}
 */
export const resolveScriptarrDataRoot = ({
  candidate = null,
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform
} = {}) => {
  const explicit = normalizeString(candidate);
  if (explicit) {
    return toAbsoluteHostPath(explicit, {cwd});
  }

  const envCandidate = normalizeString(env.SCRIPTARR_DATA_ROOT);
  if (envCandidate) {
    return toAbsoluteHostPath(envCandidate, {cwd});
  }

  if (platform === "win32") {
    return path.normalize(resolveWindowsScriptarrDataRoot(env));
  }

  return path.normalize(DEFAULT_UNIX_SCRIPTARR_DATA_ROOT);
};

const buildFolderEntry = (hostPath, containerPath = null) => ({
  hostPath: path.normalize(hostPath),
  containerPath
});

/**
 * Describe the Scriptarr on-disk runtime layout rooted at a specific data path.
 *
 * @param {string} rootPath
 * @returns {{
 *   root: string,
 *   services: Record<string, Record<string, {hostPath: string, containerPath: string | null}>>
 * }}
 */
export const buildScriptarrStorageLayout = (rootPath) => {
  const root = path.normalize(rootPath);

  return {
    root,
    services: {
      "scriptarr-warden": {
        logs: buildFolderEntry(path.join(root, "warden", "logs"), DEFAULT_WARDEN_LOG_DIR),
        runtime: buildFolderEntry(path.join(root, "warden", "runtime"), DEFAULT_WARDEN_RUNTIME_DIR)
      },
      "scriptarr-mysql": {
        data: buildFolderEntry(path.join(root, "mysql", "data"), "/var/lib/mysql")
      },
      "scriptarr-vault": {
        logs: buildFolderEntry(path.join(root, "vault", "logs"), "/var/log/scriptarr")
      },
      "scriptarr-sage": {
        logs: buildFolderEntry(path.join(root, "sage", "logs"), "/var/log/scriptarr")
      },
      "scriptarr-moon": {
        logs: buildFolderEntry(path.join(root, "moon", "logs"), "/var/log/scriptarr")
      },
      "scriptarr-raven": {
        downloads: buildFolderEntry(path.join(root, "raven", "downloads"), "/downloads"),
        logs: buildFolderEntry(path.join(root, "raven", "logs"), "/app/logs")
      },
      "scriptarr-portal": {
        logs: buildFolderEntry(path.join(root, "portal", "logs"), "/var/log/scriptarr")
      },
      "scriptarr-oracle": {
        logs: buildFolderEntry(path.join(root, "oracle", "logs"), "/var/log/scriptarr")
      },
      "scriptarr-localai": {
        data: buildFolderEntry(path.join(root, "localai", "data"), "/data"),
        models: buildFolderEntry(path.join(root, "localai", "models"), "/models"),
        logs: buildFolderEntry(path.join(root, "localai", "logs"), null)
      }
    }
  };
};

/**
 * Convert the folder map into a stable, serializable description for the Warden
 * API and for docs.
 *
 * @param {string} rootPath
 * @returns {{
 *   root: string,
 *   services: Array<{service: string, folders: Array<{key: string, hostPath: string, containerPath: string | null}>}>
 * }}
 */
export const describeScriptarrStorageLayout = (rootPath) => {
  const layout = buildScriptarrStorageLayout(rootPath);

  return {
    root: layout.root,
    services: Object.entries(layout.services).map(([service, folders]) => ({
      service,
      folders: Object.entries(folders).map(([key, folder]) => ({
        key,
        hostPath: folder.hostPath,
        containerPath: folder.containerPath
      }))
    }))
  };
};

/**
 * Create the runtime directories described by the Scriptarr storage layout.
 *
 * @param {string} rootPath
 * @param {{
 *   fsModule?: Pick<typeof fs, "mkdir">,
 *   platform?: NodeJS.Platform,
 *   dockerDesktopHostRoot?: string
 * }} [options]
 * @returns {Promise<void>}
 */
export const ensureScriptarrStorageFolders = async (
  rootPath,
  {
    fsModule = fs,
    platform = process.platform,
    dockerDesktopHostRoot = DEFAULT_DOCKER_DESKTOP_HOST_ROOT
  } = {}
) => {
  const layout = buildScriptarrStorageLayout(rootPath);
  await fsModule.mkdir(resolveHostFilesystemPath(layout.root, {
    platform,
    dockerDesktopHostRoot
  }), {recursive: true});

  const folders = Object.values(layout.services)
    .flatMap((entry) => Object.values(entry))
    .map((folder) => resolveHostFilesystemPath(folder.hostPath, {
      platform,
      dockerDesktopHostRoot
    }));

  for (const folderPath of folders) {
    await fsModule.mkdir(folderPath, {recursive: true});
  }
};

/**
 * Resolve the state directory used by the repo-level Docker test helper.
 *
 * @param {{tmpDir?: string}} [options]
 * @returns {string}
 */
export const resolveTestStateDirectory = ({tmpDir = os.tmpdir()} = {}) =>
  path.join(tmpDir, DEFAULT_TEST_STATE_DIRECTORY_NAME);

/**
 * Resolve a temporary data root for an ephemeral Docker-backed stack.
 *
 * @param {{
 *   stackId: string,
 *   tmpDir?: string,
 *   now?: number
 * }} options
 * @returns {string}
 */
export const resolveEphemeralTestDataRoot = ({stackId, tmpDir = os.tmpdir(), now = Date.now()} = {}) =>
  path.join(tmpDir, `scriptarr-test-stack-${normalizeString(stackId) || "local"}-${now}`);

