import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {resolve} from "node:path";

export const DEFAULT_REGISTRY = process.env.SCRIPTARR_DOCKER_REGISTRY || "docker.darkmatterservers.com";
export const DEFAULT_PROJECT = process.env.SCRIPTARR_DOCKER_PROJECT || "the-noona-project";
export const DEFAULT_NAMESPACE = (process.env.SCRIPTARR_DOCKER_NAMESPACE || `${DEFAULT_REGISTRY}/${DEFAULT_PROJECT}`).replace(/\/+$/, "");
export const DEFAULT_TAG = process.env.SCRIPTARR_DOCKER_TAG || "latest";
export const DEFAULT_PROGRESS = (process.env.SCRIPTARR_DOCKER_PROGRESS || "plain").toLowerCase();
export const DEFAULT_LOGIN_USERNAME = process.env.SCRIPTARR_DOCKER_USERNAME || "robot$noona-builder";
export const DEFAULT_LOGIN_PASSWORD = process.env.SCRIPTARR_DOCKER_PASSWORD || "yUKTTk8NulwFmPyt4NC38MJjcjHMONOg";

export const ROOT = resolve(".");

export const SCRIPTARR_DOCKER_SERVICES = Object.freeze([
  {name: "scriptarr-warden", dockerfile: "services/warden/Dockerfile"},
  {name: "scriptarr-vault", dockerfile: "services/vault/Dockerfile"},
  {name: "scriptarr-sage", dockerfile: "services/sage/Dockerfile"},
  {name: "scriptarr-moon", dockerfile: "services/moon/Dockerfile"},
  {name: "scriptarr-raven", dockerfile: "services/raven/Dockerfile"},
  {name: "scriptarr-portal", dockerfile: "services/portal/Dockerfile"},
  {name: "scriptarr-oracle", dockerfile: "services/oracle/Dockerfile"}
]);

export const SCRIPTARR_DOCKER_ALIASES = Object.freeze({
  warden: "scriptarr-warden",
  vault: "scriptarr-vault",
  sage: "scriptarr-sage",
  moon: "scriptarr-moon",
  raven: "scriptarr-raven",
  portal: "scriptarr-portal",
  oracle: "scriptarr-oracle"
});

/**
 * Parse a simple `node script --flag value` style CLI argument vector.
 *
 * @param {string[]} argv
 * @returns {Record<string, string | boolean | string[]>}
 */
export const parseCliArgs = (argv) => {
  const args = {_: []};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    if (token.startsWith("--")) {
      const [key, inlineValue] = token.split("=");
      if (inlineValue != null) {
        args[key.slice(2)] = inlineValue;
        continue;
      }

      const nextValue = argv[index + 1];
      if (nextValue && !nextValue.startsWith("--")) {
        args[key.slice(2)] = nextValue;
        index += 1;
      } else {
        args[key.slice(2)] = true;
      }
      continue;
    }

    args._.push(token);
  }

  return args;
};

/**
 * Normalize a service name or shorthand alias to the canonical image name.
 *
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export const normalizeDockerServiceName = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return null;
  }

  if (SCRIPTARR_DOCKER_ALIASES[raw]) {
    return SCRIPTARR_DOCKER_ALIASES[raw];
  }

  return raw.startsWith("scriptarr-") ? raw : `scriptarr-${raw}`;
};

/**
 * Select Docker service entries from the shared Scriptarr catalog.
 *
 * @param {string | null | undefined} servicesArg
 * @returns {typeof SCRIPTARR_DOCKER_SERVICES}
 */
export const selectDockerServices = (servicesArg) => {
  if (!servicesArg) {
    return [...SCRIPTARR_DOCKER_SERVICES];
  }

  const selected = new Set(String(servicesArg)
    .split(",")
    .map((entry) => normalizeDockerServiceName(entry))
    .filter(Boolean));

  return SCRIPTARR_DOCKER_SERVICES.filter((service) => selected.has(service.name));
};

/**
 * Resolve a fully qualified Docker image tag.
 *
 * @param {string} name
 * @param {{namespace?: string, tag?: string}} [options]
 * @returns {string}
 */
export const imageTag = (name, {namespace = DEFAULT_NAMESPACE, tag = DEFAULT_TAG} = {}) =>
  `${namespace.replace(/\/+$/, "")}/${name}:${tag}`;

