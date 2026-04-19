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
  if (request.url === "/api/moon-v3/user/library") {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({
      titles: [{id: "dan-da-dan", title: "Dandadan"}]
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

test("moon serves split entry documents and proxies Moon v3 JSON plus SVG payloads", async () => {
  const cwd = process.cwd();
  process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

  const sageStub = await createSageStub();
  sageStub.listen(0);
  const sagePort = sageStub.address().port;
  process.env.SCRIPTARR_SAGE_BASE_URL = `http://127.0.0.1:${sagePort}`;

  const {app} = await createMoonApp();
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const [userPageResponse, adminPageResponse] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/admin`)
  ]);
  const userPage = await userPageResponse.text();
  const adminPage = await adminPageResponse.text();

  assert.match(userPage, /Scriptarr Moon/);
  assert.match(adminPage, /Scriptarr Admin/);
  assert.match(userPage, /\/user-assets\/styles\.css\?v=/);
  assert.match(userPage, /\/user-assets\/app\.js\?v=/);
  assert.match(adminPage, /\/admin-assets\/styles\.css\?v=/);
  assert.match(adminPage, /\/admin-assets\/app\.js\?v=/);
  assert.equal((await fetch(`${baseUrl}/admin`)).headers.get("cache-control"), "no-store");
  const adminAppResponse = await fetch(`${baseUrl}/admin-assets/app.js`);
  assert.equal(adminAppResponse.headers.get("cache-control"), "no-store");
  assert.match(await adminAppResponse.text(), /\.\/main\.js\?v=/);
  const userMainResponse = await fetch(`${baseUrl}/user-assets/main.js`);
  assert.equal(userMainResponse.headers.get("cache-control"), "no-store");
  assert.match(await userMainResponse.text(), /\.\/api\.js\?v=/);
  assert.doesNotMatch(userPage, /Claim dev session/);
  assert.doesNotMatch(adminPage, /Claim dev session/);

  const libraryResponse = await fetch(`${baseUrl}/api/moon/v3/user/library`);
  assert.equal(libraryResponse.status, 200);
  assert.deepEqual(await libraryResponse.json(), {
    titles: [{id: "dan-da-dan", title: "Dandadan"}]
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
