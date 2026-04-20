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
const createSageStub = () => Promise.resolve(http.createServer((request, response) => {
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

  response.writeHead(404, {"Content-Type": "application/json"});
  response.end(JSON.stringify({error: "Not found"}));
}));

test("moon serves branded split entry documents, typed routes, PWA assets, and Moon v3 proxy payloads", async () => {
  const cwd = process.cwd();
  process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

  const sageStub = await createSageStub();
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

  server.close();
  sageStub.close();
  process.chdir(cwd);
});
