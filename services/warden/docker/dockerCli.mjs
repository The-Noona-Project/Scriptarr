import {spawn} from "node:child_process";

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
    if (!ignoreMissing || !/No such network/i.test(String(error))) {
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
  networkName,
  networkAliases = [],
  mounts = [],
  publishedPorts = [],
  labels = {},
  extraHosts = []
}) => {
  const args = ["run", "-d", "--name", name, "--network", networkName];

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
    args.push("-v", `${mount.hostPath}:${mount.containerPath}`);
  }

  for (const publishedPort of publishedPorts) {
    args.push("-p", `${publishedPort.hostPort}:${publishedPort.containerPort}`);
  }

  args.push(image);
  await runDocker(args);
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
