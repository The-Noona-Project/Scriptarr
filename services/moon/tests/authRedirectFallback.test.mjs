import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const moonRoot = path.resolve(import.meta.dirname, "..");
const readMoonFile = (relativePath) => fs.readFileSync(path.join(moonRoot, relativePath), "utf8");

test("protected signed-out user views redirect instead of rendering a login card", () => {
  const shell = readMoonFile("apps/user-next/components/MoonShell.jsx");
  const stateView = readMoonFile("apps/user-next/components/StateView.jsx");
  const protectedPages = [
    "apps/user-next/components/pages/HomePageClient.jsx",
    "apps/user-next/components/pages/CataloguePageClient.jsx",
    "apps/user-next/components/pages/FollowingPageClient.jsx",
    "apps/user-next/components/pages/RequestsPageClient.jsx",
    "apps/user-next/components/pages/ProfilePageClient.jsx",
    "apps/user-next/components/pages/TitlePageClient.jsx"
  ].map((file) => readMoonFile(file)).join("\n");

  assert.match(shell, /window\.location\.replace\(buildMoonLoginHref\(`\$\{window\.location\.pathname\}\$\{window\.location\.search\}`\)\)/);
  assert.match(shell, /moon-auth-resolving/);
  assert.doesNotMatch(shell, /chrome\.authError \|\|/);
  assert.doesNotMatch(shell, /label=\{chrome\.authError/);
  assert.match(stateView, /window\.location\.replace\(loginUrl \|\| buildMoonLoginHref\(returnTo\)\)/);
  assert.doesNotMatch(`${stateView}\n${protectedPages}`, /Sign in to keep reading/);
  assert.doesNotMatch(`${stateView}\n${protectedPages}`, /Continue with Discord/);
  assert.doesNotMatch(`${shell}\n${stateView}\n${protectedPages}`, /Auth broker unavailable|AUTH\.BROKER UNAVAILABLE/);
});

test("admin and reader signed-out states redirect without rendering sign-in panels", () => {
  const adminProviders = readMoonFile("apps/admin-next/components/AdminProviders.jsx");
  const adminShell = readMoonFile("apps/admin-next/components/AdminShell.jsx");
  const adminRouter = readMoonFile("apps/admin-next/components/AdminPageRouter.jsx");
  const readerClient = readMoonFile("apps/reader-next/components/ReaderAppClient.jsx");

  assert.match(adminProviders, /window\.location\.replace\(chrome\.loginUrl\)/);
  assert.match(adminShell, /admin-auth-resolving/);
  assert.match(readerClient, /window\.location\.replace\(loginUrl \|\| fallbackLoginUrl\)/);
  assert.doesNotMatch(adminProviders, /chrome\.authError \|\|/);
  assert.doesNotMatch(adminShell, /chrome\.authError/);
  assert.doesNotMatch(readerClient, /chrome\.loaded && !chrome\.auth && !chrome\.authError/);
  assert.doesNotMatch(`${adminShell}\n${adminRouter}`, /Admin sign-in required|Not signed in|Continue with Discord/);
  assert.doesNotMatch(readerClient, /Sign in to read|Sign in with Discord/);
  assert.doesNotMatch(`${adminProviders}\n${adminShell}\n${readerClient}`, /Auth broker unavailable|AUTH\.BROKER UNAVAILABLE/);
});

test("service worker never caches navigation HTML and removes old app shells", () => {
  const serviceWorker = readMoonFile("lib/registerPageRoutes.mjs");

  assert.match(serviceWorker, /fetch\(event\.request, \{cache: "no-store"\}\)/);
  assert.match(serviceWorker, /const removeNavigationShells = async/);
  assert.match(serviceWorker, /request\.mode === "navigate" \|\| url\.pathname === "\/"/);
  assert.doesNotMatch(serviceWorker, /STATIC_ASSETS = \["\/"/);
  assert.doesNotMatch(serviceWorker, /cache\.put\("\/"/);
});
