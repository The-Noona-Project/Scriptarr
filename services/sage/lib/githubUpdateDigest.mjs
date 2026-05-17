/**
 * @file GitHub commit digest creation for Noona Discord update posts.
 */

export const GITHUB_UPDATE_DIGEST_SETTING_KEY = "portal.githubUpdateDigest";

export const GITHUB_UPDATE_REPOSITORY = Object.freeze({
  owner: "The-Noona-Project",
  repo: "Scriptarr"
});

const MAX_COMMITS_PER_DIGEST = 8;

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};
const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
const nowIso = () => new Date().toISOString();

const shortSha = (value) => normalizeString(value).slice(0, 12);

const updateNotificationId = (sha) => `update:${shortSha(sha)}`;

const FALLBACK_SUMMARY_PATTERNS = Object.freeze([
  /read-only fallback mode/i,
  /currently off/i,
  /api key (has not been set|is not configured)/i,
  /configured for openai, but the api key/i,
  /add an openai api key or switch to localai/i,
  /\b(localai|openai|oracle|ai provider)\b.*\b(unavailable|disabled|not configured|quiet|off)\b/i,
  /\b(unavailable|disabled|not configured|quiet|off)\b.*\b(localai|openai|oracle|ai provider)\b/i
]);

/**
 * Decide whether an Oracle reply is a real Noona update summary rather than
 * degraded provider copy that should stay queued for retry.
 *
 * @param {string} summary
 * @param {Record<string, unknown>} payload
 * @returns {boolean}
 */
export const isUsableGithubUpdateSummary = (summary, payload = {}) => {
  const normalized = normalizeString(summary);
  if (!normalized || payload?.degraded === true || payload?.disabled === true) {
    return false;
  }
  return !FALLBACK_SUMMARY_PATTERNS.some((pattern) => pattern.test(normalized));
};

