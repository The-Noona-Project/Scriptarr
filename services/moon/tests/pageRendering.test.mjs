import test from "node:test";
import assert from "node:assert/strict";

import {renderOverviewPage} from "../apps/admin/assets/pages/overviewPage.js";
import {renderSettingsPage} from "../apps/admin/assets/pages/settingsPage.js";
import {loadBrowsePage, renderBrowsePage} from "../apps/user/assets/pages/browsePage.js";
import {renderHomePage} from "../apps/user/assets/pages/homePage.js";
import {renderReaderPage} from "../apps/user/assets/pages/readerPage.js";
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
});
