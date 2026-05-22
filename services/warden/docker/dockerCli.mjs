/**
 * @file Scriptarr Warden module: services/warden/docker/dockerCli.mjs.
 */
import {spawn} from "node:child_process";
import {toDockerDesktopHostPath} from "../filesystem/storageLayout.mjs";

const DEFAULT_DOCKER_TIMEOUT_MS = 15 * 60 * 1000;
const LONG_DOCKER_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
const MAX_BUFFERED_LINE_CHARS = 64 * 1024;

const normalizeString = (value) => String(value ?? "").trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const appendBounded = (current, text, maxChars) => {
  if (maxChars <= 0) {
    return "";
  }
  const combined = `${current}${text}`;
  return combined.length > maxChars ? combined.slice(0, maxChars) : combined;
};

const flushBufferedLine = (buffer, onLine) => {
  const remaining = normalizeString(buffer);
  if (remaining && typeof onLine === "function") {
    onLine(remaining);
  }
};

/**
 * Run a Docker CLI command and capture its output.
 *
 * @param {string[]} args
 * @param {{
 *   cwd?: string,
 *   stdinText?: string | null,
 *   stdio?: "inherit" | "pipe",
 *   onStdoutLine?: (line: string) => void,
 *   onStderrLine?: (line: string) => void,
 *   timeoutMs?: number,
 *   maxOutputChars?: number,
 *   command?: string
 * }} [options]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export const runDocker = (
  args,
  {
    cwd = process.cwd(),
    stdinText = null,
    stdio = "pipe",
    onStdoutLine,
    onStderrLine,
    timeoutMs = DEFAULT_DOCKER_TIMEOUT_MS,
    maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    command = "docker"
  } = {}
) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd,
    shell: false,
    stdio: stdio === "inherit" ? "inherit" : [stdinText == null ? "ignore" : "pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let settled = false;
  let timedOut = false;
  let timeout = null;
  let forceKillTimeout = null;
  const safeTimeoutMs = normalizePositiveInteger(timeoutMs, DEFAULT_DOCKER_TIMEOUT_MS);
  const safeMaxOutputChars = normalizePositiveInteger(maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);

  const settle = (callback, value) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeout) {
      clearTimeout(timeout);
    }
    if (forceKillTimeout) {
      clearTimeout(forceKillTimeout);
    }
    callback(value);
  };

  if (safeTimeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
      forceKillTimeout.unref?.();
    }, safeTimeoutMs);
    timeout.unref?.();
  }

  if (stdio !== "inherit" && child.stdout) {
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout = appendBounded(stdout, text, safeMaxOutputChars);
      stdoutBuffer = appendBounded(stdoutBuffer, text, MAX_BUFFERED_LINE_CHARS);

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (typeof onStdoutLine === "function" && normalizeString(line)) {
          onStdoutLine(normalizeString(line));
        }
      }
    });
  }

  if (stdio !== "inherit" && child.stderr) {
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr = appendBounded(stderr, text, safeMaxOutputChars);
      stderrBuffer = appendBounded(stderrBuffer, text, MAX_BUFFERED_LINE_CHARS);

      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      for (const line of lines) {
        if (typeof onStderrLine === "function" && normalizeString(line)) {
          onStderrLine(normalizeString(line));
        }
      }
    });
  }

  child.on("error", (error) => settle(reject, error));

  if (stdinText != null && child.stdin) {
    child.stdin.end(stdinText);
  }

  child.on("close", (code) => {
    if (stdio !== "inherit") {
      flushBufferedLine(stdoutBuffer, onStdoutLine);
      flushBufferedLine(stderrBuffer, onStderrLine);
    }

    if (timedOut) {
      settle(reject, new Error(`docker ${args.join(" ")} timed out after ${safeTimeoutMs}ms.`));
      return;
    }

    if (code === 0) {
      settle(resolve, {stdout, stderr});
      return;
    }

    settle(reject, new Error(stderr || stdout || `docker ${args.join(" ")} failed with exit ${code}`));
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
 * Inspect a local Docker image and return its JSON metadata.
 *
 * @param {string} image
 * @returns {Promise<Record<string, unknown> | null>}
 */
