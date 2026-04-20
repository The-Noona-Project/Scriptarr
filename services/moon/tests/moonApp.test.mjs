import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {fileURLToPath} from "node:url";
import path from "node:path";

process.env.NODE_ENV = "test";

const {createMoonApp} = await import("../lib/createMoonApp.mjs");

/**
 * Start a tiny Sage stub that returns both JSON and raw SVG payloads so Moon's
 * v3 proxy behavior can be exercised without booting the full stack.
 *
 * @returns {Promise<http.Server>}
 */
const createSageStub = ({requests = []} = {}) => Promise.resolve(http.createServer(async (request, response) => {
  const body = await new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  requests.push({
    method: request.method,
    url: request.url,
    body
  });

  if (request.url === "/api/moon-v3/public/branding") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({siteName: "Pax Library"}));
    return;
  }

  if (request.url === "/api/moon-v3/user/library") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      titles: [{id: "dan-da-dan", title: "Dandadan", libraryTypeSlug: "webtoon", libraryTypeLabel: "Webtoon"}]
    }));
    return;
  }

  if (request.url === "/api/moon-v3/user/reader/title/dan-da-dan/chapter/chapter-1/page/0") {
    response.writeHead(200, {"Content-Type": "image/svg+xml"});
    response.end("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>reader-page</text></svg>");
    return;
  }

  if (request.url === "/api/auth/status") {
    response.writeHead(401, {"Content-Type": "application/json"});
    response.end(JSON.stringify({error: "Not signed in"}));
    return;
  }

  if (request.url === "/api/auth/bootstrap-status") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({ownerClaimed: true, superuserId: "owner-1"}));
    return;
  }

  if (request.url === "/api/auth/discord/url") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({oauthUrl: "https://discord.example/login"}));
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
      info: {title: "Scriptarr Moon Public API"}
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

  const requests = [];
  const sageStub = await createSageStub({requests});
  sageStub.listen(0);
  const sagePort = sageStub.address().port;
  process.env.SCRIPTARR_SAGE_BASE_URL = `http://127.0.0.1:${sagePort}`;

  const {app} = await createMoonApp();
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const [userPageResponse, adminPageResponse, libraryRouteResponse, titleRouteResponse, readerRouteResponse] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/admin`),
    fetch(`${baseUrl}/library/webtoon`),
    fetch(`${baseUrl}/title/webtoon/dan-da-dan`),
    fetch(`${baseUrl}/reader/webtoon/dan-da-dan/chapter-1`)
  ]);

  const userPage = await userPageResponse.text();
  const adminPage = await adminPageResponse.text();

  assert.match(userPage, /Pax Library/);
  assert.match(adminPage, /Pax Library Admin/);
  assert.match(userPage, /\/user-assets\/styles\.css\?v=/);
  assert.match(userPage, /\/user-assets\/app\.js\?v=/);
  assert.match(adminPage, /\/admin-assets\/styles\.css\?v=/);
  assert.match(adminPage, /\/admin-assets\/app\.js\?v=/);
  assert.equal(userPageResponse.headers.get("cache-control"), "no-store");
  assert.equal(adminPageResponse.headers.get("cache-control"), "no-store");
  assert.equal(libraryRouteResponse.headers.get("cache-control"), "no-store");
  assert.equal(titleRouteResponse.headers.get("cache-control"), "no-store");
  assert.equal(readerRouteResponse.headers.get("cache-control"), "no-store");
  assert.match(await libraryRouteResponse.text(), /manifest\.webmanifest/);
  assert.match(await titleRouteResponse.text(), /manifest\.webmanifest/);
  assert.match(await readerRouteResponse.text(), /manifest\.webmanifest/);

  const adminAppResponse = await fetch(`${baseUrl}/admin-assets/app.js`);
  assert.equal(adminAppResponse.headers.get("cache-control"), "no-store");
  assert.match(await adminAppResponse.text(), /\.\/main\.js\?v=/);

  const userMainResponse = await fetch(`${baseUrl}/user-assets/main.js`);
  assert.equal(userMainResponse.headers.get("cache-control"), "no-store");
  assert.match(await userMainResponse.text(), /\.\/api\.js\?v=/);

  const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.match(manifestResponse.headers.get("content-type") || "", /application\/manifest\+json/);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.name, "Pax Library");
  assert.equal(manifest.short_name, "Pax");
  assert.equal(manifest.start_url, "/");

  const serviceWorkerResponse = await fetch(`${baseUrl}/service-worker.js`);
  assert.match(serviceWorkerResponse.headers.get("content-type") || "", /javascript/);
  const serviceWorkerSource = await serviceWorkerResponse.text();
  assert.match(serviceWorkerSource, /moon-shell-/);
  assert.doesNotMatch(serviceWorkerSource, /<!doctype html>/i);

  const brandingResponse = await fetch(`${baseUrl}/api/moon/v3/public/branding`);
  assert.equal(brandingResponse.status, 200);
  assert.deepEqual(await brandingResponse.json(), {siteName: "Pax Library"});

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
    info: {title: "Scriptarr Moon Public API"}
  });

  const libraryResponse = await fetch(`${baseUrl}/api/moon/v3/user/library`);
  assert.equal(libraryResponse.status, 200);
  assert.deepEqual(await libraryResponse.json(), {
    titles: [{id: "dan-da-dan", title: "Dandadan", libraryTypeSlug: "webtoon", libraryTypeLabel: "Webtoon"}]
  });

  const pageResponse = await fetch(`${baseUrl}/api/moon/v3/user/reader/title/dan-da-dan/chapter/chapter-1/page/0`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type") || "", /image\/svg\+xml/);
  assert.match(await pageResponse.text(), /reader-page/);

  const redirectResponse = await fetch(`${baseUrl}/downloads`, {redirect: "manual"});
  assert.equal(redirectResponse.status, 302);
  assert.equal(redirectResponse.headers.get("location"), "/admin/activity/queue");

  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/admin/settings/portal/discord"));
  assert.ok(requests.some((entry) => entry.method === "PUT" && entry.url === "/api/admin/settings/portal/discord"));
  assert.ok(requests.some((entry) => entry.method === "POST" && entry.url === "/api/admin/settings/portal/discord/onboarding/test"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/admin/settings/moon/public-api"));
  assert.ok(requests.some((entry) => entry.method === "POST" && entry.url === "/api/admin/settings/moon/public-api/key"));
  assert.ok(requests.some((entry) => entry.method === "GET" && entry.url === "/api/public/openapi.json"));

  server.close();
  sageStub.close();
  process.chdir(cwd);
});
