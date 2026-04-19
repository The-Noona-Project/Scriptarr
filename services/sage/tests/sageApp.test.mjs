/**
 * @file Scriptarr Sage module: services/sage/tests/sageApp.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.NODE_ENV = "test";
process.env.SCRIPTARR_VAULT_DRIVER = "memory";
process.env.SCRIPTARR_SERVICE_TOKENS = JSON.stringify({"scriptarr-sage": "sage-dev-token"});
process.env.SCRIPTARR_SERVICE_TOKEN = "sage-dev-token";
process.env.SUPERUSER_ID = "owner-1";

const {createVaultApp} = await import("../../vault/lib/createVaultApp.mjs");
const {createSageApp} = await import("../lib/createSageApp.mjs");

const originalFetch = globalThis.fetch;

const defaultLibraryTitle = Object.freeze({
  id: "dan-da-dan",
  title: "Dandadan",
  mediaType: "manga",
  status: "watching",
  latestChapter: "166",
  coverAccent: "#ff6a3d",
  summary: "Aliens and yokai.",
  releaseLabel: "2021",
  chapterCount: 166,
  chaptersDownloaded: 6,
  author: "Yukinobu Tatsu",
  tags: ["action"],
  aliases: ["Dan Da Dan"],
  metadataProvider: "mangadex",
  metadataMatchedAt: "2026-04-18T00:00:00.000Z",
  relations: [],
  chapters: [{
    id: "dandadan-c166",
    label: "Chapter 166",
    chapterNumber: "166",
    pageCount: 16,
    releaseDate: "2026-04-14",
    available: true
  }]
});

/**
 * Create a small dependency stub for Sage's Raven, Warden, Portal, and Oracle
 * calls so the Moon v3 broker routes can be tested in isolation.
 *
 * @param {{libraryTitles?: Array<Record<string, unknown>>}} [options]
 * @returns {Promise<{server: http.Server, calls: Record<string, number>}>}
 */
const createDependencyStub = ({libraryTitles = [defaultLibraryTitle]} = {}) => {
  const calls = {
    health: 0,
    bootstrap: 0,
    runtime: 0
  };
  const libraryById = new Map(libraryTitles.map((title) => [title.id, title]));

  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      calls.health += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({ok: true, service: "scriptarr-warden-health", dockerSocketAvailable: true}));
      return;
    }

    if (request.url === "/api/bootstrap") {
      calls.bootstrap += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        services: [{name: "scriptarr-moon", image: "scriptarr-moon:latest", containerName: "scriptarr-moon"}],
        managedNetworkName: "scriptarr-network-bootstrap",
        mysql: {
          mode: "external"
        }
      }));
      return;
    }

    if (request.url === "/api/runtime") {
      calls.runtime += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        stackMode: "test",
        managedNetworkName: "scriptarr-network-runtime",
        mysql: {
          mode: "selfhost"
        },
        warden: {
          dockerSocketAvailable: true,
          attachedToManagedNetwork: true
        }
      }));
      return;
    }

    if (request.url === "/v1/library") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({titles: libraryTitles}));
      return;
    }

    if (request.url?.startsWith("/v1/library/")) {
      const titleId = decodeURIComponent(String(request.url).replace("/v1/library/", ""));
      const title = libraryById.get(titleId);
      if (!title) {
        response.writeHead(404, {"Content-Type": "application/json"});
        response.end(JSON.stringify({error: "Title not found."}));
        return;
      }
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify(title));
      return;
    }

    if (request.url === "/v1/downloads/tasks") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify([]));
      return;
    }

    if (request.url === "/api/localai/status") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({installed: false, running: false}));
      return;
    }

    response.writeHead(404, {"Content-Type": "application/json"});
    response.end(JSON.stringify({error: "Not found"}));
  });

  return Promise.resolve({server, calls});
};

const installDiscordFetchStub = () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);

    if (url === "https://discord.com/api/oauth2/token") {
      return new Response(JSON.stringify({access_token: "discord-access-token"}), {
        status: 200,
        headers: {"Content-Type": "application/json"}
      });
    }

    if (url === "https://discord.com/api/users/@me") {
      return new Response(JSON.stringify({
        id: "owner-1",
        username: "Owner",
        global_name: "Owner",
        avatar: null
      }), {
        status: 200,
        headers: {"Content-Type": "application/json"}
      });
    }

    return originalFetch(input, init);
  };
};

const restoreFetch = () => {
  globalThis.fetch = originalFetch;
};

