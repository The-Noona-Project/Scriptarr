/**
 * @file Skip the current pending GitHub update digest without posting it.
 */
import {resolveSageConfig} from "../lib/config.mjs";
import {createVaultClient} from "../lib/vaultClient.mjs";
import {
  GITHUB_UPDATE_DIGEST_SETTING_KEY,
  buildSkippedGithubUpdateDigestState,
  normalizeGithubUpdateDigestState
} from "../lib/githubUpdateDigest.mjs";

/**
 * Normalize command-line or setting values into trimmed strings.
 *
 * @param {unknown} value
 * @returns {string}
 */
const normalizeString = (value) => typeof value === "string" ? value.trim() : "";

/**
 * Resolve a `--name=value` CLI option.
 *
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
const readOption = (name, fallback = "") => {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
  return value ? normalizeString(value.slice(prefix.length)) : fallback;
};

const applySkip = process.argv.includes("--apply");
const skipRequested = process.argv.includes("--skip-pending-update-digest") || process.argv.includes("--skip-pending");
const reason = readOption("reason", "future-only");

if (!skipRequested) {
  console.log(JSON.stringify({
    changed: false,
    applied: applySkip,
    reason: "missing-skip-flag",
    usage: "node services/sage/scripts/skip-github-update-digest.mjs --skip-pending-update-digest --reason=future-only [--apply]"
  }, null, 2));
  process.exit(1);
}

const config = resolveSageConfig();
const vaultClient = createVaultClient(config);
const setting = await vaultClient.getSetting(GITHUB_UPDATE_DIGEST_SETTING_KEY);
const state = normalizeGithubUpdateDigestState(setting?.value);
const {state: nextState, skipped} = buildSkippedGithubUpdateDigestState(state, {reason});

if (!skipped) {
  console.log(JSON.stringify({
    changed: false,
    applied: applySkip,
    reason: "no-pending-digest",
    lastBaselineSha: normalizeString(state.lastBaselineSha).slice(0, 12),
    latestSkippedId: normalizeString(state.latestSkipped?.id)
  }, null, 2));
  process.exit(0);
}

if (applySkip) {
  await vaultClient.setSetting(GITHUB_UPDATE_DIGEST_SETTING_KEY, nextState);
}

console.log(JSON.stringify({
  changed: true,
  applied: applySkip,
  notificationId: normalizeString(skipped.id),
  skipReason: normalizeString(skipped.skipReason),
  lastBaselineSha: normalizeString(nextState.lastBaselineSha).slice(0, 12),
  latestSkippedId: normalizeString(nextState.latestSkipped?.id),
  pending: nextState.pending
}, null, 2));
