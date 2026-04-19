/**
 * @file Scriptarr Warden module: services/warden/docker/dockerCli.mjs.
 */
import {spawn} from "node:child_process";
import {toDockerDesktopHostPath} from "../filesystem/storageLayout.mjs";

const normalizeString = (value) => String(value ?? "").trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a Docker CLI command and capture its output.
 *
 * @param {string[]} args
 * @param {{
 *   cwd?: string,
 *   stdinText?: string | null,
 *   stdio?: "inherit" | "pipe"
 * }} [options]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export const runDocker = (args, {cwd = process.cwd(), stdinText = null, stdio = "pipe"} = {}) => new Promise((resolve, reject) => {
  const child = spawn("docker", args, {
    cwd,
    shell: false,
    stdio: stdio === "inherit" ? "inherit" : [stdinText == null ? "ignore" : "pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  if (stdio !== "inherit" && child.stdout) {
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
  }

  if (stdio !== "inherit" && child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
  }

  child.on("error", reject);

  if (stdinText != null && child.stdin) {
    child.stdin.end(stdinText);
  }

  child.on("exit", (code) => {
    if (code === 0) {
      resolve({stdout, stderr});
      return;
    }

    reject(new Error(stderr || stdout || `docker ${args.join(" ")} failed with exit ${code}`));
  });
});

/**
 * Determine whether the current runtime can reach the Docker engine.
 *
 * @returns {Promise<boolean>}
 */
export const dockerSocketAvailable = async () => {
  try {
    await runDocker(["info", "--format", "{{.ID}}"]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Determine whether a local Docker image already exists.
 *
 * @param {string} image
 * @returns {Promise<boolean>}
 */
export const imageExists = async (image) => {
  try {
    await runDocker(["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Inspect a Docker container and return its JSON metadata.
 *
 * @param {string} containerName
 * @returns {Promise<Record<string, unknown> | null>}
 */
export const inspectDockerContainer = async (containerName) => {
  try {
    const {stdout} = await runDocker(["container", "inspect", containerName], {
      stdio: "pipe"
    });
    const [payload] = JSON.parse(stdout);
    return payload || null;
  } catch (error) {
    if (/No such container/i.test(String(error))) {
      return null;
    }
    throw error;
  }
};

/**
 * List Docker containers that match an exact label filter.
 *
 * @param {string} labelKey
 * @param {string} labelValue
 * @returns {Promise<Array<{id: string, name: string, image: string, labels: Record<string, string>}>>}
 */
export const listContainersByLabel = async (labelKey, labelValue) => {
  const {stdout} = await runDocker([
    "ps",
    "-a",
    "--filter",
    `label=${labelKey}=${labelValue}`,
    "--format",
    "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Labels}}"
  ]);

  return normalizeString(stdout)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id, name, image, rawLabels = ""] = line.split("\t");
      return {
        id,
        name,
        image,
        labels: Object.fromEntries(String(rawLabels).split(",").filter(Boolean).map((pair) => {
          const [key, ...value] = pair.split("=");
          return [key, value.join("=")];
        }))
      };
    });
};

/**
 * Start an existing Docker container.
 *
 * @param {string} containerName
 * @returns {Promise<void>}
 */
export const startDockerContainer = async (containerName) => {
  await runDocker(["start", containerName]);
};

/**
 * Determine whether a Docker container is currently running.
 *
 * @param {string} containerName
 * @returns {Promise<boolean>}
 */
export const containerExists = async (containerName) => {
  const {stdout} = await runDocker([
    "ps",
    "--filter",
    `name=^/${containerName}$`,
    "--format",
    "{{.Names}}"
  ]);

  return normalizeString(stdout) === containerName;
};

/**
 * Remove a Docker container if it exists.
 *
 * @param {string} containerName
 * @param {{ignoreMissing?: boolean}} [options]
 * @returns {Promise<void>}
 */
export const removeDockerContainer = async (containerName, {ignoreMissing = true} = {}) => {
  try {
    await runDocker(["rm", "-f", containerName]);
  } catch (error) {
    if (!ignoreMissing || !/No such container/i.test(String(error))) {
      throw error;
    }
  }
};

/**
 * Ensure a named Docker network exists.
 *
 * @param {string} networkName
 * @returns {Promise<void>}
 */
export const ensureDockerNetwork = async (networkName) => {
  try {
    await runDocker(["network", "inspect", networkName]);
  } catch {
    await runDocker(["network", "create", networkName]);
  }
};

/**
 * Remove a named Docker network if it exists.
 *
 * @param {string} networkName
 * @param {{ignoreMissing?: boolean}} [options]
 * @returns {Promise<void>}
 */
export const removeDockerNetwork = async (networkName, {ignoreMissing = true} = {}) => {
  try {
    await runDocker(["network", "rm", networkName]);
  } catch (error) {
    if (!ignoreMissing || !/No such network|not found/i.test(String(error))) {
      throw error;
    }
  }
};

/**
 * Run a container in detached mode with the normalized Scriptarr runtime
 * metadata used by the Docker-backed stack test helper.
 *
 * @param {{
 *   name: string,
 *   image: string,
 *   env?: Record<string, string>,
 *   networkName: string,
 *   networkAliases?: string[],
 *   mounts?: Array<{hostPath: string, containerPath: string | null}>,
 *   publishedPorts?: Array<{hostPort: number, containerPort: number}>,
 *   labels?: Record<string, string>,
 *   extraHosts?: string[]
 * }} descriptor
 * @returns {Promise<void>}
 */
export const runDetachedContainer = async ({
  name,
  image,
  env = {},
  networkName = "",
  networkAliases = [],
  mounts = [],
  publishedPorts = [],
  labels = {},
  extraHosts = [],
  restartPolicy = "no"
}) => {
  const args = ["run", "-d", "--name", name];

  if (networkName) {
    args.push("--network", networkName);
  }

  if (restartPolicy && restartPolicy !== "no") {
    args.push("--restart", restartPolicy);
  }

  for (const alias of networkAliases) {
    args.push("--network-alias", alias);
  }

  for (const extraHost of extraHosts) {
    args.push("--add-host", extraHost);
  }

  for (const [key, value] of Object.entries(labels)) {
    args.push("--label", `${key}=${value}`);
  }

  for (const [key, value] of Object.entries(env)) {
    args.push("-e", `${key}=${value}`);
  }

  for (const mount of mounts) {
    if (!mount?.hostPath || !mount?.containerPath) {
      continue;
    }
    args.push("-v", `${toDockerDesktopHostPath(mount.hostPath)}:${mount.containerPath}`);
  }

  for (const publishedPort of publishedPorts) {
    args.push("-p", `${publishedPort.hostPort}:${publishedPort.containerPort}`);
  }

  args.push(image);
  await runDocker(args);
};

/**
 * Connect an existing container to a Docker network, optionally applying
 * aliases on that network.
 *
 * @param {{
 *   containerName: string,
 *   networkName: string,
 *   aliases?: string[]
 * }} options
 * @returns {Promise<void>}
 */
export const connectContainerToNetwork = async ({
  containerName,
  networkName,
  aliases = []
}) => {
  const args = ["network", "connect"];
  for (const alias of aliases) {
    args.push("--alias", alias);
  }
  args.push(networkName, containerName);
  await runDocker(args);
};

/**
 * Disconnect a container from a Docker network if it is already attached.
 *
 * @param {{
 *   containerName: string,
 *   networkName: string,
 *   ignoreMissing?: boolean
 * }} options
 * @returns {Promise<void>}
 */
export const disconnectContainerFromNetwork = async ({
  containerName,
  networkName,
  ignoreMissing = true
}) => {
  try {
    await runDocker(["network", "disconnect", networkName, containerName]);
  } catch (error) {
    if (!ignoreMissing || !/is not connected|No such container|No such network/i.test(String(error))) {
      throw error;
    }
  }
};

/**
 * Wait for the MySQL container to accept connections.
 *
 * @param {{
 *   containerName: string,
 *   password: string,
 *   user?: string,
 *   timeoutMs?: number,
 *   intervalMs?: number
 * }} options
 * @returns {Promise<void>}
 */
export const waitForMySqlReady = async ({
  containerName,
  password,
  user = "root",
  timeoutMs = 120000,
  intervalMs = 2000
}) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await runDocker([
        "exec",
        containerName,
        "mysqladmin",
        "ping",
        "-h",
        "127.0.0.1",
        `-u${user}`,
        `-p${password}`,
        "--silent"
      ]);
      return;
    } catch {
      await sleep(intervalMs);
    }
  }

  throw new Error(`Timed out waiting for MySQL container ${containerName} to become ready.`);
};

/**
 * Wait for an HTTP endpoint to return a successful status code.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, intervalMs?: number}} [options]
 * @returns {Promise<void>}
 */
export const waitForHttp = async (url, {timeoutMs = 120000, intervalMs = 1500} = {}) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(intervalMs, 1000))
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the deadline is reached.
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${url}.`);
};