const signInViaDiscord = async (baseUrl) =>
  fetch(`${baseUrl}/api/auth/discord/callback?code=test-oauth-code`).then((response) => response.json());

test.afterEach(() => {
  restoreFetch();
});

test("sage signs in the first owner through the Discord callback and moderates requests", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub();
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);

  assert.ok(ownerClaim.token);
  assert.equal(ownerClaim.user.role, "owner");

  const request = await fetch(`${baseUrl}/api/requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      title: "Dandadan",
      requestType: "manga",
      notes: "Need the latest chapters."
    })
  }).then((response) => response.json());

  assert.equal(request.status, "pending");

  const reviewed = await fetch(`${baseUrl}/api/admin/requests/${request.id}/review`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      status: "approved",
      comment: "Sent to Raven after moderation."
    })
  }).then((response) => response.json());

  assert.equal(reviewed.status, "approved");

  const oracleSettings = await fetch(`${baseUrl}/api/admin/settings/oracle`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(oracleSettings.provider, "openai");
  assert.equal(oracleSettings.enabled, false);

  const moonLibrary = await fetch(`${baseUrl}/api/moon-v3/user/library`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(moonLibrary.titles[0].title, "Dandadan");

  const overview = await fetch(`${baseUrl}/api/moon-v3/admin/overview`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(overview.counts.titles, 1);

  const adminStatus = await fetch(`${baseUrl}/api/admin/status`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(adminStatus.services.warden.service, "scriptarr-warden-health");
  assert.equal(adminStatus.summaries.warden.bootstrap.managedNetworkName, "scriptarr-network-bootstrap");
  assert.equal(adminStatus.summaries.warden.runtime.managedNetworkName, "scriptarr-network-runtime");

  const progress = await fetch(`${baseUrl}/api/reader/progress`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      mediaId: "dan-da-dan",
      chapterLabel: "Chapter 166",
      positionRatio: 0.5,
      bookmark: {
        chapterId: "dandadan-c166",
        pageIndex: 8
      }
    })
  }).then((response) => response.json());

  assert.equal(progress.mediaId, "dan-da-dan");

  const systemStatus = await fetch(`${baseUrl}/api/moon-v3/admin/system/status`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(systemStatus.services.warden.service, "scriptarr-warden-health");
  assert.equal(systemStatus.bootstrap.managedNetworkName, "scriptarr-network-bootstrap");
  assert.equal(systemStatus.runtime.managedNetworkName, "scriptarr-network-runtime");
  assert.equal(systemStatus.runtime.mysql.mode, "selfhost");

  const home = await fetch(`${baseUrl}/api/moon-v3/user/home`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(home.continueReading[0].titleId, "dan-da-dan");
  assert.equal(home.continueReading[0].title, "Dandadan");
  assert.equal(home.continueReading[0].coverAccent, "#ff6a3d");
  assert.equal(home.continueReading[0].bookmark.chapterId, "dandadan-c166");
  assert.ok(dependencyStub.calls.health >= 1);
  assert.ok(dependencyStub.calls.bootstrap >= 1);
  assert.ok(dependencyStub.calls.runtime >= 1);

  sageServer.close();
  vaultServer.close();
  dependencyStub.server.close();
});

test("sage keeps Moon library routes empty when Raven has no imported titles", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: []});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);

  const headers = {
    "Authorization": `Bearer ${ownerClaim.token}`
  };

  const legacyLibrary = await fetch(`${baseUrl}/api/library`, {headers}).then((response) => response.json());
  assert.deepEqual(legacyLibrary.library, []);

  const moonLibrary = await fetch(`${baseUrl}/api/moon-v3/user/library`, {headers}).then((response) => response.json());
  assert.deepEqual(moonLibrary, {titles: []});

  const overview = await fetch(`${baseUrl}/api/moon-v3/admin/overview`, {headers}).then((response) => response.json());
  assert.equal(overview.counts.titles, 0);
  assert.equal(overview.counts.missingChapters, 0);
  assert.equal(overview.counts.metadataGaps, 0);

  sageServer.close();
  vaultServer.close();
  dependencyStub.server.close();
});

test("sage no longer exposes a dev-session claim endpoint", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub();
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const response = await fetch(`http://127.0.0.1:${sagePort}/api/auth/claim`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({discordUserId: "owner-1"})
  });

  assert.equal(response.status, 404);

  sageServer.close();
  vaultServer.close();
  dependencyStub.server.close();
});

