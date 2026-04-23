import test from "node:test";
import assert from "node:assert/strict";

import {loadMoonChromeContext, logoutMoonSession, requestJson} from "../apps/user-next/lib/api.js";
import {
  buildLibraryPath,
  buildProfilePath,
  buildReaderPath,
  buildTitlePath,
  classifyPathname,
  getLibraryTypes
} from "../apps/user-next/lib/routes.js";

test("loadMoonChromeContext normalizes nested auth payloads from Moon auth status", async () => {
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const href = String(url);

    if (href === "/api/moon/v3/public/branding") {
      return new Response(JSON.stringify({siteName: "Pax-Kun"}), {
        status: 200,
        headers: {"Content-Type": "application/json"}
      });
    }

    if (href === "/api/moon/auth/status") {
      return new Response(JSON.stringify({
        authenticated: true,
        user: {
          username: "CaptainPax",
          role: "owner",
          permissions: ["admin"],
          avatarUrl: "https://cdn.discordapp.com/avatars/captain.png"
        }
      }), {
        status: 200,
        headers: {"Content-Type": "application/json"}
      });
    }

    if (href === "/api/moon/auth/bootstrap-status") {
      return new Response(JSON.stringify({ownerClaimed: true}), {
        status: 200,
        headers: {"Content-Type": "application/json"}
      });
    }

    if (href === "/api/moon/auth/discord/url") {
      return new Response(JSON.stringify({oauthUrl: "https://discord.example/login"}), {
        status: 200,
        headers: {"Content-Type": "application/json"}
      });
    }

    throw new Error(`Unexpected URL ${href}`);
  };

  try {
    const context = await loadMoonChromeContext();
    assert.deepEqual(context.branding, {siteName: "Pax-Kun"});
    assert.deepEqual(context.auth, {
      username: "CaptainPax",
      role: "owner",
      permissions: ["admin"],
      avatarUrl: "https://cdn.discordapp.com/avatars/captain.png"
    });
    assert.equal(context.loginUrl, "https://discord.example/login");
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
  assert.equal(buildLibraryPath("Web Toon"), "/library/web-toon");
  assert.equal(buildTitlePath("Web Toon", "dan-da-dan"), "/title/web-toon/dan-da-dan");
  assert.equal(buildReaderPath("Web Toon", "dan-da-dan", "chapter-1"), "/reader/web-toon/dan-da-dan/chapter-1");
});

test("user-next library types stay trimmed to the supported Moon buckets", () => {
  assert.deepEqual(getLibraryTypes(), [
    {slug: "manga", label: "Manga"},
    {slug: "manhwa", label: "Manhwa"},
    {slug: "manhua", label: "Manhua"},
    {slug: "webtoon", label: "Webtoon"},
    {slug: "comic", label: "Comic"},
    {slug: "oel", label: "OEL"}
  ]);
});
