#!/usr/bin/env node
import {runDockerHealthcheck} from "./docker-healthcheck-lib.mjs";

const usage = () => {
  console.log([
    "Scriptarr Docker healthcheck helper",
    "",
    "Usage:",
    "  npm run docker:healthcheck -- [--stack-id healthcheck] [--moon-port 3300] [--warden-port 4101]",
    "",
    "Options:",
    "  --skip-build         Reuse the current local images instead of rebuilding them.",
    "  --keep-running       Leave the stack up after the healthcheck completes.",
    "  --timeout-minutes N  Total time budget for builds, pulls, boot, and health convergence.",
    "  --no-cache           Rebuild service images without Docker layer cache.",
    "",
    "Notes:",
    "  - This command rebuilds the current workspace images by default.",
    "  - Image builds and on-demand pulls can take a while, especially on a cold machine.",
    "  - The helper starts an isolated Warden-managed stack, waits for every container to become healthy,",
    "    verifies Warden and Moon, and tears the stack down unless --keep-running is set."
  ].join("\n"));
};

const main = async () => {
  const argv = process.argv.slice(2);
  if (argv.some((entry) => ["help", "--help", "-h"].includes(String(entry).trim().toLowerCase()))) {
    usage();
    return;
  }

  console.log(JSON.stringify(await runDockerHealthcheck({argv}), null, 2));
};

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
