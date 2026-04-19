#!/usr/bin/env node
import {buildTestStackEnvironment, createTestStackManager} from "../services/warden/core/testStackManager.mjs";
import {resolveServicePlan} from "../services/warden/config/servicePlan.mjs";
import {
  DEFAULT_NAMESPACE,
  DEFAULT_PROGRESS,
  DEFAULT_TAG,
  SCRIPTARR_DOCKER_SERVICES,
  ensureLocalImages,
  parseCliArgs
} from "./docker-services.mjs";

const usage = () => {
  console.log([
    "Scriptarr Docker test stack helper",
    "",
    "Usage:",
    "  node scripts/docker-test-stack.mjs start [--stack-id local] [--moon-port 3300] [--warden-port 4101]",
    "  node scripts/docker-test-stack.mjs stop [--stack-id local]",
    "  node scripts/docker-test-stack.mjs status [--stack-id local]",
    "",
    "Notes:",
    "  - Warden runs as a Docker container and reconciles the rest of the stack through the Docker socket.",
    "  - The managed services run on an isolated Scriptarr test network.",
    "  - The selected service images are rebuilt from the current workspace unless --skip-build is used."
  ].join("\n"));
};

const printableSummary = (payload) => JSON.stringify(payload, null, 2);

const main = async () => {
  const args = parseCliArgs(process.argv.slice(2));
  const command = String(args._[0] || "start").trim().toLowerCase();

  if (["help", "--help", "-h"].includes(command)) {
    usage();
    return;
  }

  const stackId = String(args["stack-id"] || "local");
  const moonPort = args["moon-port"] ? Number.parseInt(String(args["moon-port"]), 10) : undefined;
  const wardenPort = args["warden-port"] ? Number.parseInt(String(args["warden-port"]), 10) : undefined;
  const dataRoot = typeof args["data-root"] === "string" ? String(args["data-root"]) : undefined;
  const mysqlUrl = typeof args["mysql-url"] === "string" ? String(args["mysql-url"]) : undefined;
  const namespace = String(args.namespace || DEFAULT_NAMESPACE).trim().replace(/\/+$/, "");
  const tag = String(args.tag || DEFAULT_TAG).trim();
  const progress = String(args.progress || DEFAULT_PROGRESS).trim();
  const helperEnv = {
    ...process.env,
    SCRIPTARR_IMAGE_NAMESPACE: namespace,
    SCRIPTARR_IMAGE_TAG: tag
  };

  if (command === "status") {
    const statusManager = createTestStackManager({env: helperEnv});
    console.log(printableSummary(await statusManager.status({stackId})));
    return;
  }

  if (command === "stop" || command === "teardown") {
    const stopManager = createTestStackManager({env: helperEnv});
    console.log(printableSummary(await stopManager.stop({stackId, tolerateMissing: true})));
    return;
  }

  if (command !== "start") {
    throw new Error(`Unknown command: ${command}`);
  }

  const built = buildTestStackEnvironment({
    env: helperEnv,
    stackId,
    moonPort,
    wardenPort,
    dataRoot,
    mysqlUrl
  });

  if (args["skip-build"] !== true) {
    const runtimePlan = resolveServicePlan({
      env: built.env,
      containerNamePrefix: `scriptarr-test-${built.stackId}`
    });
    const selected = SCRIPTARR_DOCKER_SERVICES.filter((entry) =>
      entry.name === "scriptarr-warden" || runtimePlan.services.some((service) => service.name === entry.name)
    );

    await ensureLocalImages(selected, {
      namespace,
      tag,
      progress,
      forceBuild: args.build == null
        ? true
        : args.build === true || String(args.build || "").toLowerCase() === "true",
      noCache: args["no-cache"] === true || String(args["no-cache"] || "").toLowerCase() === "true"
    });
  }

  const startManager = createTestStackManager({env: helperEnv});

  console.log(printableSummary(await startManager.start({
    stackId,
    moonPort,
    wardenPort,
    dataRoot,
    mysqlUrl,
    removeDataRootOnStop: args["keep-data"] === true ? false : undefined
  })));
};

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
