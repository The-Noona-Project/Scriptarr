/**
 * @file Tests for Sage's GitHub update digest service.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  GITHUB_UPDATE_DIGEST_SETTING_KEY,
  createGithubUpdateDigestService,
  isUsableGithubUpdateSummary
} from "../lib/githubUpdateDigest.mjs";

const createVault = async (initial = {}) => {
  const settings = new Map(Object.entries(initial));
  return {
    async getSetting(key) {
      return settings.has(key) ? {key, value: settings.get(key)} : null;
    },
    async setSetting(key, value) {
      settings.set(key, value);
      return {key, value};
    },
    read(key) {
      return settings.get(key);
    }
  };
};

const createGithubFetch = ({commits = []} = {}) => async (url) => {
  const parsed = new URL(url);
  if (parsed.pathname === "/repos/The-Noona-Project/Scriptarr") {
    return new Response(JSON.stringify({default_branch: "main"}), {
      status: 200,
      headers: {"Content-Type": "application/json"}
    });
  }
  if (parsed.pathname.endsWith("/compare/base-sha...main")) {
    return new Response(JSON.stringify({
      ahead_by: commits.length,
      html_url: "https://github.com/The-Noona-Project/Scriptarr/compare/base-sha...main",
      commits
    }), {
      status: 200,
      headers: {"Content-Type": "application/json"}
    });
  }
  if (parsed.pathname.endsWith("/commits")) {
    return new Response(JSON.stringify(commits.slice(-1)), {
      status: 200,
      headers: {"Content-Type": "application/json"}
    });
  }
  return new Response(JSON.stringify({message: `Unhandled ${parsed.pathname}`}), {
    status: 404,
    headers: {"Content-Type": "application/json"}
  });
};

const commit = (sha, title) => ({
  sha,
  html_url: `https://github.com/The-Noona-Project/Scriptarr/commit/${sha}`,
  author: {login: "Noona"},
  commit: {
    message: `${title}\n\nLonger body should not be stored in the digest title.`,
    author: {
      name: "Noona",
      date: "2026-05-16T00:00:00.000Z"
    }
  }
});

test("GitHub update digest creates an Oracle-backed pending Discord update", async () => {
  const vault = await createVault({
    [GITHUB_UPDATE_DIGEST_SETTING_KEY]: {
      key: GITHUB_UPDATE_DIGEST_SETTING_KEY,
      lastPostedSha: "base-sha"
    }
  });
  const service = createGithubUpdateDigestService({
    config: {oracleBaseUrl: "http://oracle.test"},
    vaultClient: vault,
    fetchImpl: createGithubFetch({
      commits: [
        commit("abc123def4567890", "Add Noona update summaries"),
        commit("def456abc1237890", "Explain updates from Discord")
      ]
    }),
    serviceJson: async (_baseUrl, path, options) => {
      assert.equal(path, "/api/chat");
      assert.match(options.body.message, /Add Noona update summaries/);
      assert.match(options.body.message, /\*\*What changed\*\*/);
      assert.match(options.body.message, /do not include raw SHAs/i);
      assert.doesNotMatch(options.body.message, /1\. abc123def456/);
      return {
        ok: true,
        status: 200,
        payload: {
          reply: [
            "Noona tightened the update lane so Discord posts are clearer for readers and admins.",
            "**What changed**",
            "- Update summaries now stay polished instead of echoing commit rows.",
            "- Discord AI replies get a steadier delivery path.",
            "**Try it**",
            "- Mention Noona if you want the plain-language walkthrough."
          ].join("\n")
        }
      };
    },
    logger: {}
  });

  const result = await service.checkForNewCommits();
  const state = vault.read(GITHUB_UPDATE_DIGEST_SETTING_KEY);

  assert.equal(result.status, "ready");
  assert.equal(result.commitCount, 2);
  assert.equal(state.pending.status, "ready");
  assert.equal(state.pending.id, "update:def456abc123");
  assert.match(state.pending.summary, /\*\*What changed\*\*/);
  assert.equal(state.pending.commits[0].title, "Add Noona update summaries");
});

test("GitHub update digest queues retry state when Oracle cannot summarize", async () => {
  const vault = await createVault({
    [GITHUB_UPDATE_DIGEST_SETTING_KEY]: {
      key: GITHUB_UPDATE_DIGEST_SETTING_KEY,
      lastPostedSha: "base-sha"
    }
  });
  const service = createGithubUpdateDigestService({
    config: {oracleBaseUrl: "http://oracle.test"},
    vaultClient: vault,
    fetchImpl: createGithubFetch({
      commits: [commit("abc123def4567890", "Add retry-safe update digest")]
    }),
    serviceJson: async () => ({
      ok: false,
      status: 503,
      payload: {error: "Oracle unavailable"}
    }),
    logger: {}
  });

  const result = await service.checkForNewCommits();
  const state = vault.read(GITHUB_UPDATE_DIGEST_SETTING_KEY);

  assert.equal(result.status, "pending-summary");
  assert.equal(state.pending.status, "pending-summary");
  assert.equal(state.pending.baseFullSha, "base-sha");
  assert.match(state.pending.error, /Oracle unavailable/);
  assert.equal(state.pending.summary, "");
});

