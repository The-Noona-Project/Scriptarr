/**
 * @file One-time repair helper for GitHub update digests posted with degraded AI fallback copy.
 */
import {resolveSageConfig} from "../lib/config.mjs";
import {createVaultClient} from "../lib/vaultClient.mjs";
import {
  GITHUB_UPDATE_DIGEST_SETTING_KEY,
  isUsableGithubUpdateSummary,
  normalizeGithubUpdateDigestState
} from "../lib/githubUpdateDigest.mjs";

const DEFAULT_TARGET_ID = "update:91b74e545b0f";

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

const applyRepair = process.argv.includes("--apply");
const targetId = readOption("notification-id", DEFAULT_TARGET_ID);
const config = resolveSageConfig();
const vaultClient = createVaultClient(config);
const setting = await vaultClient.getSetting(GITHUB_UPDATE_DIGEST_SETTING_KEY);
const state = normalizeGithubUpdateDigestState(setting?.value);
const latestPosted = state.latestPosted && typeof state.latestPosted === "object" ? state.latestPosted : null;
const latestId = normalizeString(latestPosted?.id);
const latestSummary = normalizeString(latestPosted?.summary);

if (!latestPosted || latestId !== targetId) {
  console.log(JSON.stringify({
    changed: false,
    applied: applyRepair,
    reason: "target-not-latest-posted",
    targetId,
    latestPostedId: latestId
  }, null, 2));
  process.exit(0);
}

if (isUsableGithubUpdateSummary(latestSummary, latestPosted)) {
  console.log(JSON.stringify({
    changed: false,
    applied: applyRepair,
    reason: "latest-posted-summary-is-usable",
    targetId
  }, null, 2));
  process.exit(0);
}

const repairedAt = new Date().toISOString();
const {postedAt: _postedAt, ...pendingSource} = latestPosted;
const pending = {
  ...pendingSource,
  status: "pending-summary",
  summary: "",
  error: "Previous update announcement used degraded Oracle fallback copy; waiting for a real AI summary.",
  retryCount: Number.parseInt(String(latestPosted.retryCount || 0), 10) + 1,
  updatedAt: repairedAt
};
const nextState = {
  ...state,
  lastPostedSha: normalizeString(latestPosted.baseFullSha) || normalizeString(latestPosted.baseSha) || normalizeString(state.lastSeenSha),
  lastPostedAt: "",
  latestPosted: null,
  pending,
  updatedAt: repairedAt
};

if (applyRepair) {
  await vaultClient.setSetting(GITHUB_UPDATE_DIGEST_SETTING_KEY, nextState);
}

console.log(JSON.stringify({
  changed: true,
  applied: applyRepair,
  notificationId: targetId,
  pendingStatus: pending.status,
  lastPostedSha: nextState.lastPostedSha.slice(0, 12)
}, null, 2));