/**
 * Normalize the durable update digest setting stored in Vault.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export const normalizeGithubUpdateDigestState = (value = {}) => {
  const source = normalizeObject(value, {}) || {};
  return {
    key: GITHUB_UPDATE_DIGEST_SETTING_KEY,
    repository: {
      owner: normalizeString(source.repository?.owner, GITHUB_UPDATE_REPOSITORY.owner),
      repo: normalizeString(source.repository?.repo, GITHUB_UPDATE_REPOSITORY.repo),
      branch: normalizeString(source.repository?.branch)
    },
    lastCheckedAt: normalizeString(source.lastCheckedAt),
    lastSeenSha: normalizeString(source.lastSeenSha),
    lastPostedSha: normalizeString(source.lastPostedSha),
    lastPostedAt: normalizeString(source.lastPostedAt),
    pending: normalizeObject(source.pending, null),
    latestPosted: normalizeObject(source.latestPosted, null),
    updatedAt: normalizeString(source.updatedAt)
  };
};

const readDigestState = async (vaultClient) =>
  normalizeGithubUpdateDigestState((await vaultClient.getSetting(GITHUB_UPDATE_DIGEST_SETTING_KEY))?.value);

const writeDigestState = async (vaultClient, state) =>
  vaultClient.setSetting(GITHUB_UPDATE_DIGEST_SETTING_KEY, {
    ...normalizeGithubUpdateDigestState(state),
    key: GITHUB_UPDATE_DIGEST_SETTING_KEY,
    updatedAt: nowIso()
  });

const fetchGithubJson = async ({fetchImpl, token, path}) => {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "Scriptarr-Sage",
      ...(token ? {"Authorization": `Bearer ${token}`} : {})
    },
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = normalizeString(payload?.message, `GitHub returned ${response.status}.`);
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
};

const toCommitDigestRow = (entry = {}) => {
  const fullSha = normalizeString(entry.sha);
  const commit = normalizeObject(entry.commit, {}) || {};
  const author = normalizeObject(commit.author, {}) || {};
  const githubAuthor = normalizeObject(entry.author, {}) || {};
  const title = normalizeString(commit.message).split(/\r?\n/g)[0]?.trim() || "Untitled commit";
  return {
    sha: shortSha(fullSha),
    fullSha,
    title: title.slice(0, 180),
    author: normalizeString(githubAuthor.login, normalizeString(author.name, "Unknown")),
    date: normalizeString(author.date),
    url: normalizeString(entry.html_url)
  };
};

const fetchDefaultBranch = async ({fetchImpl, token}) => {
  const repo = await fetchGithubJson({
    fetchImpl,
    token,
    path: `/repos/${encodeURIComponent(GITHUB_UPDATE_REPOSITORY.owner)}/${encodeURIComponent(GITHUB_UPDATE_REPOSITORY.repo)}`
  });
  return normalizeString(repo.default_branch, "main");
};

const fetchLatestCommit = async ({fetchImpl, token, branch}) => {
  const commits = await fetchGithubJson({
    fetchImpl,
    token,
    path: `/repos/${encodeURIComponent(GITHUB_UPDATE_REPOSITORY.owner)}/${encodeURIComponent(GITHUB_UPDATE_REPOSITORY.repo)}/commits?sha=${encodeURIComponent(branch)}&per_page=1`
  });
  return toCommitDigestRow(normalizeArray(commits)[0]);
};

const fetchCommitsSince = async ({fetchImpl, token, branch, baselineSha}) => {
  const compare = await fetchGithubJson({
    fetchImpl,
    token,
    path: `/repos/${encodeURIComponent(GITHUB_UPDATE_REPOSITORY.owner)}/${encodeURIComponent(GITHUB_UPDATE_REPOSITORY.repo)}/compare/${encodeURIComponent(baselineSha)}...${encodeURIComponent(branch)}`
  });
  const commits = normalizeArray(compare.commits).slice(-MAX_COMMITS_PER_DIGEST).map(toCommitDigestRow);
  return {
    commits,
    aheadBy: Number.parseInt(String(compare.ahead_by || commits.length), 10) || commits.length,
    compareUrl: normalizeString(compare.html_url),
    truncated: normalizeArray(compare.commits).length > MAX_COMMITS_PER_DIGEST
  };
};

const buildOracleMessage = ({branch, baseSha, compareUrl, commits, truncated}) => [
  "Write a public Discord update announcement as Noona, Scriptarr's warm Big Sister AI. Keep it under 900 characters.",
  "Use 3 short bullets: what changed, how to use it, and that people can ask Noona follow-up questions.",
  "Do not invent features beyond the commit titles. Do not mention secrets, private infrastructure, or internal logs.",
  `Repository: ${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}`,
  `Branch: ${branch}`,
  `Base SHA: ${shortSha(baseSha)}`,
  `Compare: ${compareUrl}`,
  truncated ? `Note: this digest includes the newest ${MAX_COMMITS_PER_DIGEST} commits from a larger range.` : "",
  "Commits:",
  ...commits.map((commit, index) => `${index + 1}. ${commit.sha} ${commit.title} (${commit.author}, ${commit.date})`)
].filter(Boolean).join("\n");

const requestOracleSummary = async ({config, serviceJson, branch, baseSha, compareUrl, commits, truncated}) => {
  const result = await serviceJson(config.oracleBaseUrl, "/api/chat", {
    method: "POST",
      timeoutMs: 240000,
    body: {
      message: buildOracleMessage({branch, baseSha, compareUrl, commits, truncated}),
      context: {
        source: "github-update-check",
        personaStyle: "Noona is warm, playful, and clear. For update summaries, she is practical and explains how to use what changed.",
        repository: GITHUB_UPDATE_REPOSITORY,
        branch,
        compareUrl
      }
    }
  });
  const reply = normalizeString(result?.payload?.reply || result?.payload?.text || result?.payload?.summary);
  if (!result?.ok) {
    throw new Error(normalizeString(result?.payload?.error, "Oracle did not return an update summary."));
  }
  if (!isUsableGithubUpdateSummary(reply, normalizeObject(result?.payload, {}) || {})) {
    throw new Error("Oracle update summary is not ready.");
  }
  return reply.slice(0, 1800);
};

const toPendingDigest = ({
  status,
  branch,
  baseSha,
  latestSha,
  compareUrl,
  commits,
  aheadBy,
  truncated,
  summary = "",
  error = "",
  previousPending = null
}) => {
  const previousAttempts = Number.parseInt(String(previousPending?.retryCount || 0), 10) || 0;
  const createdAt = normalizeString(previousPending?.createdAt, nowIso());
  return {
    id: updateNotificationId(latestSha),
    status,
    repository: `${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}`,
    branch,
    baseSha: shortSha(baseSha),
    baseFullSha: normalizeString(baseSha),
    latestSha: shortSha(latestSha),
    latestFullSha: normalizeString(latestSha),
    compareUrl,
    commitCount: commits.length,
    aheadBy,
    truncated: Boolean(truncated),
    commits,
    summary,
    error,
    retryCount: error ? previousAttempts + 1 : previousAttempts,
    createdAt,
    updatedAt: nowIso()
  };
};

/**
 * Create the Sage-side GitHub update digest service.
 *
 * @param {{
 *   config: Record<string, unknown>,
 *   vaultClient: {getSetting: Function, setSetting: Function},
 *   serviceJson: Function,
 *   fetchImpl?: typeof fetch,
 *   token?: string,
 *   logger?: {warn?: Function}
 * }} options
 * @returns {{checkForNewCommits: () => Promise<Record<string, unknown>>}}
 */