export const inspectDockerImage = async (image) => {
  try {
    const {stdout} = await runDocker(["image", "inspect", image], {
      stdio: "pipe"
    });
    const [payload] = JSON.parse(stdout);
    return payload || null;
  } catch (error) {
    if (/No such image/i.test(String(error))) {
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
 * @returns {Promise<{created: boolean}>}
 */
export const ensureDockerNetwork = async (networkName) => {
  try {
    await runDocker(["network", "inspect", networkName]);
    return {created: false};
  } catch {
    await runDocker(["network", "create", networkName]);
    return {created: true};
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
 *   extraArgs?: string[],
 *   healthCheck?: {
 *     command: string,
 *     interval?: string,
 *     timeout?: string,
 *     startPeriod?: string,
 *     retries?: number
 *   },
 *   labels?: Record<string, string>,
 *   extraHosts?: string[],
 *   restartPolicy?: string,
 *   logger?: {info: Function, warn: Function}
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
  extraArgs = [],
  healthCheck = null,
  labels = {},
  extraHosts = [],
  restartPolicy = "no",
  logger
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

  for (const extraArg of extraArgs) {
    args.push(String(extraArg));
  }

  if (healthCheck?.command) {
    args.push("--health-cmd", healthCheck.command);
    if (healthCheck.interval) {
      args.push("--health-interval", healthCheck.interval);
    }
    if (healthCheck.timeout) {
      args.push("--health-timeout", healthCheck.timeout);
    }
    if (healthCheck.startPeriod) {
      args.push("--health-start-period", healthCheck.startPeriod);
    }
    if (Number.isInteger(healthCheck.retries) && healthCheck.retries > 0) {
      args.push("--health-retries", String(healthCheck.retries));
    }
  }

  args.push(image);
  const missingImage = !(await imageExists(image));

  if (missingImage && logger) {
    logger.info("Docker image is missing locally. Allowing docker run to pull it on demand.", {
      container: name,
      image
    });
  }

  await runDocker(args, {
    timeoutMs: LONG_DOCKER_TIMEOUT_MS,
    onStdoutLine: missingImage && logger
      ? (line) => {
        logger.info("Docker run output.", {
          container: name,
          image,
          output: line
        });
      }
      : undefined,
    onStderrLine: missingImage && logger
      ? (line) => {
        logger.info("Docker pull progress.", {
          container: name,
          image,
          output: line
        });
      }
      : undefined
  });
};

/**
 * Pull a Docker image and stream progress lines through the provided logger.
 *
 * @param {string} image
 * @param {{logger?: {info: Function}, onProgress?: (line: string) => void}} [options]
 * @returns {Promise<void>}
 */
export const pullDockerImage = async (image, {logger, onProgress} = {}) => {
  const handleLine = (line) => {
    onProgress?.(line);
    logger?.info("Docker pull output.", {
      image,
      output: line
    });
  };

  await runDocker(["pull", image], {
    timeoutMs: LONG_DOCKER_TIMEOUT_MS,
    onStdoutLine: logger || onProgress ? handleLine : undefined,
    onStderrLine: logger || onProgress ? handleLine : undefined
  });
};

/**
 * Remove a Docker image if it exists locally.
 *
 * @param {string} image
 * @param {{ignoreMissing?: boolean}} [options]
 * @returns {Promise<void>}
 */
export const removeDockerImage = async (image, {ignoreMissing = true} = {}) => {
  try {
    await runDocker(["rmi", image]);
  } catch (error) {
    if (!ignoreMissing || !/No such image|not found/i.test(String(error))) {
      throw error;
    }
  }
};

/**
 * Read recent Docker log lines for a managed container.
 *
 * @param {string} containerName
 * @param {{lines?: number}} [options]
 * @returns {Promise<string>}
 */
export const readDockerContainerLogs = async (containerName, {lines = 250} = {}) => {
  const safeLines = Math.min(1000, Math.max(1, Number.parseInt(String(lines), 10) || 250));
  const {stdout, stderr} = await runDocker([
    "logs",
    "--tail",
    String(safeLines),
    "--timestamps",
    containerName
  ]);
  return [stdout, stderr].filter(Boolean).join("\n");
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

/**
 * Wait for a Docker container to become healthy, or at least running when it
 * does not define a container health check.
 *
 * @param {string} containerName
 * @param {{timeoutMs?: number, intervalMs?: number}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export const waitForContainerHealthy = async (containerName, {timeoutMs = 180000, intervalMs = 2000} = {}) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const inspect = await inspectDockerContainer(containerName);
    const state = inspect?.State || {};
    const healthStatus = state?.Health?.Status || "";

    if (healthStatus === "healthy") {
      return inspect;
    }

    if (!state?.Health && state?.Running) {
      return inspect;
    }

    if (state?.Status === "exited" || state?.Status === "dead") {
      throw new Error(`Container ${containerName} stopped before it became healthy.`);
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for container ${containerName} to become healthy.`);
};

