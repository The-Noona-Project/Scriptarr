import test from "node:test";
import assert from "node:assert/strict";

import {loadMoonChromeContext, loadMoonLoginUrl, logoutMoonSession, requestJson} from "../apps/user-next/lib/api.js";
import {
  buildLibraryPath,
  buildProfilePath,
  buildReaderPath,
  buildReaderPathForTitleTarget,
  buildTitlePath,
  classifyPathname,
  getLibraryTypeCount,
  getLibraryTypes
} from "../apps/user-next/lib/routes.js";

test("loadMoonChromeContext normalizes nested auth payloads from Moon auth status", async () => {
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const href = String(url);

    if (href === "/api/moon/chrome/bootstrap?returnTo=%2Fbrowse%3Fq%3Dmoon") {
      return new Response(JSON.stringify({
        branding: {siteName: "Pax-Kun"},
        auth: {authenticated: true},
        user: {
          username: "CaptainPax",
          role: "owner",
          permissions: ["admin"],
          avatarUrl: "https://cdn.discordapp.com/avatars/captain.png"
        },
        bootstrap: {ownerClaimed: true}
      }), {
        status: 200,
        headers: {"Content-Type": "application/json"}
      });
    }

    throw new Error(`Unexpected URL ${href}`);
  };

  try {
    const context = await loadMoonChromeContext("/browse?q=moon");
    assert.deepEqual(context.branding, {siteName: "Pax-Kun"});
    assert.deepEqual(context.auth, {
      username: "CaptainPax",
      role: "owner",
      permissions: ["admin"],
      avatarUrl: "https://cdn.discordapp.com/avatars/captain.png"
    });
    assert.equal(context.loginUrl, "");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("loadMoonLoginUrl fetches the Discord URL separately for signed-out chrome", async () => {
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    assert.equal(String(url), "/api/moon/auth/discord/url?returnTo=%2Fbrowse%3Fq%3Dmoon");
    return new Response(JSON.stringify({oauthUrl: "https://discord.example/login"}), {
      status: 200,
      headers: {"Content-Type": "application/json"}
    });
  };

  try {
    assert.equal(await loadMoonLoginUrl("/browse?q=moon"), "https://discord.example/login");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("requestJson preserves 401 Moon auth payloads for signed-out route handling", async () => {
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(JSON.stringify({error: "Missing session token."}), {
    status: 401,
    headers: {"Content-Type": "application/json"}
  });

  try {
    const result = await requestJson("/api/moon-v3/user/home");
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.deepEqual(result.payload, {error: "Missing session token."});
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("logoutMoonSession posts to Moon's local auth logout route", async () => {
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), "/api/moon/auth/logout");
    assert.equal(options.method, "POST");
    return new Response(JSON.stringify({ok: true}), {
      status: 200,
      headers: {"Content-Type": "application/json"}
    });
  };

  try {
    const result = await logoutMoonSession();
    assert.equal(result.ok, true);
    assert.deepEqual(result.payload, {ok: true});
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("profile route helpers classify /profile cleanly", () => {
  assert.equal(buildProfilePath(), "/profile");
  assert.equal(classifyPathname("/profile"), "profile");
});

test("user-next route helpers build canonical typed Moon paths", () => {
  assert.equal(buildLibraryPath("Web Toon"), "/library?type=web-toon");
  assert.equal(classifyPathname("/browse"), "library");
  assert.equal(buildTitlePath("Web Toon", "dan-da-dan"), "/title/web-toon/dan-da-dan");
  assert.equal(buildReaderPath("Web Toon", "dan-da-dan", "chapter-1"), "/reader/web-toon/dan-da-dan/chapter-1");
  assert.equal(
    buildReaderPathForTitleTarget({
      id: "dan-da-dan",
      libraryTypeSlug: "webtoon",
      readerTarget: {chapterId: "chapter-1"}
    }),
    "/reader/webtoon/dan-da-dan/chapter-1"
  );
  assert.equal(
    buildReaderPathForTitleTarget({id: "dan-da-dan", libraryTypeSlug: "webtoon", readerTarget: null}),
    "/title/webtoon/dan-da-dan"
  );
});

test("user-next library types hide zero-count buckets", () => {
  const types = getLibraryTypes({
    manga: 1992,
    manhwa: 263,
    manhua: 86,
    webtoon: 0,
    comic: 0,
    oel: 13
  });

  assert.deepEqual(types, [
    {slug: "manga", label: "Manga", count: 1992},
    {slug: "manhwa", label: "Manhwa", count: 263},
    {slug: "manhua", label: "Manhua", count: 86},
    {slug: "oel", label: "OEL", count: 13}
  ]);
  assert.equal(types.some((entry) => entry.count === 0), false);
});

test("user-next library types keep positive supported and unknown buckets dynamic", () => {
  assert.deepEqual(getLibraryTypes({
    manga: 1,
    webtoon: 2,
    comic: 3,
    light_novel: 4
  }), [
    {slug: "manga", label: "Manga", count: 1},
    {slug: "webtoon", label: "Webtoon", count: 2},
    {slug: "comic", label: "Comic", count: 3},
    {slug: "light-novel", label: "Light Novel", count: 4}
  ]);
  assert.deepEqual(getLibraryTypes(), []);
  assert.equal(getLibraryTypeCount({Webtoon: 2}, "webtoon"), 2);
});
