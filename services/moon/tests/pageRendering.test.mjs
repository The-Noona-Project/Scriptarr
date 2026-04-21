import test from "node:test";
import assert from "node:assert/strict";

import {renderAddPage} from "../apps/admin/assets/pages/addPage.js";
import {renderApiPage} from "../apps/admin/assets/pages/apiPage.js";
import {renderCalendarPage} from "../apps/admin/assets/pages/calendarPage.js";
import {renderDiscordPage} from "../apps/admin/assets/pages/discordPage.js";
import {renderLibraryPage} from "../apps/admin/assets/pages/libraryPage.js";
import {renderLibraryTitlePage} from "../apps/admin/assets/pages/libraryTitlePage.js";
import {renderMediaManagementPage} from "../apps/admin/assets/pages/mediaManagementPage.js";
import {renderOverviewPage} from "../apps/admin/assets/pages/overviewPage.js";
import {renderRequestsPage as renderAdminRequestsPage} from "../apps/admin/assets/pages/requestsPage.js";
import {renderSettingsPage} from "../apps/admin/assets/pages/settingsPage.js";
import {renderAdminShell} from "../apps/admin/assets/shell.js";
import {loadBrowsePage, renderBrowsePage} from "../apps/user/assets/pages/browsePage.js";
import {renderHomePage} from "../apps/user/assets/pages/homePage.js";
import {renderReaderPage} from "../apps/user/assets/pages/readerPage.js";
import {renderRequestsPage as renderUserRequestsPage} from "../apps/user/assets/pages/requestsPage.js";
import {renderUserShell} from "../apps/user/assets/shell.js";
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
        coverUrl: "https://images.example/dandadan.jpg",
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
  assert.doesNotMatch(featuredHtml, /series-card/);
  assert.equal((featuredHtml.match(/Dandadan/g) || []).length, 1);

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

test("title page reads the newest chapter and renders source-backed metadata labels", () => {
  const html = renderTitlePage({
    ok: true,
    payload: {
      following: false,
      requests: [],
      title: {
        id: "kenja-no-mago",
        title: "Kenja no Mago",
        libraryTypeSlug: "manga",
        libraryTypeLabel: "Manga",
        mediaType: "manga",
        latestChapter: "94",
        sourceUrl: "https://weebcentral.com/series/kenja-no-mago",
        metadataProvider: "",
        author: "",
        chapters: [
          {
            id: "chapter-79",
            label: "Chapter 79",
            chapterNumber: "79",
            pageCount: 55,
            releaseDate: "2026-04-18T08:00:00.000Z",
            available: true
          },
          {
            id: "chapter-94",
            label: "Chapter 94",
            chapterNumber: "94",
            pageCount: 52,
            releaseDate: "2026-04-20T08:00:00.000Z",
            available: true
          }
        ]
      }
    }
  });

  assert.match(html, /href="\/reader\/manga\/kenja-no-mago\/chapter-94"[^>]*>Read latest/);
  assert.match(html, /<span>Source<\/span><strong>WeebCentral<\/strong>/);
  assert.match(html, /Apr 20, 2026/);
  assert.doesNotMatch(html, /Unmatched|Unknown date|<span>Author<\/span><strong>Unknown<\/strong>/);
});

test("title page keeps plain date-only chapter releases on the same local day", () => {
  const html = renderTitlePage({
    ok: true,
    payload: {
      following: false,
      requests: [],
      title: {
        id: "dr-stone",
        title: "Dr. STONE",
        libraryTypeSlug: "manga",
        libraryTypeLabel: "Manga",
        mediaType: "manga",
        latestChapter: "27",
        chapters: [{
          id: "chapter-27",
          label: "Chapter 27",
          chapterNumber: "27",
          pageCount: 24,
          releaseDate: "2026-04-20",
          available: true
        }]
      }
    }
  });

  assert.match(html, /Apr 20, 2026/);
});

