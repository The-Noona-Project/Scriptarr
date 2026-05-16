import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const moonRoot = path.resolve(import.meta.dirname, "..");
const readMoonFile = (relativePath) => fs.readFileSync(path.join(moonRoot, relativePath), "utf8");

test("admin router keeps leaf pages behind dynamic route loaders", () => {
  const source = readMoonFile("apps/admin-next/components/AdminPageRouter.jsx");
  const guardIndex = source.indexOf("hasAdminGrant(chrome.user, route.domain, \"read\")");
  const renderIndex = source.indexOf("const PageComponent = adminPageComponents[route.id] || AdminDataPage");

  assert.match(source, /import dynamic from "next\/dynamic"/);
  assert.match(source, /const adminPageComponents = Object\.freeze/);
  assert.ok(guardIndex > -1, "router should keep route-level grant checks");
  assert.ok(renderIndex > -1, "router should choose the leaf component after guards");
  assert.ok(guardIndex < renderIndex, "grant checks must run before a leaf route chunk is rendered");
  assert.doesNotMatch(source, /import\s+\w+Page\s+from\s+"\.\/(AddTitlePage|CalendarPage|DiscordPage|SystemStatusPage|UsersPage)\.jsx"/);
});

test("admin toasts read the dedicated toast settings endpoint", () => {
  const source = readMoonFile("apps/admin-next/components/AdminToasts.jsx");

  assert.match(source, /requestJson\("\/api\/moon\/v3\/admin\/settings\/toasts"\)/);
  assert.doesNotMatch(source, /requestJson\("\/api\/moon\/v3\/admin\/settings"\)/);
  assert.match(source, /useAdminEventSubscription/);
  assert.doesNotMatch(source, /new EventSource/);
});

test("admin event staleness is backed by one shared provider stream", () => {
  const source = readMoonFile("apps/admin-next/lib/api.js");
  const eventSourceCount = source.match(/new EventSource/g)?.length || 0;

  assert.match(source, /export const AdminEventStreamProvider/);
  assert.match(source, /export const useAdminEventSubscription/);
  assert.match(source, /export const useAdminEventStaleness/);
  assert.equal(eventSourceCount, 1);
});

test("system status keeps deep probes behind the explicit check action", () => {
  const source = readMoonFile("apps/admin-next/components/SystemStatusPage.jsx");

  assert.match(source, /SYSTEM_STATUS_ENDPOINT = "\/api\/moon\/v3\/admin\/system\/status\?includeChecks=false"/);
  assert.match(source, /SYSTEM_STATUS_RUNTIME_ENDPOINT = "\/api\/moon\/v3\/admin\/system\/status\/runtime"/);
  assert.match(source, /SYSTEM_STATUS_CHECK_ENDPOINT = "\/api\/moon\/v3\/admin\/system\/status\/check"/);
  assert.match(source, /requestJson\(SYSTEM_STATUS_CHECK_ENDPOINT, \{method: "POST"\}\)/);
});

test("settings page hydrates heavy runtime panels from the side payload", () => {
  const source = readMoonFile("apps/admin-next/components/SettingsPage.jsx");

  assert.match(source, /SETTINGS_RUNTIME_ENDPOINT = "\/api\/moon\/v3\/admin\/settings\/runtime"/);
  assert.match(source, /databaseOverview: result\.payload\?\.databaseOverview/);
  assert.match(source, /discordRuntime/);
});

test("first-load Moon shells avoid the Once UI JavaScript barrel", () => {
  const hotPathFiles = [
    "apps/user-next/app/layout.jsx",
    "apps/admin-next/app/layout.jsx",
    "apps/user-next/components/UserProviders.jsx",
    "apps/admin-next/components/AdminProviders.jsx",
    "apps/user-next/components/MoonShell.jsx",
    "apps/user-next/components/ProfileMenu.jsx",
    "apps/user-next/components/StateView.jsx",
    "apps/admin-next/components/SystemStatusPage.jsx"
  ];

  for (const file of hotPathFiles) {
    assert.doesNotMatch(readMoonFile(file), /from\s+"@once-ui-system\/core"/, `${file} should not import the Once UI barrel`);
  }
});

test("user chrome keeps reader route helpers out of shell imports", () => {
  const chromeFiles = [
    "apps/user-next/components/MoonShell.jsx",
    "apps/user-next/components/ProfileMenu.jsx"
  ];

  for (const file of chromeFiles) {
    const source = readMoonFile(file);
    assert.match(source, /lib\/navigationRoutes\.js/, `${file} should import navigation-only helpers`);
    assert.doesNotMatch(source, /lib\/routes\.js|lib\/titleRoutes\.js|buildReaderPath/, `${file} should not import reader-link helpers`);
  }

  const navigationRoutes = readMoonFile("apps/user-next/lib/navigationRoutes.js");
  assert.doesNotMatch(navigationRoutes, /titleRoutes|buildReaderPath|readerTarget/);
});

test("user return-visit cache stays browser-local and card scoped", () => {
  const cacheSource = readMoonFile("apps/user-next/lib/persistentJsonCache.js");
  const apiSource = readMoonFile("apps/user-next/lib/api.js");
  const profileSource = readMoonFile("apps/user-next/components/pages/ProfilePageClient.jsx");

  assert.doesNotMatch(`${cacheSource}\n${apiSource}`, /document\.cookie/);
  assert.doesNotMatch(cacheSource, /fetch\(/);
  assert.doesNotMatch(cacheSource, /\/api\/moon-v3\/admin|\/api\/moon\/v3\/admin|api-keys/);
  assert.match(cacheSource, /\/api\/moon-v3\/user\/library/);
  assert.match(cacheSource, /view"\) === "card"/);
  assert.doesNotMatch(profileSource, /user\/api-keys[\s\S]{0,180}persistentCache/);
});
