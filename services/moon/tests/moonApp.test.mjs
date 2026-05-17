import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";

process.env.NODE_ENV = "test";

const {createMoonApp} = await import("../lib/createMoonApp.mjs");

const closeServer = (server) => new Promise((resolve, reject) => {
  server?.closeIdleConnections?.();
  server?.closeAllConnections?.();
  server.close((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

/**
 * Start a tiny Sage stub that returns both JSON and raw SVG payloads so Moon's
 * v3 proxy behavior can be exercised without booting the full stack.
 *
 * @returns {Promise<http.Server>}
 */
const createSageStub = ({requests = []} = {}) => Promise.resolve(http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", "http://moon.test");
  const body = await new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  requests.push({
    method: request.method,
    url: request.url,
    apiKey: request.headers["x-scriptarr-api-key"] || "",
    body
  });

  const authorization = request.headers.authorization || "";

  if (requestUrl.pathname === "/api/moon-v3/public/branding") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({siteName: "Pax Library"}));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/user/library") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      titles: [{id: "dan-da-dan", title: "Dandadan", libraryTypeSlug: "webtoon", libraryTypeLabel: "Webtoon"}]
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/user/library/cover/dan-da-dan/source") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      titleId: "dan-da-dan",
      coverRevision: "rev-1",
      coverUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/system/api") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      settings: {enabled: true},
      groups: [{id: "admin", name: "Admin"}],
      systemKeys: [],
      userKeys: [],
      docsUrl: "/api/public/docs",
      openApiUrl: "/api/public/openapi.json"
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/system/ai") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      oracle: {enabled: false, provider: "openai", model: "gpt-4.1-mini", temperature: 0.2},
      tools: {settings: {toggles: {}}, tools: []},
      proposals: []
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/system/ai/runtime") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      oracleHealth: {ok: true},
      oracleStatus: {ok: true, oracle: {enabled: false}},
      localAi: {installed: false, running: false, message: "LocalAI is optional."},
      localAiProfile: {selectedProfile: "cpu", profiles: [{key: "cpu", label: "CPU"}]}
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/system/ai/models") {
    const provider = requestUrl.searchParams.get("provider") === "localai" ? "localai" : "openai";
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      provider,
      selectedModel: provider === "localai" ? "gpt-4" : "gpt-4.1-mini",
      models: [{id: provider === "localai" ? "gpt-4" : "gpt-4.1-mini"}],
      ok: true
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/settings") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      branding: {siteName: "Pax Library", logo: {enabled: false}},
      publicBranding: {siteName: "Pax Library", logo: {enabled: false, urls: {}}},
      ravenVpn: {enabled: false, region: "us_california"},
      metadataProviders: {providers: []},
      downloadProviders: {providers: []},
      ravenDownloadRuntime: {activeTitleDownloads: 2, minActiveTitleDownloads: 1, maxActiveTitleDownloads: 6},
      requestWorkflow: {autoApproveAndDownload: false},
      discord: {guildId: "", superuserId: "", onboarding: {}, runtime: {}},
      toastSettings: {
        global: {actionToasts: true, jobToasts: true, liveEventToasts: true, severities: {info: true, success: true, warning: true, error: true}},
        personal: null,
        effective: {actionToasts: true, jobToasts: true, liveEventToasts: true, severities: {info: true, success: true, warning: true, error: true}},
        canEditGlobal: true
      },
      databaseOverview: {driver: "memory", tableCount: 1, rowCount: 1, totalBytes: 128, tables: [{name: "settings", rowCount: 1, editable: true}]},
      links: {databaseExplorer: "/admin/settings/database"}
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/settings/database") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      driver: "memory",
      database: "memory",
      tableCount: 1,
      rowCount: 1,
      totalBytes: 128,
      generatedAt: "2026-04-26T12:00:00.000Z",
      tables: [{name: "settings", rowCount: 1, editable: true, totalBytes: 128}]
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/settings/raven/vpn/test" && request.method === "POST") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      ok: true,
      vpn: {
        state: "armed",
        enabled: true,
        connected: false,
        protected: false,
        runtimeCapable: true,
        settingsFresh: true,
        region: "us_california"
      }
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/calendar") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      entries: [{
        id: "completed:title-1",
        kind: "title_completed",
        eventDate: "2026-04-21T12:00:00.000Z",
        titleId: "title-1",
        title: "Completed Title",
        titleStatus: "completed",
        libraryTypeSlug: "manga",
        libraryTypeLabel: "Manga",
        titleUrl: "/title/manga/title-1",
        readerUrl: "/reader/manga/title-1/chapter-1"
      }],
      counts: {totalEntries: 1, chapterEntries: 0, completedMarkers: 1, undatedCompletedCount: 0}
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/discord" && request.method === "GET") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      settings: {
        guildId: "guild-1",
        superuserId: "owner-1",
        onboarding: {channelId: "welcome-1", template: "Welcome {user_mention}"},
        notifications: {releaseChannelId: "release-1", updateChannelId: "updates-1"},
        commands: {request: {enabled: true, roleId: "role-1"}}
      },
      runtime: {
        connected: true,
        authConfigured: true,
        botTokenConfigured: true,
        registeredGuildId: "guild-1",
        commandInventory: [{name: "request", label: "/request", registered: true, status: "Registered", roleManaged: true}]
      },
      commandCatalog: [{id: "request", name: "request", description: "Create a request"}]
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/discord" && request.method === "PUT") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      settings: body ? JSON.parse(body) : {},
      runtime: {connected: true, reload: {ok: true}},
      commandCatalog: [{id: "request", name: "request"}]
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/discord/runtime/reload" && request.method === "POST") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      settings: {},
      runtime: {connected: true, reload: {ok: true}},
      commandCatalog: []
    }));
    return;
  }

  if (
    ["/api/moon-v3/admin/discord/onboarding/test", "/api/moon-v3/admin/discord/release-notifications/test", "/api/moon-v3/admin/discord/update-notifications/test"].includes(requestUrl.pathname)
    && request.method === "POST"
  ) {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({ok: true, channelId: "release-1"}));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/settings/branding/logo" && request.method === "PUT") {
    const parsed = body ? JSON.parse(body) : {};
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      branding: {siteName: "Pax Library", logo: {enabled: true, revision: parsed.revision}},
      publicBranding: {siteName: "Pax Library", logo: {enabled: true, urls: {chrome: "/api/moon/v3/public/branding/logo/chrome"}}},
      receivedVariantNames: Object.keys(parsed.variants || {})
    }));
    return;
  }

  if ([
    "/api/moon-v3/admin/settings/raven/metadata",
    "/api/moon-v3/admin/settings/raven/download-providers",
    "/api/moon-v3/admin/settings/raven/download-runtime",
    "/api/moon-v3/admin/settings/portal/discord"
  ].includes(requestUrl.pathname) && request.method === "PUT") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(body || "{}");
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/users") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      users: [{discordUserId: "owner-1", username: "Owner", role: "owner", isOwner: true, groups: []}],
      groups: [{id: "member", name: "Member", isDefault: true, permissions: ["read_library"], adminGrants: {}}],
      defaultGroupId: "member",
      domains: ["users", "requests"],
      events: []
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/requests") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      counts: {total: 1, needsReview: 1},
      requests: [{
        id: "request-1",
        title: "Dandadan",
        status: "pending",
        tab: "active",
        requestedBy: {discordUserId: "reader-1", username: "Reader"},
        details: {selectedMetadata: {provider: "mangadex"}, selectedDownload: null},
        timeline: []
      }]
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/admin/requests/request-1/deny" && request.method === "POST") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      id: "request-1",
      status: "denied",
      moderatorComment: JSON.parse(body || "{}").comment
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/user/api-keys") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      apiKeys: [],
      canManageApiKeys: true
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/user/reader/title/dan-da-dan/chapter/chapter-1/page/0") {
    response.writeHead(200, {"Content-Type": "image/svg+xml"});
    response.end("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>reader-page</text></svg>");
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/user/reader/title/dan-da-dan/chapter/chapter-1/session") {
    response.writeHead(200, {"Content-Type": "application/json", "Cache-Control": "no-store"});
    response.end(JSON.stringify({
      title: {id: "dan-da-dan", title: "Dandadan", libraryTypeSlug: "webtoon", libraryTypeLabel: "Webtoon"},
      chapter: {id: "chapter-1", label: "Chapter 1", pageCount: 2},
      previousChapterId: null,
      nextChapterId: "chapter-2",
      pageCount: 2,
      pageBase: "/api/moon/v3/user/reader/title/dan-da-dan/chapter/chapter-1/page",
      pageRevision: "rev-1",
      progress: null,
      bookmarks: [],
      preferences: {layoutMode: "webtoon", readingMode: "infinite", readingDirection: "ltr"}
    }));
    return;
  }

  if (requestUrl.pathname === "/api/moon-v3/user/reader/title/dan-da-dan/chapter/chapter-1/pages") {
    response.writeHead(200, {"Content-Type": "application/json", "Cache-Control": requestUrl.searchParams.get("rev") ? "private, max-age=604800" : "no-store"});
    response.end(JSON.stringify({
      titleId: "dan-da-dan",
      chapterId: "chapter-1",
      pageRevision: "rev-1",
      pages: [{
        index: Number.parseInt(requestUrl.searchParams.get("cursor") || "0", 10) || 0,
        label: "Page 1",
        src: "/api/moon/v3/user/reader/title/dan-da-dan/chapter/chapter-1/page/0?rev=rev-1"
      }],
      pageInfo: {cursor: requestUrl.searchParams.get("cursor") || "0", nextCursor: "1", hasMore: true, pageSize: 1, totalCount: 2}
    }));
    return;
  }

  if (requestUrl.pathname === "/api/auth/status") {
    if (authorization === "Bearer admin-token") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        id: "admin-1",
        discordId: "discord-admin-1",
        username: "CaptainPax",
        role: "owner",
        permissions: ["admin", "manage_settings", "read_library"],
        avatarUrl: "https://cdn.discordapp.com/avatars/admin.png"
      }));
      return;
    }

    if (authorization === "Bearer member-token") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        id: "member-1",
        discordId: "discord-member-1",
        username: "LibraryFan",
        role: "member",
        permissions: ["create_requests"],
        avatarUrl: "https://cdn.discordapp.com/avatars/member.png"
      }));
      return;
    }

    response.writeHead(401, {"Content-Type": "application/json"});
    response.end(JSON.stringify({error: "Not signed in"}));
    return;
  }

  if (requestUrl.pathname === "/api/auth/bootstrap-status") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({ownerClaimed: true, superuserId: "owner-1"}));
    return;
  }

  if (requestUrl.pathname === "/api/auth/discord/url") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      oauthUrl: "https://discord.example/login",
      returnTo: requestUrl.searchParams.get("returnTo") || "/"
    }));
    return;
  }

  if (requestUrl.pathname === "/api/auth/discord/callback") {
    const scenario = requestUrl.searchParams.get("scenario") || "member";
    const memberUser = {
      id: "member-1",
      discordId: "discord-member-1",
      username: "LibraryFan",
      role: "member",
      permissions: ["create_requests"],
      avatarUrl: "https://cdn.discordapp.com/avatars/member.png"
    };
    const adminUser = {
      id: "admin-1",
      discordId: "discord-admin-1",
      username: "CaptainPax",
      role: "owner",
      permissions: ["admin", "manage_settings", "read_library"],
      avatarUrl: "https://cdn.discordapp.com/avatars/admin.png"
    };
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      token: scenario === "admin" ? "admin-token" : "member-token",
      user: scenario === "admin" ? adminUser : memberUser,
      returnTo: requestUrl.searchParams.get("returnTo") || "/"
    }));
    return;
  }

  if (request.url === "/api/admin/settings/portal/discord" && request.method === "GET") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      settings: {
        guildId: "123456789012345678",
        superuserId: "253987219969146890",
        onboarding: {
          channelId: "987654321098765432",
          template: "Welcome to {guild_name}, {user_mention}!"
        },
        commands: {
          request: {
            enabled: true,
            roleId: "555555555555555555"
          }
        }
      },
      runtime: {
        authConfigured: true,
        connected: true,
        registeredGuildId: "123456789012345678",
        commandInventory: [{
          id: "request",
          label: "/request",
          registered: true,
          status: "Registered"
        }]
      }
    }));
    return;
  }

  if (request.url === "/api/admin/settings/raven/naming" && request.method === "GET") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      chapterTemplate: "{title} c{chapter_padded} [Scriptarr].cbz",
      pageTemplate: "{page_padded}{ext}",
      chapterPad: 3,
      pagePad: 3,
      volumePad: 2,
      profiles: {
        manga: {
          chapterTemplate: "{title} ch{chapter_padded}.cbz",
          pageTemplate: "{page_padded}{ext}",
          chapterPad: 3,
          pagePad: 3,
          volumePad: 2
        }
      }
    }));
    return;
  }

  if (request.url === "/api/admin/settings/moon/public-api" && request.method === "GET") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      enabled: true,
      lastRotatedAt: "2026-04-19T12:00:00.000Z"
    }));
    return;
  }

  if (request.url === "/api/admin/settings/moon/public-api" && request.method === "PUT") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      enabled: true,
      lastRotatedAt: "2026-04-19T12:00:00.000Z"
    }));
    return;
  }

  if (request.url === "/api/admin/settings/moon/public-api/key" && request.method === "POST") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      enabled: true,
      lastRotatedAt: "2026-04-19T12:05:00.000Z",
      apiKey: "generated-public-key"
    }));
    return;
  }

  if (request.url === "/api/public/openapi.json") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      openapi: "3.1.0",
      info: {title: "Scriptarr Public API"}
    }));
    return;
  }

  if (request.url === "/api/public/v1/search?q=dandadan") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      query: "dandadan",
      results: [{
        canonicalTitle: "Dandadan",
        coverUrl: "https://images.example/dandadan.jpg",
        selectionToken: "selection-token-1"
      }]
    }));
    return;
  }

  if (request.url === "/api/public/v1/requests" && request.method === "POST") {
    response.writeHead(202, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      request: {
        id: "request-1",
        status: "queued"
      }
    }));
    return;
  }

  if (request.url === "/api/public/v1/requests/request-1") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      request: {
        id: "request-1",
        status: "queued"
      }
    }));
    return;
  }

  if (request.url === "/api/admin/settings/portal/discord" && request.method === "PUT") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      ok: true,
      saved: body ? JSON.parse(body) : null
    }));
    return;
  }

  if (request.url === "/api/admin/settings/raven/naming" && request.method === "PUT") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify(body ? JSON.parse(body) : {}));
    return;
  }

  if (request.url === "/api/admin/settings/portal/discord/onboarding/test" && request.method === "POST") {
    response.writeHead(202, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      ok: true,
      accepted: body ? JSON.parse(body) : null
    }));
    return;
  }

  response.writeHead(404, {"Content-Type": "application/json"});
  response.end(JSON.stringify({error: "Not found"}));
}));