export const createGithubUpdateDigestService = ({
  config,
  vaultClient,
  serviceJson,
  fetchImpl = globalThis.fetch,
  token = process.env.SCRIPTARR_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "",
  logger
}) => {
  const checkForNewCommits = async () => {
    const checkedAt = nowIso();
    const state = await readDigestState(vaultClient);
    const branch = await fetchDefaultBranch({fetchImpl, token});
    const existingPending = normalizeObject(state.pending, null);
    if (
      existingPending?.status === "ready"
      && normalizeString(existingPending.latestSha)
      && normalizeString(existingPending.summary)
    ) {
      await writeDigestState(vaultClient, {
        ...state,
        repository: {
          ...state.repository,
          branch
        },
        lastCheckedAt: checkedAt,
        pending: existingPending
      });
      return {
        status: "ready",
        notificationId: existingPending.id,
        commitCount: existingPending.commitCount,
        message: "Existing GitHub update digest is waiting for Discord delivery."
      };
    }
    const baselineSha = normalizeString(
      state.lastPostedSha,
      normalizeString(existingPending?.baseFullSha, normalizeString(existingPending?.baseSha, normalizeString(state.lastSeenSha)))
    );

    if (!baselineSha && !normalizeObject(state.pending, null)) {
      const latest = await fetchLatestCommit({fetchImpl, token, branch});
      await writeDigestState(vaultClient, {
        ...state,
        repository: {
          ...state.repository,
          branch
        },
        lastCheckedAt: checkedAt,
        lastSeenSha: normalizeString(latest.fullSha || latest.sha),
        pending: null
      });
      return {
        status: "initialized",
        repository: `${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}`,
        branch,
        latestSha: latest.sha,
        message: "Initialized GitHub update baseline."
      };
    }

    let comparison = baselineSha
      ? await fetchCommitsSince({fetchImpl, token, branch, baselineSha})
      : {
        commits: normalizeArray(state.pending?.commits),
        aheadBy: Number.parseInt(String(state.pending?.aheadBy || state.pending?.commitCount || 0), 10) || 0,
        compareUrl: normalizeString(state.pending?.compareUrl),
        truncated: Boolean(state.pending?.truncated)
      };

    if (!comparison.commits.length && existingPending?.status === "pending-summary" && normalizeArray(existingPending.commits).length) {
      comparison = {
        commits: normalizeArray(existingPending.commits),
        aheadBy: Number.parseInt(String(existingPending.aheadBy || existingPending.commitCount || 0), 10) || 0,
        compareUrl: normalizeString(existingPending.compareUrl),
        truncated: Boolean(existingPending.truncated)
      };
    }

    if (!comparison.commits.length) {
      await writeDigestState(vaultClient, {
        ...state,
        repository: {
          ...state.repository,
          branch
        },
        lastCheckedAt: checkedAt,
        pending: null
      });
      return {
        status: "current",
        repository: `${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}`,
        branch,
        message: "No unposted GitHub commits found."
      };
    }

    const latestCommit = comparison.commits[comparison.commits.length - 1];
    const latestFullSha = normalizeString(latestCommit.fullSha, latestCommit.sha);
    try {
      const summary = await requestOracleSummary({
        config,
        serviceJson,
        branch,
        baseSha: baselineSha || existingPending?.baseSha,
        compareUrl: comparison.compareUrl,
        commits: comparison.commits,
        truncated: comparison.truncated
      });
      const pending = toPendingDigest({
        status: "ready",
        branch,
        baseSha: baselineSha || existingPending?.baseSha,
        latestSha: latestFullSha,
        compareUrl: comparison.compareUrl,
        commits: comparison.commits,
        aheadBy: comparison.aheadBy,
        truncated: comparison.truncated,
        summary,
        previousPending: existingPending
      });
      await writeDigestState(vaultClient, {
        ...state,
        repository: {
          ...state.repository,
          branch
        },
        lastCheckedAt: checkedAt,
        pending
      });
      return {
        status: "ready",
        notificationId: pending.id,
        commitCount: pending.commitCount,
        compareUrl: pending.compareUrl,
        message: "GitHub update digest is ready for Discord delivery."
      };
    } catch (error) {
      const pending = toPendingDigest({
        status: "pending-summary",
        branch,
        baseSha: baselineSha || existingPending?.baseSha,
        latestSha: latestFullSha,
        compareUrl: comparison.compareUrl,
        commits: comparison.commits,
        aheadBy: comparison.aheadBy,
        truncated: comparison.truncated,
        error: error instanceof Error ? error.message : String(error),
        previousPending: existingPending
      });
      await writeDigestState(vaultClient, {
        ...state,
        repository: {
          ...state.repository,
          branch
        },
        lastCheckedAt: checkedAt,
        pending
      });
      logger?.warn?.("GitHub update digest summary is pending Oracle retry.", {error});
      return {
        status: "pending-summary",
        notificationId: pending.id,
        commitCount: pending.commitCount,
        error: pending.error,
        message: "GitHub update commits were found, but the AI summary is queued for retry."
      };
    }
  };

  return {checkForNewCommits};
};

export default {
  GITHUB_UPDATE_DIGEST_SETTING_KEY,
  GITHUB_UPDATE_REPOSITORY,
  createGithubUpdateDigestService,
  isUsableGithubUpdateSummary,
  normalizeGithubUpdateDigestState
};
