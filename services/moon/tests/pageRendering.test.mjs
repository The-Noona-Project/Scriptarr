import test from "node:test";
import assert from "node:assert/strict";

import {renderAddPage} from "../apps/admin/assets/pages/addPage.js";
import {renderApiPage} from "../apps/admin/assets/pages/apiPage.js";
import {renderDiscordPage} from "../apps/admin/assets/pages/discordPage.js";
import {renderOverviewPage} from "../apps/admin/assets/pages/overviewPage.js";
import {renderRequestsPage as renderAdminRequestsPage} from "../apps/admin/assets/pages/requestsPage.js";
import {renderSettingsPage} from "../apps/admin/assets/pages/settingsPage.js";
import {renderAdminShell} from "../apps/admin/assets/shell.js";
import {loadBrowsePage, renderBrowsePage} from "../apps/user/assets/pages/browsePage.js";
import {renderHomePage} from "../apps/user/assets/pages/homePage.js";
import {renderReaderPage} from "../apps/user/assets/pages/readerPage.js";
import {renderRequestsPage as renderUserRequestsPage} from "../apps/user/assets/pages/requestsPage.js";
import {renderTitlePage} from "../apps/user/assets/pages/titlePage.js";

test("home page shows branded empty-library copy and typed featured links", () => {
  const emptyHtml = renderHomePage({
    ok: true,
    payload: {
      latestTitles: [],
      continueReading: [],
      following: [],
      requests: []
    }
  }, {
    branding: {siteName: "Pax Library"}
  });

  assert.doesNotMatch(emptyHtml, /Featured now/);
  assert.match(emptyHtml, /Library is empty/);
  assert.match(emptyHtml, /No titles have been imported into Pax Library yet/);

  const featuredHtml = renderHomePage({
    ok: true,
    payload: {
      latestTitles: [{
        id: "dan-da-dan",
        title: "Dandadan",
        libraryTypeSlug: "webtoon",
        libraryTypeLabel: "Webtoon",
        mediaType: "webtoon",
        chapters: [{id: "chapter-166"}]
      }],
      continueReading: [],
      following: [],
      requests: []
    }
  });

  assert.match(featuredHtml, /href="\/title\/webtoon\/dan-da-dan"/);
  assert.match(featuredHtml, /href="\/reader\/webtoon\/dan-da-dan\/chapter-166"/);

  const continueReadingHtml = renderHomePage({
    ok: true,
    payload: {
      latestTitles: [],
      continueReading: [{
        titleId: "solo-leveling",
        title: "Solo Leveling",
        mediaType: "manga",
        libraryTypeSlug: "manga",
        bookmark: {
          chapterId: "chapter-12"
        },
        positionRatio: 0.5
      }],
      following: [],
      requests: []
    }
  });

  assert.match(continueReadingHtml, /href="\/reader\/manga\/solo-leveling\/chapter-12"/);
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
    route: {id: "browse", params: {}},
    searchParams: new URLSearchParams()
  });

  assert.equal(result.libraryEmpty, true);
  const html = renderBrowsePage(result, {branding: {siteName: "Pax Library"}});
  assert.match(html, /Library is empty/);
  assert.match(html, /Pax Library/);
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
            libraryTypeSlug: "manga",
            libraryTypeLabel: "Manga",
            author: "Eiichiro Oda",
            tags: ["adventure"],
            aliases: []
          }]
        }
      })
    },
    route: {id: "browse", params: {}},
    searchParams: new URLSearchParams("q=naruto")
  });

  assert.equal(result.libraryEmpty, false);
  const html = renderBrowsePage(result);
  assert.match(html, /No titles match/);
  assert.doesNotMatch(html, /Library is empty/);
});

test("title page uses typed reader links", () => {
  const html = renderTitlePage({
    ok: true,
    payload: {
      following: false,
      requests: [],
      title: {
        id: "dan-da-dan",
        title: "Dandadan",
        libraryTypeSlug: "webtoon",
        libraryTypeLabel: "Webtoon",
        mediaType: "webtoon",
        chapters: [{
          id: "chapter-166",
          label: "Chapter 166",
          pageCount: 16,
          available: true
        }]
      }
    }
  });

  assert.match(html, /href="\/reader\/webtoon\/dan-da-dan\/chapter-166"/);
  assert.match(html, /Webtoon/);
});