test("moon serves branded split entry documents, typed routes, PWA assets, and Moon v3 proxy payloads", async () => {
  const cwd = process.cwd();
  process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const previousCoverCacheDir = process.env.SCRIPTARR_MOON_COVER_CACHE_DIR;
  const coverCacheDir = path.join(process.cwd(), ".tmp-cover-cache-test");
  process.env.SCRIPTARR_MOON_COVER_CACHE_DIR = coverCacheDir;

  const requests = [];
  const sageStub = await createSageStub({requests});
  sageStub.listen(0);
  const sagePort = sageStub.address().port;
  process.env.SCRIPTARR_SAGE_BASE_URL = `http://127.0.0.1:${sagePort}`;

  const {app} = await createMoonApp();
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
  const [userPageResponse, adminPageResponse, libraryRouteResponse, titleRouteResponse, readerRouteResponse, untypedReaderRouteResponse, profileRouteResponse] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/admin`),
    fetch(`${baseUrl}/library/webtoon`),
    fetch(`${baseUrl}/title/webtoon/dan-da-dan`),
    fetch(`${baseUrl}/reader/webtoon/dan-da-dan/chapter-1`),
    fetch(`${baseUrl}/reader/dan-da-dan/chapter-1`),
    fetch(`${baseUrl}/profile`)
  ]);

  const userPage = await userPageResponse.text();
  const adminPage = await adminPageResponse.text();
  const readerPage = await readerRouteResponse.text();
  const untypedReaderPage = await untypedReaderRouteResponse.text();

  assert.match(userPage, /Pax Library/);
  assert.doesNotMatch(userPage, /Scriptarr Moon/);
  assert.equal(adminPageResponse.status, 503);
  assert.match(adminPage, /Pax Library Admin unavailable/);
  assert.match(readerPage, /Pax Library Reader unavailable/);
  assert.match(untypedReaderPage, /Pax Library Reader unavailable/);
  assert.match(userPage, /manifest\.webmanifest/);
  assert.match(userPage, /icon\.svg/);
  assert.equal(userPageResponse.headers.get("cache-control"), "no-store");
  assert.equal(adminPageResponse.headers.get("cache-control"), "no-store");
  assert.equal(libraryRouteResponse.headers.get("cache-control"), "no-store");
  assert.equal(titleRouteResponse.headers.get("cache-control"), "no-store");
  assert.equal(readerRouteResponse.headers.get("cache-control"), "no-store");
  assert.equal(untypedReaderRouteResponse.headers.get("cache-control"), "no-store");
  assert.equal(profileRouteResponse.headers.get("cache-control"), "no-store");
  assert.match(await libraryRouteResponse.text(), /manifest\.webmanifest/);
  assert.match(await titleRouteResponse.text(), /manifest\.webmanifest/);
  assert.match(readerPage, /manifest\.webmanifest/);
  assert.match(untypedReaderPage, /manifest\.webmanifest/);
  assert.match(await profileRouteResponse.text(), /manifest\.webmanifest/);

  const adminAppResponse = await fetch(`${baseUrl}/admin-assets/app.js`);
  assert.equal(adminAppResponse.status, 404);
  const readerNextAssetResponse = await fetch(`${baseUrl}/reader/_next/static/chunks/app.js`);
  assert.equal(readerNextAssetResponse.status, 503);
  assert.match((await readerNextAssetResponse.json()).error, /reader assets/i);

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual((await healthResponse.json()).programs, ["/", "/reader", "/admin"]);

  const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.match(manifestResponse.headers.get("content-type") || "", /application\/manifest\+json/);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.name, "Pax Library");
  assert.equal(manifest.short_name, "Pax");
  assert.equal(manifest.start_url, "/");
  assert.deepEqual(manifest.icons, [
    {
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any"
    },
    {
      src: "/icon-maskable.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "maskable"
    }
  ]);

  const iconResponse = await fetch(`${baseUrl}/icon.svg`);
  assert.equal(iconResponse.status, 200);
  assert.match(iconResponse.headers.get("content-type") || "", /image\/svg\+xml/);
  assert.match(await iconResponse.text(), /Scriptarr icon/);

  const maskableIconResponse = await fetch(`${baseUrl}/icon-maskable.svg`);
  assert.equal(maskableIconResponse.status, 200);
  assert.match(maskableIconResponse.headers.get("content-type") || "", /image\/svg\+xml/);
  assert.match(await maskableIconResponse.text(), /Scriptarr icon/);

  const serviceWorkerResponse = await fetch(`${baseUrl}/service-worker.js`);
  assert.match(serviceWorkerResponse.headers.get("content-type") || "", /javascript/);
  const serviceWorkerSource = await serviceWorkerResponse.text();
  assert.match(serviceWorkerSource, /moon-static-/);
  assert.match(serviceWorkerSource, /moon-reader-/);
  assert.doesNotMatch(serviceWorkerSource, /<!doctype html>/i);

  const brandingResponse = await fetch(`${baseUrl}/api/moon/v3/public/branding`);
  assert.equal(brandingResponse.status, 200);
  assert.deepEqual(await brandingResponse.json(), {siteName: "Pax Library"});

  const chromeRequestStart = requests.length;
  const chromeBootstrapResponse = await fetch(`${baseUrl}/api/moon/chrome/bootstrap?returnTo=%2Fbrowse`);
  assert.equal(chromeBootstrapResponse.status, 200);
  const chromeBootstrap = await chromeBootstrapResponse.json();
  assert.deepEqual(chromeBootstrap.branding, {siteName: "Pax Library"});
  assert.equal(chromeBootstrap.bootstrap.ownerClaimed, true);
  assert.equal(chromeBootstrap.user, null);
  assert.equal(requests.slice(chromeRequestStart).some((entry) => entry.url.startsWith("/api/auth/discord/url")), false);

  const discordSettingsResponse = await fetch(`${baseUrl}/api/moon/admin/settings/portal/discord`);
  assert.equal(discordSettingsResponse.status, 200);
  assert.deepEqual(await discordSettingsResponse.json(), {
    settings: {
      guildId: "123456789012345678",
      superuserId: "253987219969146890",
      onboarding: {
        channelId: "987654321098765432",
        template: "Welcome to {guild_name}, {user_mention}!"
      },
      commands: {
        request: {
          enabled: true,
          roleId: "555555555555555555"
        }
      }
    },
    runtime: {
      authConfigured: true,
      connected: true,
      registeredGuildId: "123456789012345678",
      commandInventory: [{
        id: "request",
        label: "/request",
        registered: true,
        status: "Registered"
      }]
    }
  });

  const discordSettingsSaveResponse = await fetch(`${baseUrl}/api/moon/admin/settings/portal/discord`, {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      guildId: "123456789012345678",
      superuserId: "253987219969146890"
    })
  });
  assert.equal(discordSettingsSaveResponse.status, 200);
  assert.deepEqual(await discordSettingsSaveResponse.json(), {
    ok: true,
    saved: {
      guildId: "123456789012345678",
      superuserId: "253987219969146890"
    }
  });

  const onboardingTestResponse = await fetch(`${baseUrl}/api/moon/admin/settings/portal/discord/onboarding/test`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      onboarding: {
        channelId: "987654321098765432",
        template: "Welcome!"
      }
    })
  });
  assert.equal(onboardingTestResponse.status, 202);
  assert.deepEqual(await onboardingTestResponse.json(), {
    ok: true,
    accepted: {
      onboarding: {
        channelId: "987654321098765432",
        template: "Welcome!"
      }
    }
  });

  const publicApiSettingsResponse = await fetch(`${baseUrl}/api/moon/admin/settings/moon/public-api`);
  assert.equal(publicApiSettingsResponse.status, 200);
  assert.deepEqual(await publicApiSettingsResponse.json(), {
    enabled: true,
    lastRotatedAt: "2026-04-19T12:00:00.000Z"
  });

  const publicApiKeyResponse = await fetch(`${baseUrl}/api/moon/admin/settings/moon/public-api/key`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({})
  });
  assert.equal(publicApiKeyResponse.status, 200);
  assert.deepEqual(await publicApiKeyResponse.json(), {
    enabled: true,
    lastRotatedAt: "2026-04-19T12:05:00.000Z",
    apiKey: "generated-public-key"
  });

  const swaggerDocsResponse = await fetch(`${baseUrl}/api/public/docs`);
  assert.equal(swaggerDocsResponse.status, 200);
  assert.match(await swaggerDocsResponse.text(), /SwaggerUIBundle/);

  const openApiResponse = await fetch(`${baseUrl}/api/public/openapi.json`);
  assert.equal(openApiResponse.status, 200);
  assert.deepEqual(await openApiResponse.json(), {
    openapi: "3.1.0",
    info: {title: "Scriptarr Public API"}
  });

  const libraryResponse = await fetch(`${baseUrl}/api/moon/v3/user/library`);
  assert.equal(libraryResponse.status, 200);
  assert.deepEqual(await libraryResponse.json(), {
    titles: [{id: "dan-da-dan", title: "Dandadan", libraryTypeSlug: "webtoon", libraryTypeLabel: "Webtoon"}]
  });

  const libraryAliasResponse = await fetch(`${baseUrl}/api/moon-v3/user/library`);
  assert.equal(libraryAliasResponse.status, 200);
  assert.deepEqual(await libraryAliasResponse.json(), {
    titles: [{id: "dan-da-dan", title: "Dandadan", libraryTypeSlug: "webtoon", libraryTypeLabel: "Webtoon"}]
  });

  const coverResponse = await fetch(`${baseUrl}/api/moon/v3/user/covers/dan-da-dan.webp?rev=rev-1`);
  assert.equal(coverResponse.status, 200);
  assert.equal(coverResponse.headers.get("content-type"), "image/webp");

  const apiAdminResponse = await fetch(`${baseUrl}/api/moon/v3/admin/system/api`, {
    headers: {"X-Scriptarr-Api-Key": "system-secret"}
  });
  assert.equal(apiAdminResponse.status, 200);
  assert.equal((await apiAdminResponse.json()).settings.enabled, true);

  const aiAdminResponse = await fetch(`${baseUrl}/api/moon/v3/admin/system/ai`);
  assert.equal(aiAdminResponse.status, 200);
  assert.equal((await aiAdminResponse.json()).oracle.provider, "openai");

  const aiRuntimeResponse = await fetch(`${baseUrl}/api/moon/v3/admin/system/ai/runtime`);
  assert.equal(aiRuntimeResponse.status, 200);
  assert.equal((await aiRuntimeResponse.json()).localAiProfile.selectedProfile, "cpu");

  const aiModelsResponse = await fetch(`${baseUrl}/api/moon/v3/admin/system/ai/models?provider=localai`);
  assert.equal(aiModelsResponse.status, 200);
  assert.equal((await aiModelsResponse.json()).selectedModel, "gpt-4");

  const settingsResponse = await fetch(`${baseUrl}/api/moon/v3/admin/settings`);
  assert.equal(settingsResponse.status, 200);
  assert.equal((await settingsResponse.json()).databaseOverview.tables[0].name, "settings");

  const vpnTestResponse = await fetch(`${baseUrl}/api/moon/v3/admin/settings/raven/vpn/test`, {
    method: "POST"
  });
  assert.equal(vpnTestResponse.status, 200);
  assert.equal((await vpnTestResponse.json()).vpn.state, "armed");

  const databaseExplorerResponse = await fetch(`${baseUrl}/api/moon/v3/admin/settings/database`);
  assert.equal(databaseExplorerResponse.status, 200);
  assert.equal((await databaseExplorerResponse.json()).tables[0].editable, true);

  const calendarResponse = await fetch(`${baseUrl}/api/moon/v3/admin/calendar`);
  assert.equal(calendarResponse.status, 200);
  assert.equal((await calendarResponse.json()).counts.completedMarkers, 1);

  const discordV3Response = await fetch(`${baseUrl}/api/moon/v3/admin/discord`);
  assert.equal(discordV3Response.status, 200);
  const discordV3Payload = await discordV3Response.json();
  assert.equal(discordV3Payload.settings.notifications.releaseChannelId, "release-1");
  assert.equal(discordV3Payload.settings.notifications.updateChannelId, "updates-1");

  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  );
  const logoUploadResponse = await fetch(`${baseUrl}/api/moon/v3/admin/settings/branding/logo`, {
    method: "PUT",
    headers: {"Content-Type": "image/png"},
    body: tinyPng
  });
  assert.equal(logoUploadResponse.status, 200);
  assert.deepEqual((await logoUploadResponse.json()).receivedVariantNames.sort(), ["chrome", "icon192", "icon512"]);

  const userKeysResponse = await fetch(`${baseUrl}/api/moon-v3/user/api-keys`);
  assert.equal(userKeysResponse.status, 200);
  assert.deepEqual(await userKeysResponse.json(), {
    apiKeys: [],
    canManageApiKeys: true
  });

  const metadataSave = await fetch(`${baseUrl}/api/moon/v3/admin/settings/raven/metadata`, {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({providers: [{id: "mangadex", enabled: false}]})
  });
  assert.equal(metadataSave.status, 200);

  const downloadProvidersSave = await fetch(`${baseUrl}/api/moon/v3/admin/settings/raven/download-providers`, {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({providers: [{id: "weebcentral", enabled: true}]})
  });
  assert.equal(downloadProvidersSave.status, 200);

  const downloadRuntimeSave = await fetch(`${baseUrl}/api/moon/v3/admin/settings/raven/download-runtime`, {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({activeTitleDownloads: 4})
  });
  assert.equal(downloadRuntimeSave.status, 200);

  const discordBasicsSave = await fetch(`${baseUrl}/api/moon/v3/admin/settings/portal/discord`, {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({guildId: "guild-1"})
  });
  assert.equal(discordBasicsSave.status, 200);

  const discordV3Save = await fetch(`${baseUrl}/api/moon/v3/admin/discord`, {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({guildId: "guild-2", notifications: {releaseChannelId: "release-2", updateChannelId: "updates-2"}})
  });
  assert.equal(discordV3Save.status, 200);

  const discordReleaseTest = await fetch(`${baseUrl}/api/moon/v3/admin/discord/release-notifications/test`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({notifications: {releaseChannelId: "release-2"}})
  });
  assert.equal(discordReleaseTest.status, 200);

  const discordUpdateTest = await fetch(`${baseUrl}/api/moon/v3/admin/discord/update-notifications/test`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({notifications: {updateChannelId: "updates-2"}})
  });
  assert.equal(discordUpdateTest.status, 200);

  const usersPayload = await fetch(`${baseUrl}/api/moon/v3/admin/users`).then((response) => response.json());
  assert.equal(usersPayload.groups[0].id, "member");

  const requestsPayload = await fetch(`${baseUrl}/api/moon/v3/admin/requests`).then((response) => response.json());
  assert.equal(requestsPayload.counts.needsReview, 1);

  const denyResponse = await fetch(`${baseUrl}/api/moon/v3/admin/requests/request-1/deny`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({comment: "Wrong match."})
  });
  assert.equal(denyResponse.status, 200);

  const pageResponse = await fetch(`${baseUrl}/api/moon/v3/user/reader/title/dan-da-dan/chapter/chapter-1/page/0`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type") || "", /image\/svg\+xml/);
  assert.match(await pageResponse.text(), /reader-page/);

  const readerSessionResponse = await fetch(`${baseUrl}/api/moon/v3/user/reader/title/dan-da-dan/chapter/chapter-1/session`);
  assert.equal(readerSessionResponse.status, 200);
  const readerSession = await readerSessionResponse.json();
  assert.equal(readerSession.pageRevision, "rev-1");
  assert.equal(Object.hasOwn(readerSession, "manifest"), false);
  assert.equal(Object.hasOwn(readerSession, "pages"), false);

  const readerPagesResponse = await fetch(`${baseUrl}/api/moon-v3/user/reader/title/dan-da-dan/chapter/chapter-1/pages?cursor=0&pageSize=1&rev=rev-1`);
  assert.equal(readerPagesResponse.status, 200);
  const readerPages = await readerPagesResponse.json();
  assert.equal(readerPages.pages[0].src, "/api/moon/v3/user/reader/title/dan-da-dan/chapter/chapter-1/page/0?rev=rev-1");

  const missingApiResponse = await fetch(`${baseUrl}/api/not-a-real-route`);
  assert.equal(missingApiResponse.status, 404);
  assert.deepEqual(await missingApiResponse.json(), {error: "Not found"});

  const redirectResponse = await fetch(`${baseUrl}/downloads`, {redirect: "manual"});
  assert.equal(redirectResponse.status, 302);
  assert.equal(redirectResponse.headers.get("location"), "/admin/activity/queue");

  const metadataRedirectResponse = await fetch(`${baseUrl}/admin/wanted/metadata-gaps`, {redirect: "manual"});
  assert.equal(metadataRedirectResponse.status, 302);
  assert.equal(metadataRedirectResponse.headers.get("location"), "/admin/wanted/metadata");

  const namingResponse = await fetch(`${baseUrl}/api/moon/admin/settings/raven/naming`);
  assert.equal(namingResponse.status, 200);
  assert.deepEqual(await namingResponse.json(), {
    chapterTemplate: "{title} c{chapter_padded} [Scriptarr].cbz",
    pageTemplate: "{page_padded}{ext}",
    chapterPad: 3,
    pagePad: 3,
    volumePad: 2,
    profiles: {
      manga: {
        chapterTemplate: "{title} ch{chapter_padded}.cbz",
        pageTemplate: "{page_padded}{ext}",
        chapterPad: 3,
        pagePad: 3,
        volumePad: 2
      }
    }
  });

  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/admin/settings/portal/discord"));
  assert.ok(requests.some((entry) => entry.method === "PUT" && entry.url === "/api/admin/settings/portal/discord"));
  assert.ok(requests.some((entry) => entry.method === "POST" && entry.url === "/api/admin/settings/portal/discord/onboarding/test"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/admin/settings/raven/naming"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/admin/settings/moon/public-api"));
  assert.ok(requests.some((entry) => entry.method === "POST" && entry.url === "/api/admin/settings/moon/public-api/key"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/public/openapi.json"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/moon-v3/admin/system/api" && entry.apiKey === "system-secret"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/moon-v3/admin/system/ai"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/moon-v3/admin/system/ai/runtime"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/moon-v3/admin/system/ai/models?provider=localai"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/moon-v3/admin/settings"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/moon-v3/admin/settings/database"));
  assert.ok(requests.some((entry) => entry.method === "POST" && entry.url === "/api/moon-v3/admin/settings/raven/vpn/test"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/moon-v3/admin/calendar"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/moon-v3/admin/discord"));
  assert.ok(requests.some((entry) => entry.method === "PUT" && entry.url === "/api/moon-v3/admin/discord"));
  assert.ok(requests.some((entry) => entry.method === "POST" && entry.url === "/api/moon-v3/admin/discord/release-notifications/test"));
  assert.ok(requests.some((entry) => entry.method === "POST" && entry.url === "/api/moon-v3/admin/discord/update-notifications/test"));
  assert.ok(requests.some((entry) => entry.method === "PUT" && entry.url === "/api/moon-v3/admin/settings/branding/logo"));
  assert.ok(requests.some((entry) => entry.method === "PUT" && entry.url === "/api/moon-v3/admin/settings/raven/metadata"));
  assert.ok(requests.some((entry) => entry.method === "PUT" && entry.url === "/api/moon-v3/admin/settings/raven/download-providers"));
  assert.ok(requests.some((entry) => entry.method === "PUT" && entry.url === "/api/moon-v3/admin/settings/raven/download-runtime"));
  assert.ok(requests.some((entry) => entry.method === "PUT" && entry.url === "/api/moon-v3/admin/settings/portal/discord"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/moon-v3/admin/users"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/moon-v3/admin/requests"));
  assert.ok(requests.some((entry) => entry.method === "POST" && entry.url === "/api/moon-v3/admin/requests/request-1/deny"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/moon-v3/user/api-keys"));

  } finally {
  await closeServer(server);
  await closeServer(sageStub);
  if (previousCoverCacheDir == null) {
    delete process.env.SCRIPTARR_MOON_COVER_CACHE_DIR;
  } else {
    process.env.SCRIPTARR_MOON_COVER_CACHE_DIR = previousCoverCacheDir;
  }
  await fs.rm(coverCacheDir, {recursive: true, force: true});
  process.chdir(cwd);
  }
});

test("moon redirects signed-in non-admin sessions away from admin while allowing admin sessions through", async () => {
  const cwd = process.cwd();
  process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

  const requests = [];
  const sageStub = await createSageStub({requests});
  sageStub.listen(0);
  const sagePort = sageStub.address().port;
  process.env.SCRIPTARR_SAGE_BASE_URL = `http://127.0.0.1:${sagePort}`;

  const {app} = await createMoonApp();
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const memberResponse = await fetch(`${baseUrl}/admin`, {
    headers: {cookie: "scriptarr_session=member-token"},
    redirect: "manual"
  });
  assert.equal(memberResponse.status, 302);
  assert.equal(memberResponse.headers.get("location"), "/");

  const adminResponse = await fetch(`${baseUrl}/admin`, {
    headers: {cookie: "scriptarr_session=admin-token"}
  });
  assert.equal(adminResponse.status, 503);
  assert.match(await adminResponse.text(), /Pax Library Admin unavailable/);

  const memberAuthLookups = requests.filter((entry) => entry.url === "/api/auth/status").length;
  assert.ok(memberAuthLookups >= 2);

  await closeServer(server);
  await closeServer(sageStub);
  process.chdir(cwd);
});

test("moon clears the local session cookie on logout", async () => {
  const cwd = process.cwd();
  process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

  const sageStub = await createSageStub();
  sageStub.listen(0);
  const sagePort = sageStub.address().port;
  process.env.SCRIPTARR_SAGE_BASE_URL = `http://127.0.0.1:${sagePort}`;

  const {app} = await createMoonApp();
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/moon/auth/logout`, {
    method: "POST",
    headers: {cookie: "scriptarr_session=member-token"}
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true});
  assert.match(response.headers.get("set-cookie") || "", /scriptarr_session=/);
  assert.match(response.headers.get("set-cookie") || "", /Max-Age=0/);

  await closeServer(server);
  await closeServer(sageStub);
  process.chdir(cwd);
});