test("reader page renders typed chapter navigation, scrubber, and thumbnail navigation", () => {
  const html = renderReaderPage({
    ok: true,
    payload: {
      title: {
        id: "dan-da-dan",
        title: "Dandadan",
        coverUrl: "https://images.example/dandadan.jpg",
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
  assert.match(html, /reader-cover-chip/);
  assert.match(html, /Chapter 2 of 3/);
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

test("admin library page renders a dense Sonarr-style series index", () => {
  const html = renderLibraryPage({
    ok: true,
    payload: {
      titles: [{
        id: "kenja-no-mago",
        title: "Kenja no Mago",
        coverUrl: "https://images.example/kenja.jpg",
        mediaType: "manga",
        libraryTypeLabel: "Manga",
        libraryTypeSlug: "manga",
        status: "active",
        latestChapter: "94",
        metadataProvider: "mangadex",
        summary: "A young man is reborn into another world.",
        downloadRoot: "/downloads/downloaded/manga/Kenja_no_Mago",
        chapterCount: 94,
        chaptersDownloaded: 94,
        chapters: [{
          id: "chapter-94",
          releaseDate: "2026-04-20T08:00:00.000Z"
        }]
      }]
    }
  });

  assert.match(html, /Series index/);
  assert.match(html, /Search title, author, tag, or provider/);
  assert.match(html, /Coverage/);
  assert.match(html, /Kenja no Mago/);
  assert.match(html, /\/admin\/library\/manga\/kenja-no-mago/);
  assert.match(html, /94\/94/);
});

test("admin library title page renders Sonarr-style hero stats and chapter table", () => {
  const html = renderLibraryTitlePage({
    ok: true,
    payload: {
      title: {
        id: "akame-ga-kill",
        title: "Akame ga Kill!",
        coverUrl: "https://images.example/akame.jpg",
        coverAccent: "#a53d32",
        mediaType: "manga",
        libraryTypeLabel: "Manga",
        libraryTypeSlug: "manga",
        status: "completed",
        latestChapter: "24",
        metadataProvider: "mangadex",
        metadataMatchedAt: "2026-04-20T08:00:00.000Z",
        releaseLabel: "2010",
        author: "Takahiro",
        summary: "Night Raid fights corruption across the Empire.",
        sourceUrl: "https://weebcentral.com/series/akame-ga-kill",
        downloadRoot: "/downloads/downloaded/manga/Akame_ga_Kill",
        workingRoot: "/downloads/downloading/manga/Akame_ga_Kill",
        chapterCount: 24,
        chaptersDownloaded: 24,
        chapters: [{
          id: "chapter-24",
          label: "Chapter 24",
          chapterNumber: "24",
          pageCount: 36,
          releaseDate: "2026-04-20T08:00:00.000Z",
          available: true,
          archivePath: "/downloads/downloaded/manga/Akame_ga_Kill/Akame ga Kill ch024.cbz"
        }]
      },
      requests: [{
        id: "request-1",
        title: "Akame ga Kill!",
        status: "completed",
        source: "moon",
        updatedAt: "2026-04-20T08:00:00.000Z"
      }],
      activeTasks: [],
      recentTasks: [{
        taskId: "task-1",
        titleName: "Download Akame ga Kill!",
        status: "completed",
        percent: 100,
        message: "Catalog persisted.",
        updatedAt: "2026-04-20T08:05:00.000Z"
      }]
    }
  });

  assert.match(html, /Series facts/);
  assert.match(html, /Cataloged chapter table/);
  assert.match(html, /Open user title page/);
  assert.match(html, /Lifecycle/);
  assert.match(html, /completed/i);
  assert.match(html, /Akame ga Kill ch024\.cbz/);
});

test("admin calendar page renders a Sonarr-style month view with agenda controls", () => {
  const html = renderCalendarPage({
    ok: true,
    payload: {
      entries: [{
        titleId: "dr-stone",
        title: "Dr. STONE",
        coverUrl: "https://images.example/dr-stone.jpg",
        libraryTypeLabel: "Manga",
        libraryTypeSlug: "manga",
        metadataProvider: "mangadex",
        titleStatus: "completed",
        chapterId: "chapter-27",
        chapterLabel: "Chapter 27",
        pageCount: 24,
        releaseDate: "2026-04-15T08:00:00.000Z",
        available: true
      }, {
        titleId: "kill-blue",
        title: "KILL BLUE",
        libraryTypeLabel: "Manga",
        libraryTypeSlug: "manga",
        metadataProvider: "mangadex",
        chapterId: "chapter-3",
        chapterLabel: "Chapter 3",
        pageCount: 19,
        releaseDate: "2026-04-18T08:00:00.000Z",
        available: true
      }],
      undatedCount: 2
    }
  });

  assert.match(html, /Library release calendar/);
  assert.match(html, /Month/);
  assert.match(html, /Agenda/);
  assert.match(html, /Dr\. STONE/);
  assert.match(html, /KILL BLUE/);
  assert.match(html, /undated chapter/);
  assert.match(html, /completed/i);
});

test("settings page renders branding controls and LocalAI AIO guidance", () => {
  const html = renderSettingsPage({
    ok: true,
    payload: {
      branding: {
        siteName: "Pax Library"
      },
      ravenVpn: {},
      metadataProviders: {
        providers: [
          {id: "mangadex", name: "MangaDex", scopes: ["manga", "webtoon"], enabled: true, priority: 10},
          {id: "animeplanet", name: "Anime-Planet", scopes: ["manga", "webtoon"], enabled: true, priority: 25},
          {id: "mangaupdates", name: "MangaUpdates", scopes: ["manga", "webtoon"], enabled: false, priority: 30}
        ]
      },
      downloadProviders: {
        providers: [
          {id: "weebcentral", name: "WeebCentral", scopes: ["manga"], enabled: true, priority: 10},
          {id: "mangadex", name: "MangaDex", scopes: ["manga", "webtoon"], enabled: true, priority: 20}
        ]
      },
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
  assert.match(html, /MangaDex/);
  assert.match(html, /Anime-Planet/);
  assert.match(html, /WeebCentral-only/);
});

test("media management page renders per-type naming profiles and template previews", () => {
  const html = renderMediaManagementPage({
    ok: true,
    payload: {
      naming: {
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
          },
          webtoon: {
            chapterTemplate: "{title} ep{chapter_padded}.cbz",
            pageTemplate: "{chapter_padded}-{page_padded}{ext}",
            chapterPad: 3,
            pagePad: 3,
            volumePad: 2
          }
        }
      }
    }
  });

  assert.match(html, /Type-based naming profiles/);
  assert.match(html, /Per-type download naming/);
  assert.match(html, /Tower of God ep012\.cbz/);
  assert.match(html, /Blue Box ch012\.cbz/);
  assert.match(html, /Supported tokens/);
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

test("user shell only shows the admin entry to admin-capable sessions", () => {
  const memberHtml = renderUserShell({
    route: {
      id: "home",
      path: "/",
      title: "Home",
      description: "Continue reading, latest arrivals, and current requests.",
      navLabel: "Home",
      params: {}
    },
    content: "<p>ok</p>",
    user: {
      username: "ReaderOne",
      role: "member",
      permissions: ["create_requests"]
    },
    branding: {siteName: "Pax-Kun"},
    flash: null,
    loginUrl: "/login",
    bootstrap: {ownerClaimed: true}
  });

  assert.doesNotMatch(memberHtml, />Admin<\/a>/);

  const adminHtml = renderUserShell({
    route: {
      id: "home",
      path: "/",
      title: "Home",
      description: "Continue reading, latest arrivals, and current requests.",
      navLabel: "Home",
      params: {}
    },
    content: "<p>ok</p>",
    user: {
      username: "CaptainPax",
      role: "owner",
      permissions: ["admin", "manage_settings"]
    },
    branding: {siteName: "Pax-Kun"},
    flash: null,
    loginUrl: "/login",
    bootstrap: {ownerClaimed: true}
  });

  assert.match(adminHtml, /href="\/admin"[^>]*>Admin<\/a>/);
});

test("user requests page renders intake search results and unavailable history states", () => {
  const html = renderUserRequestsPage({
    ok: true,
    query: "dandadan",
    payload: {
      search: {
        query: "dandadan",
        results: [{
          canonicalTitle: "One Piece",
          editionLabel: "Official Colored",
          availability: "download-ready",
          type: "manga",
          metadataMatches: [{
            provider: "mangadex",
            title: "One Piece (Official Colored)",
            summary: "Pirates, now in color."
          }],
          downloadTarget: {
            providerName: "WeebCentral",
            providerId: "weebcentral",
            titleName: "One Piece (Color)",
            titleUrl: "https://weebcentral.com/series/one-piece-color"
          },
          targetIdentity: {
            workKey: "weebcentral:https://weebcentral.com/series/one-piece-color",
            providerId: "weebcentral",
            titleUrl: "https://weebcentral.com/series/one-piece-color"
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
  assert.match(html, /Official Colored/);
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
        canonicalTitle: "One Piece",
        editionLabel: "Official Colored",
        availability: "download-ready",
        coverUrl: "https://images.example/dandadan.jpg",
        type: "manga",
        metadataMatches: [{
          provider: "mangadex",
          title: "One Piece (Official Colored)",
          summary: "Pirates, now in color."
        }],
        downloadTarget: {
          providerName: "WeebCentral",
          providerId: "weebcentral",
          titleName: "One Piece (Color)",
          titleUrl: "https://weebcentral.com/series/one-piece-color"
        },
        targetIdentity: {
          workKey: "weebcentral:https://weebcentral.com/series/one-piece-color",
          providerId: "weebcentral",
          titleUrl: "https://weebcentral.com/series/one-piece-color"
        }
      }]
    }
  });
  assert.match(addHtml, /Search metadata and resolve downloads/);
  assert.match(addHtml, /Queue immediately/);
  assert.match(addHtml, /https:\/\/images\.example\/dandadan\.jpg/);
  assert.match(addHtml, /Official Colored/);

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