/**
 * Run a Docker CLI command.
 *
 * @param {string[]} args
 * @param {{stdinText?: string | null, stdio?: "inherit" | "pipe"}} [options]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export const runDocker = (args, {stdinText = null, stdio = "inherit"} = {}) => new Promise((resolvePromise, rejectPromise) => {
  const child = spawn("docker", args, {
    cwd: ROOT,
    shell: false,
    stdio: stdio === "inherit" ? (stdinText == null ? "inherit" : ["pipe", "inherit", "inherit"]) : [stdinText == null ? "ignore" : "pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  if (stdio === "pipe" && child.stdout) {
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
  }

  if (stdio === "pipe" && child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
  }

  child.on("error", rejectPromise);
  if (stdinText != null && child.stdin) {
    child.stdin.end(stdinText);
  }
  child.on("exit", (code) => {
    if (code === 0) {
      resolvePromise({stdout, stderr});
      return;
    }
    rejectPromise(new Error(stderr || stdout || `docker ${args.join(" ")} failed with exit ${code}`));
  });
});

/**
 * Ensure a service's Dockerfile exists in the repo.
 *
 * @param {{dockerfile: string}} entry
 * @returns {void}
 */
export const ensureDockerfile = (entry) => {
  if (!existsSync(resolve(ROOT, entry.dockerfile))) {
    throw new Error(`Missing Dockerfile: ${entry.dockerfile}`);
  }
};

/**
 * Log into the configured Docker registry using the legacy bot account.
 *
 * @param {string} namespace
 * @returns {Promise<void>}
 */
export const ensureRegistryLogin = async (namespace) => {
  const registry = namespace.split("/")[0];
  await runDocker(["login", registry, "--username", DEFAULT_LOGIN_USERNAME, "--password-stdin"], {
    stdinText: `${DEFAULT_LOGIN_PASSWORD}\n`
  });
};

/**
 * Build a Scriptarr service image.
 *
 * @param {{name: string, dockerfile: string}} entry
 * @param {{
 *   namespace?: string,
 *   tag?: string,
 *   push?: boolean,
 *   noCache?: boolean,
 *   progress?: string
 * }} [options]
 * @returns {Promise<void>}
 */
export const buildServiceImage = async (entry, {
  namespace = DEFAULT_NAMESPACE,
  tag = DEFAULT_TAG,
  push = false,
  noCache = false,
  progress = DEFAULT_PROGRESS
} = {}) => {
  ensureDockerfile(entry);
  const args = [
    "buildx",
    "build",
    "--progress",
    progress,
    "-f",
    entry.dockerfile,
    "-t",
    imageTag(entry.name, {namespace, tag})
  ];

  if (noCache) {
    args.push("--no-cache");
  }

  args.push(push ? "--push" : "--load");
  args.push(".");
  await runDocker(args);
};

/**
 * Push a previously built Scriptarr image to the configured registry.
 *
 * @param {{name: string, dockerfile: string}} entry
 * @param {{namespace?: string, tag?: string}} [options]
 * @returns {Promise<void>}
 */
export const pushServiceImage = async (entry, {namespace = DEFAULT_NAMESPACE, tag = DEFAULT_TAG} = {}) => {
  ensureDockerfile(entry);
  await runDocker(["push", imageTag(entry.name, {namespace, tag})]);
};

/**
 * Determine whether a tagged local image already exists.
 *
 * @param {{name: string}} entry
 * @param {{namespace?: string, tag?: string}} [options]
 * @returns {Promise<boolean>}
 */
export const localImageExists = async (entry, {namespace = DEFAULT_NAMESPACE, tag = DEFAULT_TAG} = {}) => {
  try {
    await runDocker(["image", "inspect", imageTag(entry.name, {namespace, tag})], {
      stdio: "pipe"
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Ensure the selected Scriptarr images are available locally, building any that
 * are missing or rebuilding all of them when `forceBuild` is enabled.
 *
 * @param {Array<{name: string, dockerfile: string}>} entries
 * @param {{
 *   namespace?: string,
 *   tag?: string,
 *   progress?: string,
 *   forceBuild?: boolean,
 *   noCache?: boolean
 * }} [options]
 * @returns {Promise<void>}
 */
export const ensureLocalImages = async (entries, {
  namespace = DEFAULT_NAMESPACE,
  tag = DEFAULT_TAG,
  progress = DEFAULT_PROGRESS,
  forceBuild = false,
  noCache = false
} = {}) => {
  for (const entry of entries) {
    if (!forceBuild && await localImageExists(entry, {namespace, tag})) {
      continue;
    }

    await buildServiceImage(entry, {
      namespace,
      tag,
      progress,
      noCache
    });
  }
};
