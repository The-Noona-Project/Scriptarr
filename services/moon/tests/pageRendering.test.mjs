import test from "node:test";
import assert from "node:assert/strict";

import {renderOverviewPage} from "../apps/admin/assets/pages/overviewPage.js";
import {renderSettingsPage} from "../apps/admin/assets/pages/settingsPage.js";
import {loadBrowsePage, renderBrowsePage} from "../apps/user/assets/pages/browsePage.js";
import {renderHomePage} from "../apps/user/assets/pages/homePage.js";

test("home page shows an honest empty library state when Raven has no titles", () => {
  const html = renderHomePage({
    ok: true,
    payload: {
      latestTitles: [],
      continueReading: [],
      following: [],
      requests: []
    }
  });

  assert.doesNotMatch(html, /Featured now/);
  assert.match(html, /Library is empty/);
  assert.match(html, /No titles have been imported into Scriptarr yet/);
});

test("browse page explains when the library is truly empty", async () => {
  const result = await loadBrowsePage({
    api: {
      get: async () => ({
        ok: true,
        status: 200,
        payload: {titles: []}
      })
    },
    searchParams: new URLSearchParams()
  });

  assert.equal(result.libraryEmpty, true);
  const html = renderBrowsePage(result);
  assert.match(html, /Library is empty/);
  assert.doesNotMatch(html, /No titles match/);
});

test("browse page keeps the no-match copy when filters hide real titles", async () => {
  const result = await loadBrowsePage({
    api: {
      get: async () => ({
        ok: true,
        status: 200,
        payload: {
          titles: [{
            id: "one-piece",
            title: "One Piece",
            mediaType: "manga",
            author: "Eiichiro Oda",
            tags: ["adventure"],
            aliases: []
          }]
        }
      })
    },
    searchParams: new URLSearchParams("q=naruto")
  });

  assert.equal(result.libraryEmpty, false);
  const html = renderBrowsePage(result);
  assert.match(html, /No titles match/);
  assert.doesNotMatch(html, /Library is empty/);
});

test("admin overview renders an empty focus section when the library has no titles", () => {
  const html = renderOverviewPage({
    ok: true,
    payload: {
      counts: {
        titles: 0,
        activeTasks: 0,
        pendingRequests: 0,
        missingChapters: 0,
        metadataGaps: 0
      },
      services: {},
      queue: [],
      requests: [],
      titles: []
    }
  });

  assert.match(html, /Focus titles/);
  assert.match(html, /Library is empty/);
  assert.match(html, /Moon will surface focus titles here after Raven imports real series/);
});

test("settings page describes LocalAI AIO presets and runtime readiness", () => {
  const html = renderSettingsPage({
    ok: true,
    payload: {
      ravenVpn: {},
      metadataProviders: {providers: []},
      oracle: {
        provider: "localai",
        model: "",
        localAiProfileKey: "nvidia",
        localAiCustomImage: ""
      },
      warden: {
        installed: true,
        running: true,
        ready: false
      }
    }
  });

  assert.match(html, /LocalAI AIO preset/);
  assert.match(html, /NVIDIA CUDA 12 AIO/);
  assert.match(html, /latest-aio-gpu-nvidia-cuda-12/);
  assert.match(html, /still starting/);
  assert.match(html, /Install LocalAI AIO image/);
  assert.match(html, /value="gpt-4"/);
});