test("reader page renders typed chapter navigation, scrubber, and thumbnail navigation", () => {
  const html = renderReaderPage({
    ok: true,
    payload: {
      title: {
        id: "dan-da-dan",
        title: "Dandadan",
        libraryTypeSlug: "webtoon",
        libraryTypeLabel: "Webtoon",
        mediaType: "webtoon"
      },
      chapter: {
        id: "chapter-166",
        label: "Chapter 166"
      },
      manifest: {
        title: {
          id: "dan-da-dan",
          libraryTypeSlug: "webtoon",
          mediaType: "webtoon"
        },
        chapters: [
          {id: "chapter-165", label: "Chapter 165", pageCount: 12},
          {id: "chapter-166", label: "Chapter 166", pageCount: 13},
          {id: "chapter-167", label: "Chapter 167", pageCount: 14}
        ]
      },
      pages: [
        {index: 0, label: "Page 1", src: "/page/0"},
        {index: 1, label: "Page 2", src: "/page/1"}
      ],
      bookmarks: [{pageIndex: 1, label: "Page 2"}],
      preferences: {
        readingMode: "webtoon",
        pageFit: "width",
        showSidebar: true,
        showPageNumbers: true
      }
    }
  });

  assert.match(html, /href="\/reader\/webtoon\/dan-da-dan\/chapter-165"/);
  assert.match(html, /href="\/reader\/webtoon\/dan-da-dan\/chapter-167"/);
  assert.match(html, /Thumbnail scrubber/);
  assert.match(html, /reader-page-slider/);
  assert.match(html, /Bookmark page/);
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

test("settings page renders branding controls and LocalAI AIO guidance", () => {
  const html = renderSettingsPage({
    ok: true,
    payload: {
      branding: {
        siteName: "Pax Library"
      },
      ravenVpn: {},
      metadataProviders: {providers: []},
      downloadProviders: {providers: [{id: "weebcentral", name: "WeebCentral", scopes: ["manga"], enabled: true, priority: 10}]},
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

  assert.match(html, /value="Pax Library"/);
  assert.match(html, /LocalAI AIO preset/);
  assert.match(html, /NVIDIA CUDA 12 AIO/);
  assert.match(html, /latest-aio-gpu-nvidia-cuda-12/);
  assert.match(html, /still starting/);
  assert.match(html, /Install LocalAI AIO image/);
  assert.match(html, /value="gpt-4"/);
  assert.match(html, /Download providers/);
  assert.match(html, /WeebCentral/);
});

test("api page renders enable controls, docs links, and key actions", () => {
  const html = renderApiPage({
    ok: true,
    payload: {
      enabled: true,
      lastRotatedAt: "2026-04-19T12:00:00.000Z"
    }
  });

  assert.match(html, /Public Moon API/);
  assert.match(html, /Enable trusted automation requests/);
  assert.match(html, /Open Swagger UI/);
  assert.match(html, /Open OpenAPI JSON/);
  assert.match(html, /Generate API key|Regenerate API key/);
  assert.match(html, /X-Scriptarr-Api-Key/);
});

test("discord page renders workflow settings, runtime status, and onboarding preview", () => {
  const html = renderDiscordPage({
    ok: true,
    payload: {
      settings: {
        guildId: "123456789012345678",
        superuserId: "253987219969146890",
        onboarding: {
          channelId: "987654321098765432",
          template: "Welcome to {guild_name}, {user_mention}! Start reading at {moon_url}"
        },
        commands: {
          request: {
            enabled: true,
            roleId: "555555555555555555"
          },
          downloadall: {
            enabled: true,
            roleId: ""
          }
        }
      },
      runtime: {
        authConfigured: true,
        connected: true,
        registeredGuildId: "123456789012345678",
        warning: "Portal connected without the Server Members intent, so automatic guild-join onboarding is unavailable.",
        capabilities: {
          commandSync: {
            status: "available",
            detail: "Portal is connected and synced against guild 123456789012345678."
          },
          directMessages: {
            status: "available",
            detail: "Portal can receive direct messages."
          },
          onboarding: {
            status: "degraded",
            detail: "Portal connected without the Server Members intent, so automatic guild-join onboarding is unavailable."
          }
        },
        commandInventory: [
          {
            id: "request",
            label: "/request",
            scope: "Guild slash command",
            registered: true,
            status: "Registered",
            guildId: "123456789012345678"
          },
          {
            id: "downloadall",
            label: "downloadall",
            scope: "Direct message",
            registered: true,
            status: "Registered"
          }
        ]
      }
    }
  });

  assert.match(html, /Bot status and command sync/);
  assert.match(html, /123456789012345678/);
  assert.match(html, /253987219969146890/);
  assert.match(html, /Send onboarding test/);
  assert.match(html, /Welcome to \{guild_name\}, \{user_mention\}! Start reading at \{moon_url\}/);
  assert.match(html, /&lt;@253987219969146890&gt;/);
  assert.match(html, /Guild slash command/);
  assert.match(html, /DM-only admin command/);
  assert.match(html, /downloadall/);
  assert.match(html, /Capability warning/);
  assert.match(html, /Command sync/);
  assert.match(html, /Onboarding/);
  assert.match(html, /automatic guild-join onboarding is unavailable/i);
});

test("admin shell renders a session avatar with image and initials fallback", () => {
  const avatarHtml = renderAdminShell({
    route: {
      path: "/admin",
      group: "System",
      title: "Overview",
      description: "Dashboard"
    },
    content: "<p>ok</p>",
    user: {
      username: "CaptainPax",
      role: "owner",
      avatarUrl: "https://cdn.example/avatar.png"
    },
    branding: {siteName: "Pax-Kun"},
    flash: null,
    loginUrl: "/login",
    bootstrap: {ownerClaimed: true}
  });

  assert.match(avatarHtml, /https:\/\/cdn\.example\/avatar\.png/);

  const fallbackHtml = renderAdminShell({
    route: {
      path: "/admin",
      group: "System",
      title: "Overview",
      description: "Dashboard"
    },
    content: "<p>ok</p>",
    user: null,
    branding: {siteName: "Pax-Kun"},
    flash: null,
    loginUrl: "/login",
    bootstrap: {ownerClaimed: true}
  });

  assert.match(fallbackHtml, />NS<\/span>/);
});

test("user requests page renders intake search results and unavailable history states", () => {
  const html = renderUserRequestsPage({
    ok: true,
    query: "dandadan",
    payload: {
      search: {
        query: "dandadan",
        results: [{
          canonicalTitle: "Dandadan",
          availability: "available",
          type: "webtoon",
          metadata: {
            provider: "mangadex",
            title: "Dandadan",
            summary: "Aliens and yokai."
          },
          download: {
            providerName: "WeebCentral",
            titleName: "Dandadan",
            titleUrl: "https://weebcentral.com/series/dan-da-dan"
          }
        }]
      },
      requests: [{
        title: "The Fable",
        status: "unavailable",
        updatedAt: "2026-04-19T12:00:00.000Z",
        details: {
          query: "the fable",
          selectedMetadata: {provider: "anilist"},
          selectedDownload: null
        },
        availability: "unavailable"
      }]
    }
  });

  assert.match(html, /Search metadata, then submit/);
  assert.match(html, /WeebCentral/);
  assert.match(html, /Save as unavailable|Send to moderation/);
  assert.match(html, /The Fable/);
  assert.match(html, /unavailable/i);
});

test("admin add and requests pages render intake-driven moderation data", () => {
  const addHtml = renderAddPage({
    ok: true,
    query: "dandadan",
    payload: {
      results: [{
        canonicalTitle: "Dandadan",
        availability: "available",
        coverUrl: "https://images.example/dandadan.jpg",
        type: "webtoon",
        metadata: {
          provider: "mangadex",
          title: "Dandadan",
          summary: "Aliens and yokai."
        },
        download: {
          providerName: "WeebCentral",
          titleName: "Dandadan",
          titleUrl: "https://weebcentral.com/series/dan-da-dan"
        }
      }]
    }
  });
  assert.match(addHtml, /Search metadata and resolve downloads/);
  assert.match(addHtml, /Queue immediately/);
  assert.match(addHtml, /https:\/\/images\.example\/dandadan\.jpg/);

  const requestsHtml = renderAdminRequestsPage({
    ok: true,
    payload: {
      requests: [{
        id: 1,
        title: "The Fable",
        requestType: "manga",
        source: "moon",
        status: "unavailable",
        notes: "",
        updatedAt: "2026-04-19T12:00:00.000Z",
        availability: "unavailable",
        coverUrl: "https://images.example/fable.jpg",
        details: {
          query: "the fable",
          selectedMetadata: {provider: "anilist"},
          selectedDownload: null
        },
        requestedBy: {
          username: "CaptainPax"
        }
      }]
    }
  });
  assert.match(requestsHtml, /Unified request queue/);
  assert.match(requestsHtml, /Resolve/);
  assert.match(requestsHtml, /anilist/i);
  assert.match(requestsHtml, /https:\/\/images\.example\/fable\.jpg/);
});