test("GitHub update digest waits when Oracle returns degraded fallback copy", async () => {
  const vault = await createVault({
    [GITHUB_UPDATE_DIGEST_SETTING_KEY]: {
      key: GITHUB_UPDATE_DIGEST_SETTING_KEY,
      lastPostedSha: "base-sha"
    }
  });
  const service = createGithubUpdateDigestService({
    config: {oracleBaseUrl: "http://oracle.test"},
    vaultClient: vault,
    fetchImpl: createGithubFetch({
      commits: [commit("abc123def4567890", "Wait for real Noona update summary")]
    }),
    serviceJson: async () => ({
      ok: true,
      status: 200,
      payload: {
        ok: true,
        degraded: true,
        reply: "Noona is in read-only fallback mode because LocalAI is unavailable right now."
      }
    }),
    logger: {}
  });

  const result = await service.checkForNewCommits();
  const state = vault.read(GITHUB_UPDATE_DIGEST_SETTING_KEY);

  assert.equal(result.status, "pending-summary");
  assert.equal(state.pending.status, "pending-summary");
  assert.equal(state.pending.summary, "");
  assert.match(state.pending.error, /not ready/);
});

test("GitHub update digest waits when Oracle is disabled or returns no summary", async () => {
  for (const payload of [
    {ok: true, disabled: true, reply: "Noona is currently off."},
    {ok: true, reply: ""}
  ]) {
    const vault = await createVault({
      [GITHUB_UPDATE_DIGEST_SETTING_KEY]: {
        key: GITHUB_UPDATE_DIGEST_SETTING_KEY,
        lastPostedSha: "base-sha"
      }
    });
    const service = createGithubUpdateDigestService({
      config: {oracleBaseUrl: "http://oracle.test"},
      vaultClient: vault,
      fetchImpl: createGithubFetch({
        commits: [commit("abc123def4567890", "Wait for usable Noona summary")]
      }),
      serviceJson: async () => ({
        ok: true,
        status: 200,
        payload
      }),
      logger: {}
    });

    const result = await service.checkForNewCommits();
    const state = vault.read(GITHUB_UPDATE_DIGEST_SETTING_KEY);

    assert.equal(result.status, "pending-summary");
    assert.equal(state.pending.status, "pending-summary");
    assert.equal(state.pending.summary, "");
  }
});

test("GitHub update digest retries pending AI summaries without advancing the post baseline", async () => {
  const vault = await createVault({
    [GITHUB_UPDATE_DIGEST_SETTING_KEY]: {
      key: GITHUB_UPDATE_DIGEST_SETTING_KEY,
      lastSeenSha: "base-sha"
    }
  });
  let oracleCalls = 0;
  const service = createGithubUpdateDigestService({
    config: {oracleBaseUrl: "http://oracle.test"},
    vaultClient: vault,
    fetchImpl: createGithubFetch({
      commits: [commit("abc123def4567890", "Retry Noona update summary")]
    }),
    serviceJson: async () => {
      oracleCalls += 1;
      return oracleCalls === 1
        ? {ok: false, status: 503, payload: {error: "Oracle unavailable"}}
        : {
          ok: true,
          status: 200,
          payload: {
            reply: [
              "Noona retried the update summary and kept it tidy for Discord.",
              "**What changed**",
              "- The pending update can post once the AI summary is ready.",
              "**Try it**",
              "- Check the update channel for the polished version."
            ].join("\n")
          }
        };
    },
    logger: {}
  });

  const first = await service.checkForNewCommits();
  const pendingState = vault.read(GITHUB_UPDATE_DIGEST_SETTING_KEY);
  const second = await service.checkForNewCommits();
  const readyState = vault.read(GITHUB_UPDATE_DIGEST_SETTING_KEY);

  assert.equal(first.status, "pending-summary");
  assert.equal(pendingState.lastSeenSha, "base-sha");
  assert.equal(pendingState.pending.status, "pending-summary");
  assert.equal(second.status, "ready");
  assert.equal(oracleCalls, 2);
  assert.equal(readyState.pending.status, "ready");
  assert.match(readyState.pending.summary, /\*\*Try it\*\*/);
});

test("GitHub update digest rejects raw metadata copy as Noona summary", () => {
  assert.equal(
    isUsableGithubUpdateSummary("3. 5d5b5f8d5a9e Add LocalAI chat completion example to README (Captainpax, 2026-05-18T02:11:33Z)"),
    false
  );
  assert.equal(
    isUsableGithubUpdateSummary("To use the new Oracle Cloud GPU support:\n1. Install the Oracle Cloud SDK if needed\n2. Set your Oracle Cloud credentials in Scriptarr settings\n```\nLONG LIVE NOONA"),
    false
  );
  assert.equal(
    isUsableGithubUpdateSummary("Noona here!\n- Reader pages preload more smoothly\n[399/900 chars]"),
    false
  );
  assert.equal(
    isUsableGithubUpdateSummary("Noona tuned the reader buffer. Let me know if you have any questions."),
    false
  );
  assert.equal(
    isUsableGithubUpdateSummary("Updates:\n- Add waiting update guard\n- Fix LocalAI startup"),
    false
  );
  assert.equal(
    isUsableGithubUpdateSummary("**Exciting Scriptarr Update! 🎉**\n**What changed**\n- Reader pages load better\n**Try it**\n- Open the library."),
    false
  );
  assert.equal(
    isUsableGithubUpdateSummary("Noona tuned the reader so pages are ready before you turn them.\n**What changed**\n- Reader pages preload more smoothly.\n**Try it**\n- Open a chapter and turn a page."),
    true
  );
});
