#!/usr/bin/env node
import {
  DEFAULT_LOGIN_USERNAME,
  DEFAULT_NAMESPACE,
  DEFAULT_PROGRESS,
  DEFAULT_TAG,
  SCRIPTARR_DOCKER_SERVICES,
  buildServiceImage,
  ensureRegistryLogin,
  imageTag,
  parseCliArgs,
  pushServiceImage,
  selectDockerServices
} from "./docker-services.mjs";

const usage = () => {
  console.log([
    "Scriptarr Docker helper",
    "",
    "Usage:",
    "  node scripts/docker-images.mjs list",
    "  node scripts/docker-images.mjs build [--services moon,sage] [--tag latest] [--namespace docker.darkmatterservers.com/the-noona-project]",
    "  node scripts/docker-images.mjs push [--services moon,sage] [--tag latest] [--namespace docker.darkmatterservers.com/the-noona-project]",
    "  node scripts/docker-images.mjs publish [--services moon,sage] [--tag latest] [--namespace docker.darkmatterservers.com/the-noona-project]",
    "",
    "Env:",
    `  SCRIPTARR_DOCKER_NAMESPACE default=${DEFAULT_NAMESPACE}`,
    `  SCRIPTARR_DOCKER_TAG default=${DEFAULT_TAG}`,
    `  SCRIPTARR_DOCKER_PROGRESS default=${DEFAULT_PROGRESS}`,
    `  SCRIPTARR_DOCKER_USERNAME default=${DEFAULT_LOGIN_USERNAME}`,
    "  SCRIPTARR_DOCKER_PASSWORD override the registry bot password"
  ].join("\n"));
};

const main = async () => {
  const args = parseCliArgs(process.argv.slice(2));
  const command = String(args._[0] || "").trim().toLowerCase();
  if (!command || ["help", "--help", "-h"].includes(command)) {
    usage();
    return;
  }

  const namespace = String(args.namespace || DEFAULT_NAMESPACE).trim().replace(/\/+$/, "");
  const tag = String(args.tag || DEFAULT_TAG).trim();
  const selected = selectDockerServices(args.services);

  if (command === "list") {
    for (const service of SCRIPTARR_DOCKER_SERVICES) {
      console.log(`${service.name}\t${imageTag(service.name, {namespace, tag})}\t${service.dockerfile}`);
    }
    return;
  }

  if (selected.length === 0) {
    throw new Error("No services matched the requested selection.");
  }

  if (command === "push" || command === "publish") {
    await ensureRegistryLogin(namespace);
  }

  if (command === "build" || command === "publish") {
    for (const service of selected) {
      await buildServiceImage(service, {
        namespace,
        tag,
        push: command === "publish",
        noCache: args["no-cache"] === true || String(args["no-cache"] || "").toLowerCase() === "true",
        progress: String(args.progress || DEFAULT_PROGRESS)
      });
    }
    return;
  }

  if (command === "push") {
    for (const service of selected) {
      await pushServiceImage(service, {namespace, tag});
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
};

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
