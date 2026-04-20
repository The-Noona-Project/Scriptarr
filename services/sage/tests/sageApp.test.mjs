/**
 * @file Scriptarr Sage module: services/sage/tests/sageApp.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.NODE_ENV = "test";
process.env.SCRIPTARR_VAULT_DRIVER = "memory";
process.env.SCRIPTARR_SERVICE_TOKENS = JSON.stringify({
  "scriptarr-sage": "sage-dev-token",
  "scriptarr-portal": "portal-dev-token",
  "scriptarr-oracle": "oracle-dev-token",
  "scriptarr-raven": "raven-dev-token",
  "scriptarr-warden": "warden-dev-token"
});
process.env.SCRIPTARR_SERVICE_TOKEN = "sage-dev-token";
process.env.SUPERUSER_ID = "owner-1";

const {createVaultApp} = await import("../../vault/lib/createVaultApp.mjs");
const {createSageApp} = await import("../lib/createSageApp.mjs");

const originalFetch = globalThis.fetch;

const closeServer = (server) => new Promise((resolve, reject) => {
  server?.closeIdleConnections?.();
  server?.closeAllConnections?.();
  server?.close((error) => error ? reject(error) : resolve());
});

const defaultLibraryTitle = Object.freeze({
  id: "dan-da-dan",
  title: "Dandadan",
  mediaType: "webtoon",
  libraryTypeLabel: "Webtoon",
  libraryTypeSlug: "webtoon",
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
    pageCount: 3,
    releaseDate: "2026-04-14",
    available: true
  }, {
    id: "dandadan-c167",
    label: "Chapter 167",
    chapterNumber: "167",
    pageCount: 2,
    releaseDate: "2026-04-21",
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
    runtime: 0,
    queue: 0,
    bulkQueue: 0
  };
  const libraryById = new Map(libraryTitles.map((title) => [title.id, title]));
  const buildReaderManifest = (title) => ({
    title,
    chapters: title.chapters || []
  });
  const buildReaderChapterPayload = (title, chapterId) => {
    const chapters = title.chapters || [];
    const chapterIndex = chapters.findIndex((entry) => entry.id === chapterId);
    const chapter = chapters[chapterIndex];

    if (!chapter) {
      return null;
    }

    return {
      title,
      chapter,
      previousChapterId: chapters[chapterIndex - 1]?.id || null,
      nextChapterId: chapters[chapterIndex + 1]?.id || null,
      pages: Array.from({length: chapter.pageCount || 1}, (_value, index) => ({
        index,
        label: `Page ${index + 1}`,
        src: `https://reader.invalid/${title.id}/${chapter.id}/${index}.svg`
      }))
    };
  };

  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      calls.health += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({ok: true, service: "scriptarr-warden-health", dockerSocketAvailable: true}));
      return;
    }

    if (request.url === "/api/commands") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        commands: [
          {name: "ding", description: "Bot health"},
          {name: "request", description: "Create a request"},
          {name: "subscribe", description: "Follow a title"}
        ]
      }));
      return;
    }

    if (request.url === "/api/runtime/discord/reload" && request.method === "POST") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        ok: true,
        mode: "ready",
        connected: true,
        registeredGuildId: "guild-123"
      }));
      return;
    }

    if (request.url === "/api/onboarding/test" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body || "{}");
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          ok: true,
          channelId: payload?.settings?.onboarding?.channelId || "",
          rendered: payload?.rendered || "Welcome to Scriptarr, CaptainPax!"
        }));
      });
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

    if (request.url === "/api/status") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        ok: true,
        source: "oracle-status-broker"
      }));
      return;
    }

    if (request.url === "/api/chat" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          ok: true,
          reply: `stubbed:${JSON.parse(body || "{}").message || ""}`
        }));
      });
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

    if (request.url?.startsWith("/v1/reader/") && !request.url.includes("/page/")) {
      const parts = String(request.url).split("/").filter(Boolean);
      const titleId = decodeURIComponent(parts[2] || "");
      const chapterId = parts[3] ? decodeURIComponent(parts[3]) : "";
      const title = libraryById.get(titleId);

      if (!title) {
        response.writeHead(404, {"Content-Type": "application/json"});
        response.end(JSON.stringify({error: "Title not found."}));
        return;
      }

      if (!chapterId) {
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify(buildReaderManifest(title)));
        return;
      }

      const payload = buildReaderChapterPayload(title, chapterId);
      if (!payload) {
        response.writeHead(404, {"Content-Type": "application/json"});
        response.end(JSON.stringify({error: "Chapter not found."}));
        return;
      }

      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify(payload));
      return;
    }

    if (request.url?.startsWith("/v1/reader/") && request.url.includes("/page/")) {
      response.writeHead(200, {"Content-Type": "image/svg+xml"});
      response.end("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>reader-page</text></svg>");
      return;
    }

    if (request.url === "/v1/downloads/tasks") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify([]));
      return;
    }

    if (request.url?.startsWith("/v1/intake/search?query=")) {
      const query = new URL(`http://stub${request.url}`).searchParams.get("query") || "";
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        query,
        results: [{
          metadataProviderId: "mangadex",
          providerSeriesId: "md-1",
          canonicalTitle: "Dandadan",
          aliases: ["Dan Da Dan"],
          type: "webtoon",
          metadata: {
            provider: "mangadex",
            providerSeriesId: "md-1",
            title: "Dandadan",
            summary: "Aliens and yokai.",
            aliases: ["Dan Da Dan"],
            type: "webtoon"
          },
          download: {
            providerId: "weebcentral",
            providerName: "WeebCentral",
            titleName: "Dandadan",
            titleUrl: "https://weebcentral.com/series/dan-da-dan",
            requestType: "webtoon",
            libraryTypeLabel: "Webtoon",
            libraryTypeSlug: "webtoon"
          },
          availability: "available",
          titleUrl: "https://weebcentral.com/series/dan-da-dan"
        }]
      }));
      return;
    }

    if (request.url === "/v1/downloads/queue" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        calls.queue += 1;
        const payload = JSON.parse(body || "{}");
        response.writeHead(202, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          taskId: "task-queued-1",
          jobId: "job-queued-1",
          status: "queued",
          titleName: payload.titleName,
          titleUrl: payload.titleUrl,
          requestId: payload.requestId || ""
        }));
      });
      return;
    }

    if (request.url === "/v1/downloads/bulk-queue" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        calls.bulkQueue += 1;
        const payload = JSON.parse(body || "{}");
        response.writeHead(202, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          status: "queued",
          message: "Queued 1 title(s) for download.",
          filters: {
            type: payload.type || "",
            nsfw: payload.nsfw === true,
            titlePrefix: payload.titlePrefix || ""
          },
          pagesScanned: 1,
          matchedCount: 1,
          queuedCount: 1,
          skippedActiveCount: 0,
          failedCount: 0,
          queuedTitles: ["Dandadan"],
          skippedActiveTitles: [],
          failedTitles: []
        }));
      });
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
      query: "dandadan",
      requestType: "webtoon",
      notes: "Need the latest chapters.",
      selectedMetadata: {
        provider: "mangadex",
        providerSeriesId: "md-1",
        title: "Dandadan"
      },
      selectedDownload: {
        providerId: "weebcentral",
        titleName: "Dandadan",
        titleUrl: "https://weebcentral.com/series/dan-da-dan",
        requestType: "webtoon"
      }
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

  assert.equal(reviewed.status, "queued");
  assert.equal(reviewed.details.selectedDownload.providerId, "weebcentral");
  assert.equal(dependencyStub.calls.queue, 1);

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

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
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

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage round-trips Moon branding and exposes typed Moon reader payloads", async () => {
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
  const headers = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };

  const initialBranding = await fetch(`${baseUrl}/api/admin/settings/moon/branding`, {
    headers
  }).then((response) => response.json());
  assert.equal(initialBranding.siteName, "Scriptarr");

  const savedBrandingResponse = await fetch(`${baseUrl}/api/admin/settings/moon/branding`, {
    method: "PUT",
    headers,
    body: JSON.stringify({siteName: "  Pax Library  "})
  });
  const savedBranding = await savedBrandingResponse.json();

  assert.equal(savedBrandingResponse.status, 200);
  assert.equal(savedBranding.siteName, "Pax Library");

  const publicBranding = await fetch(`${baseUrl}/api/moon-v3/public/branding`).then((response) => response.json());
  assert.equal(publicBranding.siteName, "Pax Library");

  const aggregatedSettings = await fetch(`${baseUrl}/api/moon-v3/admin/settings`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(aggregatedSettings.branding.siteName, "Pax Library");

  const moonLibrary = await fetch(`${baseUrl}/api/moon-v3/user/library`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(moonLibrary.titles[0].libraryTypeSlug, "webtoon");
  assert.equal(moonLibrary.titles[0].libraryTypeLabel, "Webtoon");

  const titleDetail = await fetch(`${baseUrl}/api/moon-v3/user/title/dan-da-dan`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(titleDetail.title.libraryTypeSlug, "webtoon");
  assert.equal(titleDetail.title.libraryTypeLabel, "Webtoon");

  const followResponse = await fetch(`${baseUrl}/api/moon-v3/user/following`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      titleId: "dan-da-dan",
      title: "Dandadan",
      latestChapter: "166",
      mediaType: "webtoon",
      libraryTypeLabel: "Webtoon",
      libraryTypeSlug: "webtoon"
    })
  });
  assert.equal(followResponse.status, 201);

  const following = await fetch(`${baseUrl}/api/moon-v3/user/following`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(following.following[0].libraryTypeSlug, "webtoon");
  assert.equal(following.following[0].libraryTypeLabel, "Webtoon");

  const readerManifest = await fetch(`${baseUrl}/api/moon-v3/user/reader/title/dan-da-dan`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(readerManifest.title.libraryTypeSlug, "webtoon");
  assert.equal(readerManifest.title.libraryTypeLabel, "Webtoon");

  const readerChapter = await fetch(`${baseUrl}/api/moon-v3/user/reader/title/dan-da-dan/chapter/dandadan-c166`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(readerChapter.title.libraryTypeSlug, "webtoon");
  assert.equal(readerChapter.title.libraryTypeLabel, "Webtoon");
  assert.equal(readerChapter.manifest.title.libraryTypeSlug, "webtoon");
  assert.equal(readerChapter.manifest.title.libraryTypeLabel, "Webtoon");
  assert.equal(readerChapter.preferences.readingMode, "webtoon");
  assert.equal(readerChapter.pages[0].src, "/api/moon/v3/user/reader/title/dan-da-dan/chapter/dandadan-c166/page/0");

  const home = await fetch(`${baseUrl}/api/moon-v3/user/home`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(home.latestTitles[0].libraryTypeSlug, "webtoon");
  assert.equal(home.latestTitles[0].libraryTypeLabel, "Webtoon");

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage round-trips brokered Portal Discord settings and exposes them in admin settings", async () => {
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
  process.env.SCRIPTARR_DISCORD_TOKEN = "discord-bot-token";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const headers = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };

  const savedDiscord = await fetch(`${baseUrl}/api/admin/settings/portal/discord`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      guildId: "guild-123",
      superuserId: "owner-1",
      onboarding: {
        channelId: "channel-456",
        template: "Welcome to {siteName}, {username}!"
      },
      commands: {
        request: {
          enabled: true,
          roleId: "role-request"
        },
        subscribe: {
          enabled: false,
          roleId: "role-sub"
        }
      }
    })
  }).then((response) => response.json());

  assert.equal(savedDiscord.guildId, "guild-123");
  assert.equal(savedDiscord.superuserId, "owner-1");
  assert.equal(savedDiscord.commands.request.roleId, "role-request");
  assert.equal(savedDiscord.commands.subscribe.enabled, false);
  assert.equal(savedDiscord.runtime.authConfigured, true);
  assert.equal(savedDiscord.runtime.botTokenConfigured, true);

  const onboardingPreview = await fetch(`${baseUrl}/api/admin/settings/portal/discord/onboarding/test`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: "CaptainPax"
    })
  }).then((response) => response.json());
  assert.equal(onboardingPreview.rendered, "Welcome to Scriptarr, CaptainPax!");

  const aggregatedSettings = await fetch(`${baseUrl}/api/moon-v3/admin/settings`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(aggregatedSettings.discord.guildId, "guild-123");
  assert.equal(aggregatedSettings.discord.commands.request.roleId, "role-request");

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
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

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage defaults a blank LocalAI model to an AIO-friendly alias", async () => {
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
  const response = await fetch(`${baseUrl}/api/admin/settings/oracle`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      enabled: true,
      provider: "localai",
      model: "",
      localAiProfileKey: "cpu",
      localAiImageMode: "preset",
      localAiCustomImage: ""
    })
  });
  const oracleSettings = await response.json();

  assert.equal(response.status, 200);
  assert.equal(oracleSettings.provider, "localai");
  assert.equal(oracleSettings.model, "gpt-4");

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage brokers service-to-service routes with internal service auth", async () => {
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
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const portalHeaders = {
    "Authorization": "Bearer portal-dev-token",
    "Content-Type": "application/json"
  };
  const oracleHeaders = {
    "Authorization": "Bearer oracle-dev-token",
    "Content-Type": "application/json"
  };
  const ravenHeaders = {
    "Authorization": "Bearer raven-dev-token",
    "Content-Type": "application/json"
  };

  const createdUser = await fetch(`${baseUrl}/api/internal/vault/users/upsert-discord`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      discordUserId: "discord-123",
      username: "Portal User",
      role: "member"
    })
  }).then((response) => response.json());
  assert.equal(createdUser.discordUserId, "discord-123");

  const request = await fetch(`${baseUrl}/api/internal/vault/requests`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      source: "discord",
      title: "The Fable",
      requestType: "manga",
      requestedBy: "discord-123"
    })
  }).then((response) => response.json());
  assert.equal(request.title, "The Fable");

  const portalDiscordConfig = await fetch(`${baseUrl}/api/internal/portal/discord-config`, {
    headers: portalHeaders
  }).then((response) => response.json());
  assert.equal(portalDiscordConfig.discord.guildId, "");
  assert.equal(portalDiscordConfig.commandCatalog.some((entry) => entry.id === "downloadall"), true);

  const librarySearch = await fetch(`${baseUrl}/api/internal/portal/library/search?query=dandadan`, {
    headers: portalHeaders
  }).then((response) => response.json());
  assert.equal(librarySearch.results[0].title, "Dandadan");
  assert.match(librarySearch.results[0].moonTitleUrl, /\/title\/webtoon\/dan-da-dan$/);

  const intakeSearch = await fetch(`${baseUrl}/api/internal/portal/intake/search?query=dandadan`, {
    headers: portalHeaders
  }).then((response) => response.json());
  assert.equal(intakeSearch.results[0].availability, "available");

  const discordRequest = await fetch(`${baseUrl}/api/internal/portal/requests`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      source: "discord",
      requestedBy: "discord-123",
      query: "dandadan",
      selectedMetadata: {
        provider: "mangadex",
        providerSeriesId: "md-1",
        title: "Dandadan"
      },
      selectedDownload: {
        providerId: "weebcentral",
        titleName: "Dandadan",
        titleUrl: "https://weebcentral.com/series/dan-da-dan",
        requestType: "webtoon"
      }
    })
  }).then((response) => response.json());
  assert.equal(discordRequest.status, "pending");
  assert.equal(discordRequest.details.selectedDownload.providerId, "weebcentral");

  const following = await fetch(`${baseUrl}/api/internal/portal/following`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      discordUserId: "discord-123",
      titleId: "dan-da-dan",
      title: "Dandadan",
      latestChapter: "166",
      mediaType: "webtoon",
      libraryTypeLabel: "Webtoon",
      libraryTypeSlug: "webtoon"
    })
  }).then((response) => response.json());
  assert.equal(following.following[0].libraryTypeSlug, "webtoon");

  const bulkQueue = await fetch(`${baseUrl}/api/internal/portal/raven/bulk-queue`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      type: "Manga",
      nsfw: false,
      titlePrefix: "a",
      requestedBy: "owner-1"
    })
  }).then((response) => response.json());
  assert.equal(bulkQueue.status, "queued");
  assert.equal(dependencyStub.calls.bulkQueue, 1);

  const oracleStatus = await fetch(`${baseUrl}/api/internal/warden/bootstrap`, {
    headers: oracleHeaders
  }).then((response) => response.json());
  assert.equal(oracleStatus.managedNetworkName, "scriptarr-network-bootstrap");

  const updatedOracleSettings = await fetch(`${baseUrl}/api/internal/vault/settings/oracle.settings`, {
    method: "PUT",
    headers: {
      "Authorization": "Bearer warden-dev-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      value: {
        provider: "localai",
        model: "gpt-4"
      }
    })
  }).then((response) => response.json());
  assert.equal(updatedOracleSettings.value.provider, "localai");

  const brokeredOracleSettings = await fetch(`${baseUrl}/api/internal/vault/settings/oracle.settings`, {
    headers: {
      "Authorization": "Bearer warden-dev-token"
    }
  }).then((response) => response.json());
  assert.equal(brokeredOracleSettings.value.model, "gpt-4");

  const oracleChat = await fetch(`${baseUrl}/api/internal/oracle/chat`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({message: "hello"})
  }).then((response) => response.json());
  assert.equal(oracleChat.reply, "stubbed:hello");

  const ravenJob = await fetch(`${baseUrl}/api/internal/jobs/raven-job-1`, {
    method: "PUT",
    headers: ravenHeaders,
    body: JSON.stringify({
      kind: "download",
      ownerService: "scriptarr-raven",
      status: "queued",
      label: "Raven download"
    })
  }).then((response) => response.json());
  assert.equal(ravenJob.jobId, "raven-job-1");

  const forbidden = await fetch(`${baseUrl}/api/internal/jobs/raven-job-1`, {
    headers: portalHeaders
  });
  assert.equal(forbidden.status, 403);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

