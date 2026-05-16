/**
 * @file Scriptarr Sage module: services/sage/tests/sageApp.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.NODE_ENV = "test";
process.env.SCRIPTARR_VAULT_DRIVER = "memory";
process.env.SCRIPTARR_SERVICE_TOKENS = JSON.stringify({
  "scriptarr-sage": "sage-dev-token",
  "scriptarr-vault": "vault-dev-token",
  "scriptarr-portal": "portal-dev-token",
  "scriptarr-oracle": "oracle-dev-token",
  "scriptarr-raven": "raven-dev-token",
  "scriptarr-warden": "warden-dev-token"
});
process.env.SCRIPTARR_SERVICE_TOKEN = "sage-dev-token";
process.env.SUPERUSER_ID = "owner-1";

const {createVaultApp} = await import("../../vault/lib/createVaultApp.mjs");
const {createSageApp} = await import("../lib/createSageApp.mjs");

const originalFetch = globalThis.fetch;

const closeServer = (server) => new Promise((resolve, reject) => {
  server?.closeIdleConnections?.();
  server?.closeAllConnections?.();
  server?.close((error) => error ? reject(error) : resolve());
});

/**
 * Read a test proxy request body into a buffer for forwarding.
 *
 * @param {http.IncomingMessage} request
 * @returns {Promise<Buffer>}
 */
const readRequestBody = (request) => new Promise((resolve, reject) => {
  const chunks = [];
  request.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  request.on("end", () => resolve(Buffer.concat(chunks)));
  request.on("error", reject);
});

/**
 * Create a Vault proxy that forwards every request except reader-target
 * lookups, which mimic the HTML error returned by an older prod Vault image.
 *
 * @param {{targetBaseUrl: string}} options
 * @returns {{server: http.Server, calls: {readerTargets: number, forwarded: number}}}
 */
const createVaultReaderTargetFailureProxy = ({targetBaseUrl}) => {
  const calls = {
    readerTargets: 0,
    forwarded: 0
  };
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/api/service/reader-targets/")) {
      calls.readerTargets += 1;
      response.writeHead(500, {"Content-Type": "text/html"});
      response.end("<!DOCTYPE html><title>Error</title><h1>Reader targets unavailable</h1>");
      return;
    }

    readRequestBody(request)
      .then(async (body) => {
        calls.forwarded += 1;
        const headers = {};
        for (const [key, value] of Object.entries(request.headers || {})) {
          if (key.toLowerCase() !== "host" && value != null) {
            headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
          }
        }
        const upstream = await originalFetch(`${targetBaseUrl}${request.url || "/"}`, {
          method: request.method,
          headers,
          body: ["GET", "HEAD"].includes(String(request.method || "GET").toUpperCase()) ? undefined : body
        });
        const responseHeaders = {};
        upstream.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        response.writeHead(upstream.status, responseHeaders);
        response.end(await upstream.text());
      })
      .catch((error) => {
        response.writeHead(500, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        }));
      });
  });

  return {server, calls};
};

const defaultLibraryTitle = Object.freeze({
  id: "dan-da-dan",
  title: "Dandadan",
  mediaType: "webtoon",
  libraryTypeLabel: "Webtoon",
  libraryTypeSlug: "webtoon",
  status: "watching",
  latestChapter: "166",
  coverAccent: "#ff6a3d",
  coverUrl: "https://images.example/dandadan.jpg",
  summary: "Aliens and yokai.",
  releaseLabel: "2021",
  chapterCount: 166,
  chaptersDownloaded: 6,
  author: "Yukinobu Tatsu",
  tags: ["action"],
  aliases: ["Dan Da Dan"],
  metadataProvider: "mangadex",
  metadataMatchedAt: "2026-04-18T00:00:00.000Z",
  relations: [],
  chapters: [{
    id: "dandadan-c166",
    label: "Chapter 166",
    chapterNumber: "166",
    pageCount: 3,
    releaseDate: "2026-04-14",
    available: true
  }, {
    id: "dandadan-c167",
    label: "Chapter 167",
    chapterNumber: "167",
    pageCount: 2,
    releaseDate: "2026-04-21",
    available: true
  }]
});

const ownerSmokeLibraryTitle = Object.freeze({
  ...defaultLibraryTitle,
  id: "mob-psycho-100",
  title: "Mob Psycho 100",
  aliases: ["Mob Psycho Hyaku"],
  coverUrl: "https://images.example/mob-psycho-100.jpg",
  chapters: defaultLibraryTitle.chapters.map((chapter, index) => ({
    ...chapter,
    id: `mob-psycho-100-c${index + 1}`,
    label: `Chapter ${index + 1}`,
    chapterNumber: String(index + 1)
  }))
});

const defaultIntakePayload = Object.freeze({
  query: "dandadan",
  requestType: "webtoon",
  selectedMetadata: {
    provider: "mangadex",
    providerSeriesId: "md-1",
    title: "Dandadan",
    type: "webtoon"
  },
  selectedDownload: {
    providerId: "weebcentral",
    titleName: "Dandadan",
    titleUrl: "https://weebcentral.com/series/dan-da-dan",
    requestType: "webtoon",
    libraryTypeLabel: "Webtoon",
    libraryTypeSlug: "webtoon"
  }
});

/**
 * Create a small dependency stub for Sage's Raven, Warden, Portal, and Oracle
 * calls so the Moon v3 broker routes can be tested in isolation.
 *
 * @param {{libraryTitles?: Array<Record<string, unknown>>, downloadTasks?: Array<Record<string, unknown>>, downloadRuntimeReloadStatus?: number, syncLinkedRequestOnQueue?: boolean}} [options]
 * @returns {Promise<{server: http.Server, calls: Record<string, number>}>}
 */
const createDependencyStub = ({
  libraryTitles = [defaultLibraryTitle],
  downloadTasks = [],
  downloadRuntimeReloadStatus = 200,
  syncLinkedRequestOnQueue = false
} = {}) => {
  const calls = {
    health: 0,
    bootstrap: 0,
    runtime: 0,
    queue: 0,
    bulkQueue: 0,
    bulkRunCreate: 0,
    bulkRunStatus: 0,
    bulkRunContinue: 0,
    bulkRunCancel: 0,
    vpnTest: 0,
    downloadRuntimeReload: 0,
    contentResetPreview: 0,
    contentResetExecute: 0,
    logs: 0,
    updatesList: 0,
    updatesCheck: 0,
    updatesInstall: 0,
    modelOptions: 0,
    localAiProfile: 0,
    localAiConfig: 0,
    localAiInstall: 0,
    localAiStart: 0,
    releaseNotificationTest: 0,
    library: 0,
    libraryCard: 0,
    metadataIdentify: 0,
    metadataSearchUrls: []
  };
  let currentLibraryTitles = [...libraryTitles];
  let currentDownloadTasks = [...downloadTasks];
  const libraryById = new Map();
  const syncLibraryIndex = () => {
    libraryById.clear();
    for (const title of currentLibraryTitles) {
      libraryById.set(title.id, title);
    }
  };
  syncLibraryIndex();
  const buildReaderManifest = (title) => ({
    title,
    chapters: title.chapters || []
  });
  const buildReaderChapterPayload = (title, chapterId) => {
    const chapters = title.chapters || [];
    const chapterIndex = chapters.findIndex((entry) => entry.id === chapterId);
    const chapter = chapters[chapterIndex];

    if (!chapter) {
      return null;
    }

    return {
      title,
      chapter,
      previousChapterId: chapters[chapterIndex - 1]?.id || null,
      nextChapterId: chapters[chapterIndex + 1]?.id || null,
      pages: Array.from({length: chapter.pageCount || 1}, (_value, index) => ({
        index,
        label: `Page ${index + 1}`,
        src: `https://reader.invalid/${title.id}/${chapter.id}/${index}.svg`
      }))
    };
  };

  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      calls.health += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({ok: true, service: "scriptarr-warden-health", dockerSocketAvailable: true}));
      return;
    }

    if (request.url === "/api/commands") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        commands: [
          {name: "ding", description: "Bot health"},
          {name: "request", description: "Create a request"},
          {name: "subscribe", description: "Follow a title"}
        ]
      }));
      return;
    }

    if (request.url === "/api/runtime/discord/reload" && request.method === "POST") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        ok: true,
        mode: "ready",
        connected: true,
        registeredGuildId: "guild-123"
      }));
      return;
    }

    if (request.url === "/api/onboarding/test" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body || "{}");
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          ok: true,
          channelId: payload?.settings?.onboarding?.channelId || "",
          rendered: payload?.rendered || "Welcome to Scriptarr, CaptainPax!"
        }));
      });
      return;
    }

    if (request.url === "/api/notifications/release/test" && request.method === "POST") {
      calls.releaseNotificationTest += 1;
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body || "{}");
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          ok: true,
          channelId: payload?.notification?.channelId || "",
          notification: payload?.notification || {}
        }));
      });
      return;
    }

    if (request.url === "/api/bootstrap") {
      calls.bootstrap += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        services: [{name: "scriptarr-moon", image: "scriptarr-moon:latest", containerName: "scriptarr-moon"}],
        managedNetworkName: "scriptarr-network-bootstrap",
        mysql: {
          mode: "external"
        }
      }));
      return;
    }

    if (request.url === "/api/runtime") {
      calls.runtime += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        stackMode: "test",
        managedNetworkName: "scriptarr-network-runtime",
        mysql: {
          mode: "selfhost"
        },
        warden: {
          dockerSocketAvailable: true,
          attachedToManagedNetwork: true
        }
      }));
      return;
    }

    if (request.url?.startsWith("/api/logs")) {
      calls.logs += 1;
      const url = new URL(`http://stub${request.url}`);
      const selectedService = url.searchParams.get("service") || "scriptarr-warden";
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        services: [
          {name: "scriptarr-warden", label: "Warden", containerName: "scriptarr-warden"},
          {name: "scriptarr-moon", label: "Moon", containerName: "scriptarr-moon"}
        ],
        selectedService,
        selectedContainer: selectedService,
        entries: [{
          id: "line-1",
          timestamp: "2026-04-25T10:00:00.000Z",
          level: url.searchParams.get("level") || "info",
          message: `stub log ${url.searchParams.get("q") || ""}`.trim()
        }],
        generatedAt: "2026-04-25T10:01:00.000Z",
        redacted: true,
        lines: Number(url.searchParams.get("lines") || 250)
      }));
      return;
    }

    if (request.url === "/api/updates") {
      calls.updatesList += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        checkedAt: "2026-04-25T10:02:00.000Z",
        services: [{
          name: "scriptarr-moon",
          image: "scriptarr-moon:latest",
          runningImageLabel: "old-image",
          localImageLabel: "new-image",
          updateAvailable: true,
          running: true,
          health: "healthy"
        }],
        job: null
      }));
      return;
    }

    if (request.url === "/api/updates/check" && request.method === "POST") {
      calls.updatesCheck += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        checkedAt: "2026-04-25T10:03:00.000Z",
        services: [{
          name: "scriptarr-moon",
          image: "scriptarr-moon:latest",
          runningImageLabel: "old-image",
          localImageLabel: "new-image",
          updateAvailable: true,
          running: true,
          health: "healthy"
        }],
        job: null
      }));
      return;
    }

    if (request.url === "/api/updates/install" && request.method === "POST") {
      calls.updatesInstall += 1;
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body || "{}");
        response.writeHead(202, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          checkedAt: "2026-04-25T10:04:00.000Z",
          services: [{
            name: "scriptarr-moon",
            image: "scriptarr-moon:latest",
            runningImageLabel: "old-image",
            localImageLabel: "new-image",
            updateAvailable: true,
            running: true,
            health: "healthy"
          }],
          job: {
            jobId: "update-test",
            status: "running",
            requestedServices: payload.services || [],
            tasks: [{
              taskId: "update-test_pull-images",
              label: "Pull candidate images",
              status: "running",
              percent: 10,
              message: "Checking images."
            }]
          }
        }));
      });
      return;
    }

    if (request.url === "/api/status") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        ok: true,
        source: "oracle-status-broker"
      }));
      return;
    }

    if (request.url.startsWith("/api/models")) {
      calls.modelOptions += 1;
      const url = new URL(request.url, "http://scriptarr.test");
      const provider = url.searchParams.get("provider") === "localai" ? "localai" : "openai";
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        provider,
        selectedModel: provider === "localai" ? "gpt-4" : "gpt-4.1-mini",
        models: provider === "localai"
          ? [{id: "gpt-4", label: "gpt-4"}]
          : [{id: "gpt-4.1-mini", label: "gpt-4.1-mini"}],
        source: "live",
        ok: true,
        error: null
      }));
      return;
    }

    if (request.url === "/api/chat" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          ok: true,
          reply: `stubbed:${JSON.parse(body || "{}").message || ""}`
        }));
      });
      return;
    }

    if (request.url?.startsWith("/v1/library")) {
      const url = new URL(request.url, "http://scriptarr.test");
      if (url.pathname === "/v1/library") {
        if (url.searchParams.get("view") === "card") {
          calls.libraryCard += 1;
          const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") || "60", 10) || 60));
          const cursor = Math.max(0, Number.parseInt(url.searchParams.get("cursor") || "0", 10) || 0);
          const exactIds = Array.from(new Set(String(url.searchParams.get("ids") || "")
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)));
          const cardTitles = currentLibraryTitles.filter((title) => !exactIds.length || exactIds.includes(title.id)).map((title) => ({
            id: title.id,
            title: title.title,
            mediaType: title.mediaType,
            libraryTypeLabel: title.libraryTypeLabel,
            libraryTypeSlug: title.libraryTypeSlug,
            status: title.status,
            latestChapter: title.latestChapter,
            coverAccent: title.coverAccent,
            coverUrl: title.coverUrl,
            summary: title.summary,
            releaseLabel: title.releaseLabel,
            chapterCount: title.chapterCount,
            chaptersDownloaded: title.chaptersDownloaded,
            author: title.author,
            tags: title.tags || [],
            aliases: title.aliases || [],
            updatedAt: title.updatedAt || "2026-04-25T00:00:00.000Z"
          })).sort((left, right) => exactIds.length ? exactIds.indexOf(left.id) - exactIds.indexOf(right.id) : 0);
          const page = cardTitles.slice(cursor, cursor + pageSize);
          response.writeHead(200, {"Content-Type": "application/json"});
          response.end(JSON.stringify({
            titles: page,
            counts: {total: cardTitles.length, byLetter: {D: cardTitles.length}, byType: {webtoon: cardTitles.length}},
            pageInfo: {
              cursor: String(cursor),
              nextCursor: cursor + page.length < cardTitles.length ? String(cursor + page.length) : "",
              hasMore: cursor + page.length < cardTitles.length,
              pageSize,
              total: cardTitles.length
            }
          }));
          return;
        }
        calls.library += 1;
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify({titles: currentLibraryTitles}));
        return;
      }
    }

    if (request.url?.endsWith("/repair-options") && request.url.startsWith("/v1/library/")) {
      const titleId = decodeURIComponent(String(request.url).replace("/v1/library/", "").replace("/repair-options", ""));
      const title = libraryById.get(titleId);
      if (!title) {
        response.writeHead(404, {"Content-Type": "application/json"});
        response.end(JSON.stringify({error: "Title not found."}));
        return;
      }
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        titleId,
        currentSourceUrl: title.sourceUrl || "",
        options: [{
          providerId: "weebcentral",
          providerName: "WeebCentral",
          titleName: title.title,
          titleUrl: `https://weebcentral.com/series/${title.id}`,
          chapterCount: Number(title.chapterCount || 0) + 2,
          coverageLabel: `1-${Number(title.chapterCount || 0) + 2} (${Number(title.chapterCount || 0) + 2} chapters)`,
          matchScore: 120,
          warnings: []
        }]
      }));
      return;
    }

    if (request.url?.endsWith("/replace-source") && request.url.startsWith("/v1/library/") && request.method === "POST") {
      const titleId = decodeURIComponent(String(request.url).replace("/v1/library/", "").replace("/replace-source", ""));
      const title = libraryById.get(titleId);
      if (!title) {
        response.writeHead(404, {"Content-Type": "application/json"});
        response.end(JSON.stringify({error: "Title not found."}));
        return;
      }
      response.writeHead(202, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        taskId: "replacement-task-1",
        status: "queued",
        titleId
      }));
      return;
    }

    if (request.url?.startsWith("/v1/library/")) {
      const titleId = decodeURIComponent(String(request.url).replace("/v1/library/", ""));
      const title = libraryById.get(titleId);
      if (!title) {
        response.writeHead(404, {"Content-Type": "application/json"});
        response.end(JSON.stringify({error: "Title not found."}));
        return;
      }
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify(title));
      return;
    }

    if (request.url?.startsWith("/v1/reader/") && !request.url.includes("/page/")) {
      const parts = String(request.url).split("/").filter(Boolean);
      const titleId = decodeURIComponent(parts[2] || "");
      const chapterId = parts[3] ? decodeURIComponent(parts[3]) : "";
      const title = libraryById.get(titleId);

      if (!title) {
        response.writeHead(404, {"Content-Type": "application/json"});
        response.end(JSON.stringify({error: "Title not found."}));
        return;
      }

      if (!chapterId) {
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify(buildReaderManifest(title)));
        return;
      }

      const payload = buildReaderChapterPayload(title, chapterId);
      if (!payload) {
        response.writeHead(404, {"Content-Type": "application/json"});
        response.end(JSON.stringify({error: "Chapter not found."}));
        return;
      }

      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify(payload));
      return;
    }

    if (request.url?.startsWith("/v1/reader/") && request.url.includes("/page/")) {
      response.writeHead(200, {"Content-Type": "image/svg+xml"});
      response.end("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>reader-page</text></svg>");
      return;
    }

    if (request.url === "/v1/downloads/tasks") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify(currentDownloadTasks));
      return;
    }

    if (request.url === "/v1/vpn/test" && request.method === "POST") {
      calls.vpnTest += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        ok: true,
        vpn: {
          state: "armed",
          enabled: true,
          connected: false,
          protected: false,
          runtimeCapable: true,
          settingsFresh: true,
          region: "us_california"
        }
      }));
      return;
    }

    if (request.url === "/v1/downloads/runtime/reload" && request.method === "POST") {
      calls.downloadRuntimeReload += 1;
      response.writeHead(downloadRuntimeReloadStatus, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        error: downloadRuntimeReloadStatus >= 400 ? "Raven reload failed." : undefined,
        activeTitleDownloads: 4,
        queue: {
          activeSlots: 4,
          totalSlots: 4,
          runningSlots: 0
        }
      }));
      return;
    }

    if (request.url === "/v1/system/content-reset/preview") {
      calls.contentResetPreview += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        counts: {
          downloadingFolders: 3,
          downloadedFolders: 7,
          activeTasks: currentDownloadTasks.length
        }
      }));
      return;
    }

    if (request.url === "/v1/system/content-reset" && request.method === "POST") {
      calls.contentResetExecute += 1;
      currentLibraryTitles = [];
      currentDownloadTasks = [];
      syncLibraryIndex();
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        counts: {
          downloadingFolders: 3,
          downloadedFolders: 7,
          activeTasks: 0
        }
      }));
      return;
    }

    if (request.url?.startsWith("/v1/intake/search?query=")) {
      const query = new URL(`http://stub${request.url}`).searchParams.get("query") || "";
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        query,
        results: [{
          metadataProviderId: "mangadex",
          providerSeriesId: "md-1",
          canonicalTitle: "Dandadan",
          aliases: ["Dan Da Dan"],
          type: "webtoon",
          metadata: {
            provider: "mangadex",
            providerSeriesId: "md-1",
            title: "Dandadan",
            summary: "Aliens and yokai.",
            aliases: ["Dan Da Dan"],
            type: "webtoon"
          },
          download: {
            providerId: "weebcentral",
            providerName: "WeebCentral",
            titleName: "Dandadan",
            titleUrl: "https://weebcentral.com/series/dan-da-dan",
            requestType: "webtoon",
            libraryTypeLabel: "Webtoon",
            libraryTypeSlug: "webtoon"
          },
          availability: "available",
          titleUrl: "https://weebcentral.com/series/dan-da-dan"
        }]
      }));
      return;
    }

    if (request.url?.startsWith("/v1/metadata/search?name=")) {
      const query = new URL(`http://stub${request.url}`).searchParams.get("name") || "";
      calls.metadataSearchUrls.push(request.url);
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify([{
        provider: "mangadex",
        providerSeriesId: "md-1",
        title: "Dandadan",
        url: "https://mangadex.org/title/md-1",
        summary: "Aliens and yokai.",
        coverUrl: "https://images.example/dandadan.jpg",
        aliases: ["Dan Da Dan"],
        type: "webtoon",
        typeSlug: "webtoon"
      }]));
      return;
    }

    if (request.url?.startsWith("/v1/metadata/series-details")) {
      const url = new URL(`http://stub${request.url}`);
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        provider: url.searchParams.get("provider") || "mangadex",
        providerSeriesId: url.searchParams.get("providerSeriesId") || "md-1",
        title: "Dandadan",
        summary: "Aliens and yokai.",
        coverUrl: "https://images.example/dandadan.jpg",
        aliases: ["Dan Da Dan"],
        tags: ["action"],
        type: "webtoon",
        typeSlug: "webtoon",
        status: "watching"
      }));
      return;
    }

    if (request.url === "/v1/metadata/identify" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        calls.metadataIdentify += 1;
        const payload = JSON.parse(body || "{}");
        currentLibraryTitles = currentLibraryTitles.map((title) => title.id === payload.libraryId ? {
          ...title,
          metadataProvider: payload.provider,
          metadataMatchedAt: "2026-04-26T12:00:00.000Z",
          summary: title.summary || "Aliens and yokai.",
          coverUrl: title.coverUrl || "https://images.example/dandadan.jpg",
          aliases: title.aliases?.length ? title.aliases : ["Dan Da Dan"],
          tags: title.tags?.length ? title.tags : ["action"]
        } : title);
        syncLibraryIndex();
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          ok: true,
          provider: payload.provider,
          providerSeriesId: payload.providerSeriesId,
          libraryId: payload.libraryId,
          message: "Raven applied the selected metadata match."
        }));
      });
      return;
    }

    if (request.url === "/v1/intake/download-options" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body || "{}");
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          query: payload.query || "",
          availability: "available",
          selectedMetadata: payload.selectedMetadata || {},
          results: [{
            providerId: "weebcentral",
            providerName: "WeebCentral",
            titleName: "Dandadan",
            titleUrl: "https://weebcentral.com/series/dan-da-dan",
            requestType: "webtoon",
            libraryTypeLabel: "Webtoon",
            libraryTypeSlug: "webtoon",
            coverUrl: "https://images.example/dandadan.jpg"
          }]
        }));
      });
      return;
    }

    if (request.url === "/v1/downloads/queue" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", async () => {
        try {
          calls.queue += 1;
          const payload = JSON.parse(body || "{}");
          const taskId = "task-queued-1";
          if (syncLinkedRequestOnQueue && payload.requestId) {
            const syncResponse = await fetch(`${process.env.SCRIPTARR_VAULT_BASE_URL}/api/service/requests/${encodeURIComponent(payload.requestId)}`, {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.SCRIPTARR_SERVICE_TOKEN}`
              },
              body: JSON.stringify({
                status: "queued",
                actor: "scriptarr-raven",
                eventType: "queued",
                eventMessage: "Queued for Raven download.",
                detailsMerge: {
                  availability: "available",
                  selectedMetadata: payload.selectedMetadata || null,
                  selectedDownload: payload.selectedDownload || null,
                  jobId: taskId,
                  taskId
                }
              })
            });
            if (!syncResponse.ok) {
              throw new Error(`linked request sync failed: ${syncResponse.status}`);
            }
          }
          response.writeHead(202, {"Content-Type": "application/json"});
          response.end(JSON.stringify({
            taskId,
            jobId: taskId,
            status: "queued",
            titleName: payload.titleName,
            titleUrl: payload.titleUrl,
            requestId: payload.requestId || ""
          }));
        } catch (error) {
          response.writeHead(500, {"Content-Type": "application/json"});
          response.end(JSON.stringify({
            error: error instanceof Error ? error.message : String(error)
          }));
        }
      });
      return;
    }

    if (request.url === "/v1/downloads/bulk-queue" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        calls.bulkQueue += 1;
        const payload = JSON.parse(body || "{}");
        response.writeHead(202, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          status: "queued",
          message: "Queued 1 title(s) for download.",
          filters: {
            providerId: payload.providerId || "",
            type: payload.type || "",
            nsfw: payload.nsfw === true,
            titlePrefix: payload.titlePrefix || ""
          },
          pagesScanned: 1,
          matchedCount: 1,
          queuedCount: 1,
          skippedActiveCount: 0,
          failedCount: 0,
          queuedTitles: ["Dandadan"],
          skippedActiveTitles: [],
          failedTitles: []
        }));
      });
      return;
    }

    if (request.url === "/v1/downloads/bulk-runs" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        calls.bulkRunCreate += 1;
        const payload = JSON.parse(body || "{}");
        response.writeHead(202, {"Content-Type": "application/json"});
        response.end(JSON.stringify({
          runId: "bulk-run-1",
          status: "paused",
          message: "First batch queued.",
          filters: {
            providerId: payload.providerId || "",
            type: payload.type || "",
            nsfw: payload.nsfw === true,
            titlePrefix: payload.titlePrefix || ""
          },
          counts: {
            completedBatches: 1,
            remainingBatches: 4,
            queued: 10,
            skipped: 0,
            failed: 0
          }
        }));
      });
      return;
    }

    if (request.url === "/v1/downloads/bulk-runs/bulk-run-1" && request.method === "GET") {
      calls.bulkRunStatus += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        runId: "bulk-run-1",
        status: "paused",
        message: "Waiting for owner continuation."
      }));
      return;
    }

    if (request.url === "/v1/downloads/bulk-runs/bulk-run-1/continue" && request.method === "POST") {
      calls.bulkRunContinue += 1;
      response.writeHead(202, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        runId: "bulk-run-1",
        status: "paused",
        message: "Next batch queued."
      }));
      return;
    }

    if (request.url === "/v1/downloads/bulk-runs/bulk-run-1/cancel" && request.method === "POST") {
      calls.bulkRunCancel += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        runId: "bulk-run-1",
        status: "cancelled",
        message: "Mega run cancelled."
      }));
      return;
    }

    if (request.url === "/api/localai/status") {
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({installed: false, running: false}));
      return;
    }

    if (request.url === "/api/localai/profile") {
      calls.localAiProfile += 1;
      response.writeHead(200, {"Content-Type": "application/json"});
      response.end(JSON.stringify({
        selectedProfile: "cpu",
        profiles: [{
          key: "cpu",
          label: "CPU",
          image: "localai/localai:latest-aio-cpu"
        }, {
          key: "nvidia",
          label: "NVIDIA",
          image: "localai/localai:latest-aio-gpu-nvidia-cuda-12"
        }]
      }));
      return;
    }

    if (request.url === "/api/localai/config" && request.method === "PUT") {
      request.on("end", () => {
        calls.localAiConfig += 1;
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify({ok: true, selectedProfile: "cpu"}));
      });
      request.resume();
      return;
    }

    if (request.url === "/api/localai/actions/install" && request.method === "POST") {
      calls.localAiInstall += 1;
      response.writeHead(202, {"Content-Type": "application/json"});
      response.end(JSON.stringify({ok: true, status: "installing"}));
      return;
    }

    if (request.url === "/api/localai/actions/start" && request.method === "POST") {
      calls.localAiStart += 1;
      response.writeHead(202, {"Content-Type": "application/json"});
      response.end(JSON.stringify({ok: true, status: "starting"}));
      return;
    }

    response.writeHead(404, {"Content-Type": "application/json"});
    response.end(JSON.stringify({error: "Not found"}));
  });

  return Promise.resolve({server, calls});
};

const installDiscordFetchStub = (identity = {
  id: "owner-1",
  username: "Owner",
  global_name: "Owner",
  avatar: null
}) => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);

    if (url === "https://discord.com/api/oauth2/token") {
      return new Response(JSON.stringify({access_token: "discord-access-token"}), {
        status: 200,
        headers: {"Content-Type": "application/json"}
      });
    }

    if (url === "https://discord.com/api/users/@me") {
      return new Response(JSON.stringify(identity), {
        status: 200,
        headers: {"Content-Type": "application/json"}
      });
    }

    return originalFetch(input, init);
  };
};

const restoreFetch = () => {
  globalThis.fetch = originalFetch;
};

const signInViaDiscord = async (baseUrl, query = "") =>
  fetch(`${baseUrl}/api/auth/discord/callback?code=test-oauth-code${query ? `&${query}` : ""}`).then((response) => response.json());

test.afterEach(() => {
  restoreFetch();
});

test("sage carries a sanitized returnTo path through Discord OAuth state", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: []});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const authUrlPayload = await fetch(`${baseUrl}/api/auth/discord/url?returnTo=${encodeURIComponent("/browse?q=moon")}`)
    .then((response) => response.json());
  const oauthUrl = new URL(authUrlPayload.oauthUrl);
  const state = oauthUrl.searchParams.get("state");

  assert.equal(authUrlPayload.returnTo, "/browse?q=moon");
  assert.ok(state);

  const ownerClaim = await signInViaDiscord(baseUrl, `state=${encodeURIComponent(state)}`);
  assert.equal(ownerClaim.returnTo, "/browse?q=moon");

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage signs in the first owner through the Discord callback and moderates requests", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: [ownerSmokeLibraryTitle]});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);

  assert.ok(ownerClaim.token);
  assert.equal(ownerClaim.user.role, "owner");

  const request = await fetch(`${baseUrl}/api/moon-v3/user/requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      query: "dandadan",
      requestType: "webtoon",
      notes: "Need the latest chapters.",
      selectedMetadata: {
        provider: "mangadex",
        providerSeriesId: "md-1",
        title: "Dandadan"
      }
    })
  }).then((response) => response.json());

  assert.equal(request.status, "pending");
  assert.equal(request.details.selectedDownload, null);

  const reviewOptions = await fetch(`${baseUrl}/api/moon-v3/admin/requests/download-options`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      query: "dandadan",
      selectedMetadata: request.details.selectedMetadata
    })
  }).then((response) => response.json());
  assert.equal(reviewOptions.results.length, 1);

  const reviewed = await fetch(`${baseUrl}/api/moon-v3/admin/requests/${request.id}/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      comment: "Sent to Raven after moderation.",
      selectedMetadata: request.details.selectedMetadata,
      selectedDownload: reviewOptions.results[0]
    })
  }).then((response) => response.json());

  assert.equal(reviewed.request.status, "queued");
  assert.equal(reviewed.request.details.selectedDownload.providerId, "weebcentral");
  assert.equal(dependencyStub.calls.queue, 1);

  const denyCandidate = await fetch(`${baseUrl}/api/moon-v3/user/requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      query: "not a match",
      requestType: "manga",
      notes: "This should be denied.",
      selectedMetadata: {
        provider: "mangadex",
        providerSeriesId: "md-deny",
        title: "Wrong Match"
      }
    })
  }).then((response) => response.json());

  const blankDenial = await fetch(`${baseUrl}/api/moon-v3/admin/requests/${denyCandidate.id}/deny`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({comment: ""})
  });
  assert.equal(blankDenial.status, 400);

  const denied = await fetch(`${baseUrl}/api/moon-v3/admin/requests/${denyCandidate.id}/deny`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({comment: "Wrong edition."})
  }).then((response) => response.json());
  assert.equal(denied.status, "denied");
  assert.equal(denied.moderatorComment, "Wrong edition.");
  assert.equal(denied.timeline.some((entry) => entry.type === "denied" && entry.message === "Wrong edition."), true);

  const adminRequests = await fetch(`${baseUrl}/api/moon-v3/admin/requests`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(adminRequests.counts.total, 2);
  assert.equal(adminRequests.counts.queued, 1);
  assert.equal(adminRequests.counts.closed, 1);
  assert.equal(adminRequests.counts.needsReview, 0);
  assert.equal(typeof adminRequests.requests[0].revision, "number");
  const requestEvents = await fetch(`${baseUrl}/api/moon-v3/admin/events?domain=requests`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(requestEvents.events.some((event) =>
    event.eventType === "request-denied"
    && event.targetId === String(denyCandidate.id)
  ), true);

  const oracleSettings = await fetch(`${baseUrl}/api/admin/settings/oracle`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(oracleSettings.provider, "openai");
  assert.equal(oracleSettings.enabled, false);

  const moonLibrary = await fetch(`${baseUrl}/api/moon-v3/user/library`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(moonLibrary.titles[0].title, ownerSmokeLibraryTitle.title);

  await fetch(`http://127.0.0.1:${vaultPort}/api/service/raven/titles/${ownerSmokeLibraryTitle.id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer vault-dev-token"
    },
    body: JSON.stringify(ownerSmokeLibraryTitle)
  });
  await fetch(`http://127.0.0.1:${vaultPort}/api/service/progress`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer vault-dev-token"
    },
    body: JSON.stringify({
      mediaId: ownerSmokeLibraryTitle.id,
      discordUserId: "owner-1",
      chapterLabel: ownerSmokeLibraryTitle.chapters[0].label,
      positionRatio: 0.5,
      bookmark: {
        chapterId: ownerSmokeLibraryTitle.chapters[0].id,
        pageIndex: 8
      }
    })
  });

  const moonCardLibrary = await fetch(`${baseUrl}/api/moon-v3/user/library?view=card&pageSize=1`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(moonCardLibrary.titles[0].title, ownerSmokeLibraryTitle.title);
  assert.equal(Object.hasOwn(moonCardLibrary.titles[0], "chapters"), false);
  assert.equal(Object.hasOwn(moonCardLibrary.titles[0], "downloadRoot"), false);
  assert.equal(moonCardLibrary.titles[0].readerTarget.kind, "continue");
  assert.equal(moonCardLibrary.titles[0].readerTarget.chapterId, ownerSmokeLibraryTitle.chapters[0].id);
  assert.equal(moonCardLibrary.titles[0].readerTarget.pageIndex, 8);
  assert.equal(moonCardLibrary.pageInfo.pageSize, 1);
  assert.equal(dependencyStub.calls.libraryCard, 1);

  const overview = await fetch(`${baseUrl}/api/moon-v3/admin/overview`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(overview.counts.titles, 1);

  const adminStatus = await fetch(`${baseUrl}/api/admin/status`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(adminStatus.services.warden.service, "scriptarr-warden-health");
  assert.equal(adminStatus.summaries.warden.bootstrap.managedNetworkName, "scriptarr-network-bootstrap");
  assert.equal(adminStatus.summaries.warden.runtime.managedNetworkName, "scriptarr-network-runtime");

  const progress = await fetch(`${baseUrl}/api/reader/progress`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      mediaId: ownerSmokeLibraryTitle.id,
      chapterLabel: ownerSmokeLibraryTitle.chapters[0].label,
      positionRatio: 0.5,
      bookmark: {
        chapterId: ownerSmokeLibraryTitle.chapters[0].id,
        pageIndex: 8
      }
    })
  }).then((response) => response.json());

  assert.equal(progress.mediaId, ownerSmokeLibraryTitle.id);

  const systemStatus = await fetch(`${baseUrl}/api/moon-v3/admin/system/status`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(systemStatus.services.warden.service, "scriptarr-warden-health");
  assert.equal(systemStatus.bootstrap, null);
  assert.equal(systemStatus.runtime, null);
  assert.equal(systemStatus.groups.some((group) => group.id === "oracle"), true);
  assert.equal(systemStatus.summary.notProbed > 0, true);
  assert.equal(systemStatus.contentReset, undefined);
  assert.equal(
    systemStatus.groups.find((group) => group.id === "raven").endpoints.find((endpoint) => endpoint.path === "/v1/library").probeStatus,
    "pending"
  );
  const systemStatusRuntime = await fetch(`${baseUrl}/api/moon-v3/admin/system/status/runtime`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(systemStatusRuntime.bootstrap.managedNetworkName, "scriptarr-network-bootstrap");
  assert.equal(systemStatusRuntime.runtime.managedNetworkName, "scriptarr-network-runtime");
  assert.equal(systemStatusRuntime.runtime.mysql.mode, "selfhost");

  const tasks = await fetch(`${baseUrl}/api/moon-v3/admin/system/tasks`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(tasks.tasks.some((task) => task.taskId === "update-check"), true);
  assert.equal(tasks.tasks.some((task) => task.taskId === "event-retention-prune"), true);

  const taskPreview = await fetch(`${baseUrl}/api/moon-v3/admin/system/tasks/update-check/preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      cronExpression: "0 */6 * * *",
      timezone: "UTC"
    })
  }).then((response) => response.json());
  assert.equal(taskPreview.valid, true);
  assert.equal(taskPreview.nextRuns.length > 0, true);

  const aiStatus = await fetch(`${baseUrl}/api/moon-v3/admin/system/ai`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(aiStatus.oracle.provider, "openai");
  assert.equal(aiStatus.localAiProfile, undefined);
  assert.equal(aiStatus.modelOptions, undefined);
  assert.equal(dependencyStub.calls.modelOptions, 0);

  const aiRuntime = await fetch(`${baseUrl}/api/moon-v3/admin/system/ai/runtime`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(aiRuntime.localAiProfile.selectedProfile, "cpu");
  assert.equal(aiRuntime.localAi.installed, false);
  assert.equal(dependencyStub.calls.localAiProfile, 1);

  const unauthenticatedModels = await fetch(`${baseUrl}/api/moon-v3/admin/system/ai/models?provider=localai`);
  assert.equal(unauthenticatedModels.status, 401);

  const aiLocalAiModels = await fetch(`${baseUrl}/api/moon-v3/admin/system/ai/models?provider=localai`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(aiLocalAiModels.provider, "localai");
  assert.equal(aiLocalAiModels.models[0].id, "gpt-4");

  const aiLocalAiStart = await fetch(`${baseUrl}/api/moon-v3/admin/system/ai/localai/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      localAiProfileKey: "cpu",
      localAiImageMode: "preset",
      localAiCustomImage: ""
    })
  }).then((response) => response.json());
  assert.equal(aiLocalAiStart.ok, true);

  const aiTest = await fetch(`${baseUrl}/api/moon-v3/admin/system/ai/test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      message: "ping"
    })
  }).then((response) => response.json());
  assert.equal(aiTest.reply, "stubbed:ping");

  const logs = await fetch(`${baseUrl}/api/moon-v3/admin/system/logs?service=scriptarr-moon&level=error&lines=25&q=needle`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(logs.selectedService, "scriptarr-moon");
  assert.equal(logs.redacted, true);
  assert.match(logs.entries[0].message, /needle/);

  await fetch(`${process.env.SCRIPTARR_VAULT_BASE_URL}/api/service/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer sage-dev-token"
    },
    body: JSON.stringify({
      domain: "system",
      eventType: "update-check",
      severity: "warning",
      actorType: "admin",
      actorId: "owner-1",
      targetType: "service",
      targetId: "scriptarr-moon",
      message: "Needle update event."
    })
  });
  const events = await fetch(`${baseUrl}/api/moon-v3/admin/system/events?domain=system&eventType=update-check&severity=warning&targetType=service&q=Needle`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].targetId, "scriptarr-moon");

  const updates = await fetch(`${baseUrl}/api/moon-v3/admin/system/updates`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(updates.services[0].updateAvailable, true);
  const checkedUpdates = await fetch(`${baseUrl}/api/moon-v3/admin/system/updates/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      services: ["scriptarr-moon"]
    })
  }).then((response) => response.json());
  assert.equal(checkedUpdates.checkedAt, "2026-04-25T10:03:00.000Z");
  const installUpdates = await fetch(`${baseUrl}/api/moon-v3/admin/system/updates/install`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    },
    body: JSON.stringify({
      services: ["scriptarr-moon"]
    })
  }).then((response) => response.json());
  assert.equal(installUpdates.job.status, "running");

  const home = await fetch(`${baseUrl}/api/moon-v3/user/home`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(home.continueReading[0].titleId, ownerSmokeLibraryTitle.id);
  assert.equal(home.continueReading[0].title, ownerSmokeLibraryTitle.title);
  assert.equal(home.continueReading[0].coverAccent, ownerSmokeLibraryTitle.coverAccent);
  assert.equal(home.continueReading[0].coverUrl, ownerSmokeLibraryTitle.coverUrl);
  assert.equal(home.continueReading[0].bookmark.chapterId, ownerSmokeLibraryTitle.chapters[0].id);
  assert.equal(home.continueReading[0].readerTarget.kind, "continue");
  assert.equal(home.continueReading[0].readerTarget.chapterId, ownerSmokeLibraryTitle.chapters[0].id);
  assert.equal(home.continueReading[0].readerTarget.pageIndex, 8);
  assert.equal(home.shelves[0].title, "Your Bookshelf");
  assert.equal(home.shelves[1].title, "Recently added to Webtoon");
  assert.ok(dependencyStub.calls.health >= 1);
  assert.ok(dependencyStub.calls.bootstrap >= 1);
  assert.ok(dependencyStub.calls.runtime >= 1);
  assert.equal(dependencyStub.calls.logs, 1);
  assert.ok(dependencyStub.calls.updatesList >= 1);
  assert.equal(dependencyStub.calls.updatesCheck, 1);
  assert.equal(dependencyStub.calls.updatesInstall, 1);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage keeps Moon card routes available when Vault reader targets fail", async () => {
  let vaultServer;
  let vaultProxyServer;
  let sageServer;
  let dependencyStub;
  try {
    const {app: vaultApp} = await createVaultApp();
    vaultServer = vaultApp.listen(0);
    const vaultPort = vaultServer.address().port;
    const vaultProxy = createVaultReaderTargetFailureProxy({
      targetBaseUrl: `http://127.0.0.1:${vaultPort}`
    });
    vaultProxyServer = vaultProxy.server;
    vaultProxyServer.listen(0);
    const vaultProxyPort = vaultProxyServer.address().port;

    dependencyStub = await createDependencyStub({libraryTitles: [ownerSmokeLibraryTitle]});
    dependencyStub.server.listen(0);
    const dependencyPort = dependencyStub.server.address().port;

    process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultProxyPort}`;
    process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
    process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
    process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
    process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
    process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
    process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
    process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

    installDiscordFetchStub();

    const {app: sageApp} = await createSageApp();
    sageServer = sageApp.listen(0);
    const sagePort = sageServer.address().port;
    const baseUrl = `http://127.0.0.1:${sagePort}`;
    const ownerClaim = await signInViaDiscord(baseUrl);
    const headers = {
      "Authorization": `Bearer ${ownerClaim.token}`
    };

    const homeResponse = await fetch(`${baseUrl}/api/moon-v3/user/home`, {headers});
    const home = await homeResponse.json();
    assert.equal(homeResponse.status, 200);
    assert.equal(home.latestTitles[0].title, ownerSmokeLibraryTitle.title);
    assert.equal(Object.hasOwn(home.latestTitles[0], "readerTarget"), false);

    const libraryResponse = await fetch(`${baseUrl}/api/moon-v3/user/library?view=card&pageSize=1`, {headers});
    const library = await libraryResponse.json();
    assert.equal(libraryResponse.status, 200);
    assert.equal(library.titles[0].title, ownerSmokeLibraryTitle.title);
    assert.equal(Object.hasOwn(library.titles[0], "readerTarget"), false);
    assert.equal(vaultProxy.calls.readerTargets >= 2, true);
  } finally {
    await Promise.all([
      sageServer,
      vaultProxyServer,
      vaultServer,
      dependencyStub?.server
    ].filter(Boolean).map((server) => closeServer(server)));
  }
});

test("sage treats Raven's immediate linked-request queue sync as approval success", async () => {
  let vaultServer;
  let sageServer;
  let dependencyStub;
  try {
    const {app: vaultApp} = await createVaultApp();
    vaultServer = vaultApp.listen(0);
    const vaultPort = vaultServer.address().port;

    dependencyStub = await createDependencyStub({
      libraryTitles: [ownerSmokeLibraryTitle],
      syncLinkedRequestOnQueue: true
    });
    dependencyStub.server.listen(0);
    const dependencyPort = dependencyStub.server.address().port;

    process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
    process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
    process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
    process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
    process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
    process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
    process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
    process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

    installDiscordFetchStub();

    const {app: sageApp} = await createSageApp();
    sageServer = sageApp.listen(0);
    const sagePort = sageServer.address().port;
    const baseUrl = `http://127.0.0.1:${sagePort}`;
    const ownerClaim = await signInViaDiscord(baseUrl);
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ownerClaim.token}`
    };

    const request = await fetch(`${baseUrl}/api/moon-v3/user/requests`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: "dandadan",
        requestType: "webtoon",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-race",
          title: "Dandadan"
        }
      })
    }).then((response) => response.json());

    const reviewOptions = await fetch(`${baseUrl}/api/moon-v3/admin/requests/download-options`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: "dandadan",
        selectedMetadata: request.details.selectedMetadata
      })
    }).then((response) => response.json());

    const reviewedResponse = await fetch(`${baseUrl}/api/moon-v3/admin/requests/${request.id}/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        comment: "Sent to Raven after moderation.",
        expectedRevision: request.revision,
        selectedMetadata: request.details.selectedMetadata,
        selectedDownload: reviewOptions.results[0]
      })
    });
    const reviewed = await reviewedResponse.json();

    assert.equal(reviewedResponse.status, 202);
    assert.equal(reviewed.request.status, "queued");
    assert.equal(reviewed.request.details.taskId, "task-queued-1");
    assert.equal(reviewed.request.details.selectedDownload.providerId, "weebcentral");
    assert.equal(dependencyStub.calls.queue, 1);
  } finally {
    await closeServer(sageServer);
    await closeServer(vaultServer);
    await closeServer(dependencyStub?.server);
  }
});

test("sage keeps Moon library routes empty when Raven has no imported titles", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: []});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);

  const headers = {
    "Authorization": `Bearer ${ownerClaim.token}`
  };

  const legacyLibrary = await fetch(`${baseUrl}/api/library`, {headers}).then((response) => response.json());
  assert.deepEqual(legacyLibrary.library, []);

  const moonLibrary = await fetch(`${baseUrl}/api/moon-v3/user/library`, {headers}).then((response) => response.json());
  assert.deepEqual(moonLibrary, {titles: []});

  const overview = await fetch(`${baseUrl}/api/moon-v3/admin/overview`, {headers}).then((response) => response.json());
  assert.equal(overview.counts.titles, 0);
  assert.equal(overview.counts.missingChapters, 0);
  assert.equal(overview.counts.metadataGaps, 0);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage exposes wanted metadata and missing chapter workflows", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const gapTitle = {
    ...defaultLibraryTitle,
    id: "needs-metadata",
    title: "Needs Metadata",
    coverUrl: "",
    summary: "",
    tags: [],
    aliases: [],
    metadataProvider: "",
    metadataMatchedAt: "",
    chapterCount: 10,
    chaptersDownloaded: 7
  };
  const dependencyStub = await createDependencyStub({
    libraryTitles: [defaultLibraryTitle, gapTitle]
  });
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const headers = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };

  const missing = await fetch(`${baseUrl}/api/moon-v3/admin/wanted/missing-chapters`, {headers}).then((response) => response.json());
  assert.equal(missing.counts.totalTitles, 2);
  assert.equal(missing.counts.affectedTitles, 2);
  assert.equal(missing.counts.totalMissing, 163);

  const metadata = await fetch(`${baseUrl}/api/moon-v3/admin/wanted/metadata`, {headers}).then((response) => response.json());
  assert.equal(metadata.counts.total, 1);
  assert.equal(metadata.counts.missingProvider, 1);
  assert.equal(metadata.counts.missingMatchedAt, 1);
  assert.equal(metadata.counts.missingSummary, 1);
  assert.equal(metadata.counts.missingAliases, 1);
  assert.equal(metadata.counts.missingTags, 1);
  assert.equal(metadata.counts.missingCover, 1);

  const legacyMetadata = await fetch(`${baseUrl}/api/moon-v3/admin/wanted/metadata-gaps`, {headers}).then((response) => response.json());
  assert.equal(legacyMetadata.counts.total, metadata.counts.total);

  const search = await fetch(`${baseUrl}/api/moon-v3/admin/wanted/metadata/needs-metadata/search?query=Needs%20Metadata`, {
    headers
  }).then((response) => response.json());
  assert.equal(search.results[0].provider, "mangadex");
  assert.equal(dependencyStub.calls.metadataSearchUrls.some((url) => url.includes("libraryId=needs-metadata")), true);

  const invalidIdentify = await fetch(`${baseUrl}/api/moon-v3/admin/wanted/metadata/needs-metadata/identify`, {
    method: "POST",
    headers,
    body: JSON.stringify({selectedMetadata: {provider: "mangadex"}})
  });
  assert.equal(invalidIdentify.status, 400);

  const identify = await fetch(`${baseUrl}/api/moon-v3/admin/wanted/metadata/needs-metadata/identify`, {
    method: "POST",
    headers,
    body: JSON.stringify({selectedMetadata: search.results[0]})
  }).then((response) => response.json());
  assert.equal(identify.result.ok, true);
  assert.equal(identify.title.metadataProvider, "mangadex");
  assert.equal(dependencyStub.calls.metadataIdentify, 1);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage round-trips Moon branding and exposes typed Moon reader payloads", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub();
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const headers = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };

  const initialBranding = await fetch(`${baseUrl}/api/admin/settings/moon/branding`, {
    headers
  }).then((response) => response.json());
  assert.equal(initialBranding.siteName, "Scriptarr");

  const savedBrandingResponse = await fetch(`${baseUrl}/api/admin/settings/moon/branding`, {
    method: "PUT",
    headers,
    body: JSON.stringify({siteName: "  Pax Library  "})
  });
  const savedBranding = await savedBrandingResponse.json();

  assert.equal(savedBrandingResponse.status, 200);
  assert.equal(savedBranding.siteName, "Pax Library");

  const savedV3BrandingResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/branding`, {
    method: "PUT",
    headers,
    body: JSON.stringify({siteName: "  Pax-Kun  "})
  });
  const savedV3Branding = await savedV3BrandingResponse.json();
  assert.equal(savedV3BrandingResponse.status, 200);
  assert.equal(savedV3Branding.branding.siteName, "Pax-Kun");
  assert.equal(savedV3Branding.publicBranding.siteName, "Pax-Kun");

  const publicBranding = await fetch(`${baseUrl}/api/moon-v3/public/branding`).then((response) => response.json());
  assert.equal(publicBranding.siteName, "Pax-Kun");

  const aggregatedSettings = await fetch(`${baseUrl}/api/moon-v3/admin/settings`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(aggregatedSettings.branding.siteName, "Pax-Kun");
  assert.equal(aggregatedSettings.publicBranding.siteName, "Pax-Kun");
  assert.equal(aggregatedSettings.databaseOverview, null);
  assert.equal(aggregatedSettings.toastSettings.effective.actionToasts, true);
  assert.equal(aggregatedSettings.ravenDownloadRuntime.activeTitleDownloads, 2);
  const settingsRuntime = await fetch(`${baseUrl}/api/moon-v3/admin/settings/runtime`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(settingsRuntime.databaseOverview.tables.some((table) => table.name === "settings" && table.editable), true);
  assert.equal(typeof settingsRuntime.discordRuntime.connected, "boolean");

  const savedVpnResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/raven/vpn`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      enabled: true,
      region: "ca_toronto",
      piaUsername: "captain",
      piaPassword: "secret-vpn-password"
    })
  });
  const savedVpn = await savedVpnResponse.json();
  assert.equal(savedVpnResponse.status, 200);
  assert.equal(savedVpn.enabled, true);
  assert.equal(savedVpn.region, "ca_toronto");
  assert.equal(savedVpn.piaUsername, "captain");
  assert.equal(savedVpn.passwordConfigured, true);

  const savedVpnWithoutPasswordResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/raven/vpn`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      enabled: false,
      region: "us_california",
      piaUsername: "captain",
      piaPassword: ""
    })
  });
  const savedVpnWithoutPassword = await savedVpnWithoutPasswordResponse.json();
  assert.equal(savedVpnWithoutPasswordResponse.status, 200);
  assert.equal(savedVpnWithoutPassword.enabled, false);
  assert.equal(savedVpnWithoutPassword.region, "us_california");
  assert.equal(savedVpnWithoutPassword.passwordConfigured, true);

  const vpnTestResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/raven/vpn/test`, {
    method: "POST",
    headers
  });
  const vpnTest = await vpnTestResponse.json();
  assert.equal(vpnTestResponse.status, 200);
  assert.equal(vpnTest.ok, true);
  assert.equal(vpnTest.vpn.state, "armed");
  assert.equal(dependencyStub.calls.vpnTest, 1);

  const personalToastResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/toasts/personal`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      actionToasts: true,
      jobToasts: true,
      liveEventToasts: false,
      failuresOnly: false,
      severities: {info: true, success: true, warning: true, error: true}
    })
  });
  const personalToastPayload = await personalToastResponse.json();
  assert.equal(personalToastResponse.status, 200);
  assert.equal(personalToastPayload.effective.liveEventToasts, false);
  assert.equal(personalToastPayload.personal.liveEventToasts, false);

  const globalToastResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/toasts/global`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      actionToasts: true,
      jobToasts: true,
      liveEventToasts: true,
      failuresOnly: true,
      severities: {info: true, success: true, warning: true, error: true}
    })
  });
  const globalToastPayload = await globalToastResponse.json();
  assert.equal(globalToastResponse.status, 200);
  assert.equal(globalToastPayload.global.failuresOnly, true);

  const toastReadResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/toasts`, {headers});
  const toastReadPayload = await toastReadResponse.json();
  assert.equal(toastReadResponse.status, 200);
  assert.equal(toastReadPayload.canEditGlobal, true);
  assert.equal(toastReadPayload.global.failuresOnly, true);
  assert.equal(toastReadPayload.effective.liveEventToasts, false);

  const metadataSaveResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/raven/metadata`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      providers: [
        {id: "mangadex", enabled: false, priority: 50},
        {id: "animeplanet", enabled: true, priority: 5}
      ]
    })
  });
  const metadataSave = await metadataSaveResponse.json();
  assert.equal(metadataSaveResponse.status, 200);
  assert.equal(metadataSave.providers.find((provider) => provider.id === "mangadex").enabled, false);
  assert.equal(metadataSave.providers.find((provider) => provider.id === "animeplanet").priority, 5);

  const downloadProviderSaveResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/raven/download-providers`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      providers: [
        {id: "weebcentral", enabled: true, priority: 30},
        {id: "mangadex", enabled: false, priority: 5}
      ]
    })
  });
  const downloadProviderSave = await downloadProviderSaveResponse.json();
  assert.equal(downloadProviderSaveResponse.status, 200);
  assert.equal(downloadProviderSave.providers.find((provider) => provider.id === "mangadex").enabled, false);
  assert.equal(downloadProviderSave.providers.find((provider) => provider.id === "mangadex").priority, 5);

  const downloadRuntimeSaveResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/raven/download-runtime`, {
    method: "PUT",
    headers,
    body: JSON.stringify({activeTitleDownloads: 4})
  });
  const downloadRuntimeSave = await downloadRuntimeSaveResponse.json();
  assert.equal(downloadRuntimeSaveResponse.status, 200);
  assert.equal(downloadRuntimeSave.activeTitleDownloads, 4);
  assert.equal(downloadRuntimeSave.applied, true);
  assert.equal(dependencyStub.calls.downloadRuntimeReload, 1);

  const invalidDownloadRuntimeResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/raven/download-runtime`, {
    method: "PUT",
    headers,
    body: JSON.stringify({activeTitleDownloads: 7})
  });
  assert.equal(invalidDownloadRuntimeResponse.status, 400);

  const queueAfterRuntimeSave = await fetch(`${baseUrl}/api/moon-v3/admin/activity/queue`, {headers}).then((response) => response.json());
  assert.equal(queueAfterRuntimeSave.stats.totalSlots, 4);

  const discordBasicsResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/portal/discord`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      guildId: "guild-1",
      superuserId: "owner-1",
      onboarding: {
        channelId: "welcome-1",
        template: "Welcome {user_mention}"
      }
    })
  });
  const discordBasics = await discordBasicsResponse.json();
  assert.equal(discordBasicsResponse.status, 200);
  assert.equal(discordBasics.guildId, "guild-1");
  assert.equal(discordBasics.onboarding.channelId, "welcome-1");
  assert.equal(discordBasics.commands.request.enabled, true);

  const clearedDiscordBasicsResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/portal/discord`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      guildId: "",
      superuserId: "",
      onboarding: {
        channelId: ""
      }
    })
  });
  const clearedDiscordBasics = await clearedDiscordBasicsResponse.json();
  assert.equal(clearedDiscordBasicsResponse.status, 200);
  assert.equal(clearedDiscordBasics.guildId, "");
  assert.equal(clearedDiscordBasics.superuserId, "");
  assert.equal(clearedDiscordBasics.onboarding.channelId, "");
  assert.equal(clearedDiscordBasics.onboarding.template, "Welcome {user_mention}");

  const settingsAfterSaves = await fetch(`${baseUrl}/api/moon-v3/admin/settings`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(settingsAfterSaves.branding.siteName, "Pax-Kun");
  assert.equal(settingsAfterSaves.ravenVpn.region, "us_california");
  assert.equal(settingsAfterSaves.ravenVpn.passwordConfigured, true);
  assert.equal(settingsAfterSaves.toastSettings.personal.liveEventToasts, false);
  assert.equal(settingsAfterSaves.toastSettings.global.failuresOnly, true);
  assert.equal(settingsAfterSaves.metadataProviders.providers.find((provider) => provider.id === "mangadex").enabled, false);
  assert.equal(settingsAfterSaves.downloadProviders.providers.find((provider) => provider.id === "mangadex").enabled, false);
  assert.equal(settingsAfterSaves.ravenDownloadRuntime.activeTitleDownloads, 4);
  assert.equal(settingsAfterSaves.discord.guildId, "");

  const databaseOverviewResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/database`, {
    headers
  });
  assert.equal(databaseOverviewResponse.status, 200);
  assert.equal((await databaseOverviewResponse.json()).tables.some((table) => table.name === "settings"), true);

  const databaseTableResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/database/tables/settings?q=moon.branding`, {
    headers
  });
  assert.equal(databaseTableResponse.status, 200);
  assert.equal((await databaseTableResponse.json()).rows.some((row) => row.setting_key === "moon.branding"), true);

  const databaseSettingUpdate = await fetch(`${baseUrl}/api/moon-v3/admin/settings/database/tables/settings/rows/moon.admin.toasts.global`, {
    method: "PUT",
    headers,
    body: JSON.stringify({value: {actionToasts: false}})
  });
  assert.equal(databaseSettingUpdate.status, 200);

  installDiscordFetchStub({
    id: "reader-db-denied",
    username: "Reader",
    global_name: "Reader",
    avatar: null
  });
  const readerClaim = await signInViaDiscord(baseUrl);
  const deniedDatabaseResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/database`, {
    headers: {
      "Authorization": `Bearer ${readerClaim.token}`
    }
  });
  assert.equal(deniedDatabaseResponse.status, 403);

  const moonLibrary = await fetch(`${baseUrl}/api/moon-v3/user/library`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(moonLibrary.titles[0].libraryTypeSlug, "webtoon");
  assert.equal(moonLibrary.titles[0].libraryTypeLabel, "Webtoon");

  const titleDetail = await fetch(`${baseUrl}/api/moon-v3/user/title/dan-da-dan`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(titleDetail.title.libraryTypeSlug, "webtoon");
  assert.equal(titleDetail.title.libraryTypeLabel, "Webtoon");

  const adminTitleDetail = await fetch(`${baseUrl}/api/moon-v3/admin/library/dan-da-dan`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(adminTitleDetail.title.id, "dan-da-dan");
  assert.equal(adminTitleDetail.title.libraryTypeSlug, "webtoon");
  assert.ok(Array.isArray(adminTitleDetail.requests));
  assert.ok(Array.isArray(adminTitleDetail.activeTasks));
  assert.ok(Array.isArray(adminTitleDetail.recentTasks));

  const followResponse = await fetch(`${baseUrl}/api/moon-v3/user/following`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      titleId: "dan-da-dan",
      title: "Dandadan",
      latestChapter: "166",
      mediaType: "webtoon",
      libraryTypeLabel: "Webtoon",
      libraryTypeSlug: "webtoon"
    })
  });
  assert.equal(followResponse.status, 201);

  const following = await fetch(`${baseUrl}/api/moon-v3/user/following`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(following.following[0].libraryTypeSlug, "webtoon");
  assert.equal(following.following[0].libraryTypeLabel, "Webtoon");

  const readerManifest = await fetch(`${baseUrl}/api/moon-v3/user/reader/title/dan-da-dan`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(readerManifest.title.libraryTypeSlug, "webtoon");
  assert.equal(readerManifest.title.libraryTypeLabel, "Webtoon");

  const readerChapter = await fetch(`${baseUrl}/api/moon-v3/user/reader/title/dan-da-dan/chapter/dandadan-c166`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(readerChapter.title.libraryTypeSlug, "webtoon");
  assert.equal(readerChapter.title.libraryTypeLabel, "Webtoon");
  assert.equal(readerChapter.manifest.title.libraryTypeSlug, "webtoon");
  assert.equal(readerChapter.manifest.title.libraryTypeLabel, "Webtoon");
  assert.equal(readerChapter.preferences.readingMode, "infinite");
  assert.equal(readerChapter.preferences.layoutMode, "webtoon");
  assert.equal(readerChapter.preferences.readingDirection, "ltr");
  assert.equal(readerChapter.pages[0].src, "/api/moon/v3/user/reader/title/dan-da-dan/chapter/dandadan-c166/page/0");

  const savedReaderPreferences = await fetch(`${baseUrl}/api/moon-v3/user/reader/preferences`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      typeSlug: "webtoon",
      titleId: "dan-da-dan",
      layoutMode: "double",
      readingDirection: "rtl",
      pageFit: "contain",
      showSidebar: true,
      showPageNumbers: false
    })
  }).then((response) => response.json());
  assert.equal(savedReaderPreferences.readingMode, "paged");
  assert.equal(savedReaderPreferences.layoutMode, "double");
  assert.equal(savedReaderPreferences.readingDirection, "rtl");
  assert.equal(savedReaderPreferences.pageFit, "contain");
  assert.equal(savedReaderPreferences.showSidebar, true);
  assert.equal(savedReaderPreferences.showPageNumbers, false);

  const typeDefaultPreferences = await fetch(`${baseUrl}/api/moon-v3/user/reader/preferences?typeSlug=webtoon`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(typeDefaultPreferences.layoutMode, "webtoon");
  assert.equal(typeDefaultPreferences.readingMode, "infinite");

  const readerChapterWithTitlePreferences = await fetch(`${baseUrl}/api/moon-v3/user/reader/title/dan-da-dan/chapter/dandadan-c166`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(readerChapterWithTitlePreferences.preferences.layoutMode, "double");
  assert.equal(readerChapterWithTitlePreferences.preferences.readingDirection, "rtl");
  assert.equal(readerChapterWithTitlePreferences.preferences.readingMode, "paged");

  const home = await fetch(`${baseUrl}/api/moon-v3/user/home`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(home.latestTitles[0].libraryTypeSlug, "webtoon");
  assert.equal(home.latestTitles[0].libraryTypeLabel, "Webtoon");

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage keeps saved Raven download runtime settings when live reload fails", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({downloadRuntimeReloadStatus: 503});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;
  const ownerClaim = await signInViaDiscord(baseUrl);
  const headers = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };

  const saveResponse = await fetch(`${baseUrl}/api/moon-v3/admin/settings/raven/download-runtime`, {
    method: "PUT",
    headers,
    body: JSON.stringify({activeTitleDownloads: 3})
  });
  const savePayload = await saveResponse.json();
  assert.equal(saveResponse.status, 200);
  assert.equal(savePayload.activeTitleDownloads, 3);
  assert.equal(savePayload.applied, false);
  assert.match(savePayload.warning, /could not apply|reload failed/i);

  const settings = await fetch(`${baseUrl}/api/moon-v3/admin/settings`, {
    headers: {"Authorization": `Bearer ${ownerClaim.token}`}
  }).then((response) => response.json());
  assert.equal(settings.ravenDownloadRuntime.activeTitleDownloads, 3);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage persists user tag preferences and title or chapter read state into bookshelf and reader payloads", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub();
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const headers = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };

  await fetch(`http://127.0.0.1:${vaultPort}/api/service/raven/titles/${defaultLibraryTitle.id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer vault-dev-token"
    },
    body: JSON.stringify(defaultLibraryTitle)
  });

  const initialTagPreferences = await fetch(`${baseUrl}/api/moon-v3/user/tag-preferences`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.deepEqual(initialTagPreferences, {
    likedTags: [],
    dislikedTags: []
  });

  const likedTags = await fetch(`${baseUrl}/api/moon-v3/user/tag-preferences`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      tag: "Action",
      preference: "like"
    })
  }).then((response) => response.json());
  assert.deepEqual(likedTags, {
    likedTags: ["Action"],
    dislikedTags: []
  });

  const dislikedTags = await fetch(`${baseUrl}/api/moon-v3/user/tag-preferences`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      tag: "Romance",
      preference: "dislike"
    })
  }).then((response) => response.json());
  assert.deepEqual(dislikedTags, {
    likedTags: ["Action"],
    dislikedTags: ["Romance"]
  });

  const chapterRead = await fetch(`${baseUrl}/api/moon-v3/user/title/dan-da-dan/chapters/dandadan-c166/read`, {
    method: "POST",
    headers
  }).then((response) => response.json());
  assert.equal(chapterRead.chapterId, "dandadan-c166");
  assert.equal(chapterRead.title.id, "dan-da-dan");

  const titleReadState = await fetch(`${baseUrl}/api/moon-v3/user/title/dan-da-dan/read-state`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(titleReadState.userState.readAvailableCount, 1);
  assert.equal(titleReadState.userState.unreadAvailableCount, 1);
  assert.equal(titleReadState.chapters.find((chapter) => chapter.id === "dandadan-c166")?.read, true);
  assert.equal(titleReadState.chapters.find((chapter) => chapter.id === "dandadan-c167")?.read, false);

  const readerChapter = await fetch(`${baseUrl}/api/moon-v3/user/reader/title/dan-da-dan/chapter/dandadan-c166`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(readerChapter.chapter.read, true);
  assert.equal(readerChapter.manifest.chapters.find((chapter) => chapter.id === "dandadan-c166")?.read, true);

  const homeWhileActive = await fetch(`${baseUrl}/api/moon-v3/user/home`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(homeWhileActive.continueReading.length, 1);
  assert.equal(homeWhileActive.continueReading[0].titleId, "dan-da-dan");
  assert.equal(homeWhileActive.continueReading[0].readerTarget.kind, "next-unread");
  assert.equal(homeWhileActive.continueReading[0].readerTarget.chapterId, "dandadan-c167");
  assert.equal(homeWhileActive.tagPreferences.likedTags[0], "Action");
  assert.equal(homeWhileActive.shelves.some((shelf) => shelf.id === "tag:action"), true);
  assert.equal(homeWhileActive.shelves.some((shelf) => shelf.id === "tag:romance"), false);

  const markTitleRead = await fetch(`${baseUrl}/api/moon-v3/user/title/dan-da-dan/read`, {
    method: "POST",
    headers
  }).then((response) => response.json());
  assert.equal(markTitleRead.title.userState.completed, true);
  assert.equal(markTitleRead.title.userState.bookshelf, false);

  const homeAfterCompletion = await fetch(`${baseUrl}/api/moon-v3/user/home`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(homeAfterCompletion.continueReading.length, 0);

  await fetch(`${baseUrl}/api/reader/progress`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mediaId: "dan-da-dan",
      chapterLabel: "Chapter 166",
      positionRatio: 0.5,
      bookmark: {
        chapterId: "dandadan-c166",
        pageIndex: 3
      }
    })
  });

  await fetch(`${baseUrl}/api/moon-v3/user/reader/bookmarks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: "title-reset-bookmark",
      titleId: "dan-da-dan",
      chapterId: "dandadan-c166",
      pageIndex: 3,
      label: "Title reset bookmark"
    })
  });

  const markTitleUnread = await fetch(`${baseUrl}/api/moon-v3/user/title/dan-da-dan/unread`, {
    method: "POST",
    headers
  }).then((response) => response.json());
  assert.equal(markTitleUnread.title.userState.completed, false);
  assert.equal(markTitleUnread.title.userState.bookshelf, false);
  assert.equal(markTitleUnread.title.userState.started, false);
  assert.equal(markTitleUnread.title.userState.readAvailableCount, 0);

  const homeAfterUnread = await fetch(`${baseUrl}/api/moon-v3/user/home`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(homeAfterUnread.continueReading.length, 0);

  const bookmarksAfterTitleReset = await fetch(`${baseUrl}/api/moon-v3/user/reader/bookmarks`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(bookmarksAfterTitleReset.bookmarks.length, 0);

  const bulkRead = await fetch(`${baseUrl}/api/moon-v3/user/title/dan-da-dan/chapters/bulk-read-state`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "read",
      chapterIds: ["dandadan-c166"]
    })
  }).then((response) => response.json());
  assert.equal(bulkRead.title.userState.readAvailableCount, 1);
  assert.equal(bulkRead.title.chapters.find((chapter) => chapter.id === "dandadan-c166")?.read, true);

  const bulkUnread = await fetch(`${baseUrl}/api/moon-v3/user/title/dan-da-dan/chapters/bulk-read-state`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "unread",
      chapterIds: ["dandadan-c166"]
    })
  }).then((response) => response.json());
  assert.equal(bulkUnread.title.userState.readAvailableCount, 0);
  assert.equal(bulkUnread.title.chapters.find((chapter) => chapter.id === "dandadan-c166")?.read, false);

  await fetch(`${baseUrl}/api/moon-v3/user/reader/bookmarks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: "bulk-reset-bookmark",
      titleId: "dan-da-dan",
      chapterId: "dandadan-c167",
      pageIndex: 1,
      label: "Bulk reset bookmark"
    })
  });

  await fetch(`${baseUrl}/api/reader/progress`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mediaId: "dan-da-dan",
      chapterLabel: "Chapter 167",
      positionRatio: 0.75,
      bookmark: {
        chapterId: "dandadan-c167",
        pageIndex: 1
      }
    })
  });

  const bulkReset = await fetch(`${baseUrl}/api/moon-v3/user/title/dan-da-dan/chapters/bulk-read-state`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "reset",
      chapterIds: ["dandadan-c167"]
    })
  }).then((response) => response.json());
  assert.equal(bulkReset.clearedBookmarkCount, 1);
  assert.equal(bulkReset.clearedProgress, true);
  assert.equal(bulkReset.title.chapters.find((chapter) => chapter.id === "dandadan-c167")?.read, false);

  const homeAfterBulkReset = await fetch(`${baseUrl}/api/moon-v3/user/home`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(homeAfterBulkReset.continueReading.length, 1);
  assert.equal(homeAfterBulkReset.continueReading[0].titleId, "dan-da-dan");

  const bookmarksAfterBulkReset = await fetch(`${baseUrl}/api/moon-v3/user/reader/bookmarks`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(bookmarksAfterBulkReset.bookmarks.length, 0);

  const chapterUnread = await fetch(`${baseUrl}/api/moon-v3/user/title/dan-da-dan/chapters/dandadan-c166/unread`, {
    method: "POST",
    headers
  }).then((response) => response.json());
  assert.equal(chapterUnread.title.userState.readAvailableCount, 0);
  assert.equal(chapterUnread.title.userState.unreadAvailableCount, 2);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage previews and executes the root-only content reset flow", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({
    downloadTasks: [{
      taskId: "task-1",
      status: "queued",
      titleId: "dan-da-dan"
    }]
  });
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const headers = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };

  await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
    method: "POST",
    headers: {
      "Authorization": "Bearer sage-dev-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      source: "moon",
      title: "Reset Fixture",
      requestType: "webtoon",
      requestedBy: "owner-1",
      details: {
        query: "reset-fixture",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-reset",
          title: "Reset Fixture"
        }
      }
    })
  });

  await fetch(`${baseUrl}/api/reader/progress`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mediaId: "dan-da-dan",
      chapterLabel: "Chapter 166",
      positionRatio: 0.5,
      bookmark: {
        chapterId: "dandadan-c166",
        pageIndex: 3
      }
    })
  });

  await fetch(`${baseUrl}/api/moon-v3/user/reader/bookmarks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: "bookmark-1",
      titleId: "dan-da-dan",
      chapterId: "dandadan-c166",
      label: "Bookmark 1"
    })
  });

  await fetch(`${baseUrl}/api/moon-v3/user/following`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      titleId: "dan-da-dan",
      title: "Dandadan",
      latestChapter: "167",
      mediaType: "webtoon",
      libraryTypeLabel: "Webtoon",
      libraryTypeSlug: "webtoon"
    })
  });

  await fetch(`${baseUrl}/api/moon-v3/user/title/dan-da-dan/chapters/dandadan-c166/read`, {
    method: "POST",
    headers
  });

  const preview = await fetch(`${baseUrl}/api/moon-v3/admin/system/content-reset/preview`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());

  assert.equal(preview.confirmationText, "RESET SCRIPTARR CONTENT");
  assert.equal(preview.vault.counts.requests, 1);
  assert.equal(preview.vault.counts.progress, 1);
  assert.equal(preview.vault.counts.titleReadStates, 1);
  assert.equal(preview.vault.counts.chapterReadStates, 1);
  assert.equal(preview.vault.counts.followingSettings, 1);
  assert.equal(preview.vault.counts.bookmarkSettings, 1);
  assert.equal(preview.raven.counts.activeTasks, 1);
  assert.ok(dependencyStub.calls.contentResetPreview >= 1);

  const rejected = await fetch(`${baseUrl}/api/moon-v3/admin/system/content-reset`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      confirmation: "NOPE"
    })
  });
  assert.equal(rejected.status, 400);

  const executed = await fetch(`${baseUrl}/api/moon-v3/admin/system/content-reset`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      confirmation: "RESET SCRIPTARR CONTENT"
    })
  }).then((response) => response.json());

  assert.equal(executed.confirmationText, "RESET SCRIPTARR CONTENT");
  assert.equal(executed.vault.counts.requests, 1);
  assert.equal(executed.raven.counts.activeTasks, 0);
  assert.equal(dependencyStub.calls.contentResetExecute, 1);

  const homeAfterReset = await fetch(`${baseUrl}/api/moon-v3/user/home`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(homeAfterReset.latestTitles.length, 0);
  assert.equal(homeAfterReset.continueReading.length, 0);

  const bookmarksAfterReset = await fetch(`${baseUrl}/api/moon-v3/user/reader/bookmarks`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(bookmarksAfterReset.bookmarks.length, 0);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage blocks duplicate active intake requests across Moon and Portal create paths", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: []});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const ownerHeaders = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };
  const portalHeaders = {
    "Authorization": "Bearer portal-dev-token",
    "Content-Type": "application/json"
  };

  const firstRequestResponse = await fetch(`${baseUrl}/api/moon-v3/user/requests`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify(defaultIntakePayload)
  });
  assert.equal(firstRequestResponse.status, 201);

  const duplicateUserResponse = await fetch(`${baseUrl}/api/moon-v3/user/requests`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify(defaultIntakePayload)
  });
  assert.equal(duplicateUserResponse.status, 409);
  const duplicateUserPayload = await duplicateUserResponse.json();
  assert.equal(duplicateUserPayload.code, "REQUEST_ALREADY_QUEUED");
  assert.match(duplicateUserPayload.error, /already queued|active request/i);

  const duplicateAdminAddResponse = await fetch(`${baseUrl}/api/moon-v3/admin/add/queue`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify(defaultIntakePayload)
  });
  assert.equal(duplicateAdminAddResponse.status, 409);
  assert.match((await duplicateAdminAddResponse.json()).error, /already queued|active request/i);

  const duplicatePortalResponse = await fetch(`${baseUrl}/api/internal/portal/requests`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      source: "discord",
      requestedBy: "reader-2",
      discordUserId: "reader-2",
      username: "Reader Two",
      ...defaultIntakePayload
    })
  });
  assert.equal(duplicatePortalResponse.status, 409);
  const duplicatePortalPayload = await duplicatePortalResponse.json();
  assert.equal(duplicatePortalPayload.code, "REQUEST_ALREADY_QUEUED");
  assert.match(duplicatePortalPayload.error, /already queued|active request/i);

  const requests = await fetch(`${baseUrl}/api/moon-v3/admin/requests`, {
    headers: ownerHeaders
  }).then((response) => response.json());
  assert.equal(requests.requests.length, 1);
  assert.equal(requests.requests[0].waitlistCount, 1);
  assert.equal(requests.requests[0].details.waitlist[0].discordUserId, "reader-2");

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage surfaces Vault's durable request work-key conflict when concurrent creates race past broker preflight", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: []});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const ownerHeaders = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };

  const [first, second] = await Promise.all([
    fetch(`${baseUrl}/api/moon-v3/user/requests`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify(defaultIntakePayload)
    }),
    fetch(`${baseUrl}/api/moon-v3/user/requests`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify(defaultIntakePayload)
    })
  ]);

  const statuses = [first.status, second.status].sort((left, right) => left - right);
  assert.deepEqual(statuses, [201, 409]);

  const conflictResponse = first.status === 409 ? await first.json() : await second.json();
  assert.equal(conflictResponse.code, "REQUEST_WORK_KEY_CONFLICT");
  assert.match(conflictResponse.error, /already queued|active request/i);

  const requests = await fetch(`${baseUrl}/api/moon-v3/admin/requests`, {
    headers: ownerHeaders
  }).then((response) => response.json());
  assert.equal(requests.requests.length, 1);
  assert.equal(requests.requests[0].workKey, "metadata:mangadex::md-1");

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage exposes metadata-first Moon request endpoints and lets requesters edit notes or cancel active requests", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: []});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;
  try {
    const ownerClaim = await signInViaDiscord(baseUrl);
    const ownerHeaders = {
      "Authorization": `Bearer ${ownerClaim.token}`,
      "Content-Type": "application/json"
    };

    const metadataResults = await fetch(`${baseUrl}/api/moon-v3/user/requests/metadata-search?query=dandadan`, {
      headers: {
        "Authorization": `Bearer ${ownerClaim.token}`
      }
    }).then((response) => response.json());
    assert.equal(metadataResults.results.length, 1);
    assert.equal(metadataResults.results[0].providerSeriesId, "md-1");

    const downloadOptions = await fetch(`${baseUrl}/api/moon-v3/user/requests/download-options`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        query: "dandadan",
        selectedMetadata: metadataResults.results[0]
      })
    }).then((response) => response.json());
    assert.equal(downloadOptions.results.length, 1);
    assert.equal(downloadOptions.results[0].providerId, "weebcentral");

    const created = await fetch(`${baseUrl}/api/moon-v3/user/requests`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        query: "dandadan",
        notes: "Please keep checking.",
        selectedMetadata: metadataResults.results[0]
      })
    }).then((response) => response.json());
    assert.equal(created.status, "pending");
    assert.equal(created.details.selectedDownload, null);
    assert.equal(created.canEditNotes, true);
    assert.equal(created.canCancel, true);

    const patched = await fetch(`${baseUrl}/api/moon-v3/user/requests/${created.id}/notes`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({
        notes: "Updated note from Moon."
      })
    }).then((response) => response.json());
    assert.equal(patched.notes, "Updated note from Moon.");

    const cancelled = await fetch(`${baseUrl}/api/moon-v3/user/requests/${created.id}/cancel`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({})
    }).then((response) => response.json());
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.tab, "closed");

    const requests = await fetch(`${baseUrl}/api/moon-v3/user/requests`, {
      headers: {
        "Authorization": `Bearer ${ownerClaim.token}`
      }
    }).then((response) => response.json());
    assert.equal(requests.tabs.active, 0);
    assert.equal(requests.tabs.closed, 1);
    assert.equal(requests.requests[0].status, "cancelled");
  } finally {
    await closeServer(sageServer);
    await closeServer(vaultServer);
    await closeServer(dependencyStub.server);
  }
});

test("sage wraps portal metadata-search results in a stable object payload", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: []});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  try {
    const response = await fetch(`${baseUrl}/api/internal/portal/requests/metadata-search?query=dandadan`, {
      headers: {
        "Authorization": "Bearer portal-dev-token"
      }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].providerSeriesId, "md-1");
    assert.equal(payload.results[0].title, "Dandadan");
  } finally {
    await closeServer(sageServer);
    await closeServer(vaultServer);
    await closeServer(dependencyStub.server);
  }
});

test("sage allows newly signed-in members to create requests by default after the owner is claimed", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: []});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  try {
    installDiscordFetchStub({
      id: "owner-1",
      username: "Owner",
      global_name: "Owner",
      avatar: null
    });
    const ownerClaim = await signInViaDiscord(baseUrl);
    assert.equal(ownerClaim.user.role, "owner");

    installDiscordFetchStub({
      id: "reader-2",
      username: "ReaderTwo",
      global_name: "Reader Two",
      avatar: null
    });
    const readerClaim = await signInViaDiscord(baseUrl);
    assert.equal(readerClaim.user.role, "member");

    const metadataResults = await fetch(`${baseUrl}/api/moon-v3/user/requests/metadata-search?query=dandadan`, {
      headers: {
        "Authorization": `Bearer ${readerClaim.token}`
      }
    }).then((response) => response.json());
    assert.equal(metadataResults.results.length, 1);

    const createResponse = await fetch(`${baseUrl}/api/moon-v3/user/requests`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${readerClaim.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: "dandadan",
        selectedMetadata: metadataResults.results[0]
      })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.requestedBy.discordUserId, "reader-2");
    assert.equal(created.status, "pending");
    assert.equal(created.details.selectedDownload, null);
  } finally {
    await closeServer(sageServer);
    await closeServer(vaultServer);
    await closeServer(dependencyStub.server);
  }
});

test("sage exposes group-based admin users access and domain-scoped event reads", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: []});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  try {
    installDiscordFetchStub({
      id: "owner-1",
      username: "Owner",
      global_name: "Owner",
      avatar: null
    });
    const ownerClaim = await signInViaDiscord(baseUrl);
    assert.equal(ownerClaim.user.role, "owner");

    installDiscordFetchStub({
      id: "reader-2",
      username: "ReaderTwo",
      global_name: "Reader Two",
      avatar: null
    });
    const readerClaim = await signInViaDiscord(baseUrl);
    assert.equal(readerClaim.user.role, "member");

    const ownerHeaders = {
      "Authorization": `Bearer ${ownerClaim.token}`,
      "Content-Type": "application/json"
    };
    const readerHeaders = {
      "Authorization": `Bearer ${readerClaim.token}`
    };

    const groupResponse = await fetch(`${baseUrl}/api/moon-v3/admin/users/groups`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        name: "User Managers",
        description: "Can manage users and read access events.",
        permissions: ["read_library"],
        adminGrants: {
          users: "read"
        }
      })
    });
    assert.equal(groupResponse.status, 201);
    const group = await groupResponse.json();
    assert.equal(group.id, "user-managers");

    const assignmentResponse = await fetch(`${baseUrl}/api/moon-v3/admin/users/reader-2/groups`, {
      method: "PUT",
      headers: ownerHeaders,
      body: JSON.stringify({
        groupIds: ["user-managers"]
      })
    });
    assert.equal(assignmentResponse.status, 200);
    const assignedUser = await assignmentResponse.json();
    assert.deepEqual(assignedUser.groups.map((entry) => entry.id), ["user-managers"]);

    const usersResponse = await fetch(`${baseUrl}/api/moon-v3/admin/users`, {
      headers: readerHeaders
    });
    assert.equal(usersResponse.status, 200);
    const usersPayload = await usersResponse.json();
    assert.equal(usersPayload.defaultGroupId, "member");
    assert.equal(usersPayload.groups.some((entry) => entry.id === "user-managers"), true);
    assert.equal(usersPayload.users.some((entry) =>
      entry.discordUserId === "reader-2"
      && entry.groups.some((groupEntry) => groupEntry.id === "user-managers")
    ), true);
    assert.equal(usersPayload.events.some((event) => ["auth", "users", "access"].includes(event.domain)), true);

    const eventsResponse = await fetch(`${baseUrl}/api/moon-v3/admin/events?domain=users`, {
      headers: readerHeaders
    });
    assert.equal(eventsResponse.status, 200);
    const eventsPayload = await eventsResponse.json();
    assert.equal(eventsPayload.events.some((event) => event.domain === "users"), true);

    const forbiddenEvents = await fetch(`${baseUrl}/api/moon-v3/admin/events?domain=system`, {
      headers: readerHeaders
    });
    assert.equal(forbiddenEvents.status, 403);

  } finally {
    await closeServer(sageServer);
    await closeServer(vaultServer);
    await closeServer(dependencyStub.server);
  }
});

test("sage authenticates system and user API keys with scoped access", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: []});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  try {
    installDiscordFetchStub({
      id: "owner-1",
      username: "Owner",
      global_name: "Owner",
      avatar: null
    });
    const ownerClaim = await signInViaDiscord(baseUrl);
    const ownerHeaders = {
      "Authorization": `Bearer ${ownerClaim.token}`,
      "Content-Type": "application/json"
    };

    const enabledSettings = await fetch(`${baseUrl}/api/moon-v3/admin/system/api/settings`, {
      method: "PUT",
      headers: ownerHeaders,
      body: JSON.stringify({enabled: true})
    });
    assert.equal(enabledSettings.status, 200);

    const systemKeyResponse = await fetch(`${baseUrl}/api/moon-v3/admin/system/api/keys`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        name: "Status Bot",
        groupIds: ["admin"]
      })
    });
    assert.equal(systemKeyResponse.status, 201);
    const systemKey = await systemKeyResponse.json();
    assert.ok(systemKey.secret);
    assert.equal(systemKey.apiKey.keyHash, undefined);

    const systemStatus = await fetch(`${baseUrl}/api/moon-v3/admin/system/status`, {
      headers: {"X-Scriptarr-Api-Key": systemKey.secret}
    });
    assert.equal(systemStatus.status, 200);

    const emptyKey = await fetch(`${baseUrl}/api/moon-v3/admin/system/api/keys`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        name: "No Grants",
        groupIds: []
      })
    }).then((response) => response.json());
    const deniedStatus = await fetch(`${baseUrl}/api/moon-v3/admin/system/status`, {
      headers: {"X-Scriptarr-Api-Key": emptyKey.secret}
    });
    assert.equal(deniedStatus.status, 403);

    const userKeyResponse = await fetch(`${baseUrl}/api/moon-v3/user/api-keys`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({name: "Reader Sync"})
    });
    assert.equal(userKeyResponse.status, 201);
    const userKey = await userKeyResponse.json();

    const profileResponse = await fetch(`${baseUrl}/api/moon-v3/user/profile`, {
      headers: {"X-Scriptarr-Api-Key": userKey.secret}
    });
    assert.equal(profileResponse.status, 200);
    const profile = await profileResponse.json();
    assert.equal(profile.user.discordUserId, "owner-1");

    const userKeyAdminResponse = await fetch(`${baseUrl}/api/moon-v3/admin/system/status`, {
      headers: {"X-Scriptarr-Api-Key": userKey.secret}
    });
    assert.equal(userKeyAdminResponse.status, 403);

    const publicSearch = await fetch(`${baseUrl}/api/public/v1/search?q=dandadan`).then((response) => response.json());
    const publicCreate = await fetch(`${baseUrl}/api/public/v1/requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Scriptarr-Api-Key": userKey.secret
      },
      body: JSON.stringify({
        selectionToken: publicSearch.results[0].selectionToken
      })
    });
    assert.equal(publicCreate.status, 202);

    const requests = await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
      headers: {
        "Authorization": "Bearer sage-dev-token"
      }
    }).then((response) => response.json());
    assert.equal(requests[0].requestedBy, "owner-1");
    assert.equal(requests[0].details.apiKeyKind, "user");
  } finally {
    await closeServer(sageServer);
    await closeServer(vaultServer);
    await closeServer(dependencyStub.server);
  }
});

test("sage admin resolve surfaces durable work-key conflicts from Vault cleanly", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: []});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const ownerHeaders = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };
  const vaultHeaders = {
    "Authorization": "Bearer vault-dev-token",
    "Content-Type": "application/json"
  };

  const existing = await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
    method: "POST",
    headers: vaultHeaders,
    body: JSON.stringify({
      source: "moon",
      title: "Dandadan",
      requestType: "webtoon",
      requestedBy: ownerClaim.user.discordUserId,
      status: "pending",
      details: {
        query: "dandadan",
        selectedMetadata: defaultIntakePayload.selectedMetadata,
        selectedDownload: defaultIntakePayload.selectedDownload,
        availability: "available"
      }
    })
  }).then((response) => response.json());

  const unresolved = await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
    method: "POST",
    headers: vaultHeaders,
    body: JSON.stringify({
      source: "moon",
      title: "Dan Da Dan",
      requestType: "webtoon",
      requestedBy: ownerClaim.user.discordUserId,
      status: "unavailable",
      details: {
        query: "dan da dan",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-2",
          title: "Dan Da Dan",
          type: "webtoon"
        },
        availability: "unavailable"
      }
    })
  }).then((response) => response.json());

  assert.equal(existing.id, 1);
  assert.equal(typeof unresolved.id, "number");

  const resolved = await fetch(`${baseUrl}/api/moon-v3/admin/requests/${unresolved.id}/resolve`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      query: "dan da dan",
      selectedMetadata: {
        provider: "mangadex",
        providerSeriesId: "md-2",
        title: "Dan Da Dan",
        type: "webtoon"
      },
      selectedDownload: defaultIntakePayload.selectedDownload
    })
  });
  assert.equal(resolved.status, 409);
  const conflict = await resolved.json();
  assert.equal(conflict.code, "REQUEST_WORK_KEY_CONFLICT");
  assert.match(conflict.error, /already queued|active request/i);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage admin request actions surface stale revision conflicts cleanly", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: []});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const ownerHeaders = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };
  const vaultHeaders = {
    "Authorization": "Bearer vault-dev-token",
    "Content-Type": "application/json"
  };

  const request = await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
    method: "POST",
    headers: vaultHeaders,
    body: JSON.stringify({
      source: "moon",
      title: "Stale Request",
      requestType: "manga",
      requestedBy: ownerClaim.user.discordUserId,
      status: "pending",
      details: {
        query: "stale request",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "stale-1",
          title: "Stale Request",
          type: "manga"
        },
        availability: "unavailable"
      }
    })
  }).then((response) => response.json());

  const listed = await fetch(`${baseUrl}/api/moon-v3/admin/requests`, {
    headers: ownerHeaders
  }).then((response) => response.json());
  const staleRevision = listed.requests.find((entry) => String(entry.id) === String(request.id)).revision;

  await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests/${request.id}`, {
    method: "PATCH",
    headers: vaultHeaders,
    body: JSON.stringify({
      notes: "Changed elsewhere."
    })
  });

  const staleDeny = await fetch(`${baseUrl}/api/moon-v3/admin/requests/${request.id}/deny`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      comment: "Not this time.",
      expectedRevision: staleRevision
    })
  });

  assert.equal(staleDeny.status, 409);
  const conflict = await staleDeny.json();
  assert.equal(conflict.code, "REQUEST_REVISION_CONFLICT");
  assert.match(conflict.error, /changed while you were reviewing/i);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage emits request and follow completion notifications with Moon links even when Raven task title ids are blank", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({
    downloadTasks: [{
      taskId: "task-complete-1",
      requestId: "1",
      titleId: "",
      titleName: "Dandadan",
      status: "completed",
      libraryTypeSlug: "webtoon",
      titleUrl: "https://weebcentral.com/series/dan-da-dan",
      coverUrl: "https://images.example/dandadan.jpg",
      updatedAt: "2026-04-20T00:00:00.000Z"
    }]
  });
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const ownerHeaders = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };
  const portalHeaders = {
    "Authorization": "Bearer portal-dev-token",
    "Content-Type": "application/json"
  };

  const createdRequest = await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
    method: "POST",
    headers: {
      "Authorization": "Bearer vault-dev-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      source: "discord",
      title: "Dandadan",
      requestType: "webtoon",
      requestedBy: ownerClaim.user.discordUserId,
      status: "completed",
      details: {
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-1",
          title: "Dandadan"
        },
        selectedDownload: {
          providerId: "weebcentral",
          titleUrl: "https://weebcentral.com/series/dan-da-dan",
          libraryTypeSlug: "webtoon",
          coverUrl: "https://images.example/dandadan.jpg"
        }
      }
    })
  }).then((response) => response.json());

  assert.equal(typeof createdRequest.id, "number");

  const followResponse = await fetch(`${baseUrl}/api/moon-v3/user/following`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      titleId: "dan-da-dan",
      title: "Dandadan",
      latestChapter: "166",
      mediaType: "webtoon",
      libraryTypeLabel: "Webtoon",
      libraryTypeSlug: "webtoon"
    })
  });
  assert.equal(followResponse.status, 201);

  const requestNotifications = await fetch(`${baseUrl}/api/internal/portal/notifications/requests`, {
    headers: portalHeaders
  }).then((response) => response.json());
  assert.equal(requestNotifications.notifications.length, 1);
  assert.equal(requestNotifications.notifications[0].requestId, "1");
  assert.equal(requestNotifications.notifications[0].titleUrl, "https://pax-kun.com/title/webtoon/dan-da-dan");

  const followNotifications = await fetch(`${baseUrl}/api/internal/portal/notifications/follows`, {
    headers: portalHeaders
  }).then((response) => response.json());
  assert.equal(followNotifications.notifications.length, 1);
  assert.equal(followNotifications.notifications[0].titleId, "dan-da-dan");
  assert.equal(followNotifications.notifications[0].titleUrl, "https://pax-kun.com/title/webtoon/dan-da-dan");

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage emits approved, denied, and completed request notifications with deduped acknowledgments", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({
    downloadTasks: [{
      taskId: "task-complete-1",
      requestId: "3",
      titleId: "dan-da-dan",
      titleName: "Dandadan",
      status: "completed",
      libraryTypeSlug: "webtoon",
      titleUrl: "https://weebcentral.com/series/dan-da-dan",
      coverUrl: "https://images.example/dandadan.jpg",
      updatedAt: "2026-04-20T00:00:00.000Z"
    }]
  });
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const portalHeaders = {
    "Authorization": "Bearer portal-dev-token",
    "Content-Type": "application/json"
  };
  const vaultHeaders = {
    "Authorization": "Bearer vault-dev-token",
    "Content-Type": "application/json"
  };

  const approved = await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
    method: "POST",
    headers: vaultHeaders,
    body: JSON.stringify({
      source: "moon",
      title: "One Piece",
      requestType: "manga",
      requestedBy: ownerClaim.user.discordUserId,
      status: "queued",
      moderatorComment: "Approved from Moon admin.",
      details: {
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-op",
          title: "One Piece"
        },
        selectedDownload: {
          providerId: "weebcentral",
          titleUrl: "https://weebcentral.com/series/one-piece",
          coverUrl: "https://images.example/one-piece.jpg"
        },
        availability: "available"
      }
    })
  }).then((response) => response.json());

  const denied = await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
    method: "POST",
    headers: vaultHeaders,
    body: JSON.stringify({
      source: "discord",
      title: "Chainsaw Man",
      requestType: "manga",
      requestedBy: ownerClaim.user.discordUserId,
      status: "denied",
      moderatorComment: "Already available elsewhere.",
      details: {
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-csm",
          title: "Chainsaw Man"
        },
        availability: "unavailable"
      }
    })
  }).then((response) => response.json());

  const completed = await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
    method: "POST",
    headers: vaultHeaders,
    body: JSON.stringify({
      source: "moon",
      title: "Dandadan",
      requestType: "webtoon",
      requestedBy: ownerClaim.user.discordUserId,
      status: "completed",
      details: {
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-1",
          title: "Dandadan"
        },
        selectedDownload: {
          providerId: "weebcentral",
          titleUrl: "https://weebcentral.com/series/dan-da-dan",
          libraryTypeSlug: "webtoon",
          coverUrl: "https://images.example/dandadan.jpg"
        },
        taskId: "task-complete-1",
        availability: "available"
      }
    })
  }).then((response) => response.json());

  const initialNotifications = await fetch(`${baseUrl}/api/internal/portal/notifications/requests`, {
    headers: portalHeaders
  }).then((response) => response.json());
  assert.deepEqual(
    initialNotifications.notifications.map((entry) => entry.id).sort(),
    [
      `${approved.id}:approved`,
      `${denied.id}:denied`,
      `${completed.id}:approved`,
      String(completed.id)
    ].sort()
  );
  assert.equal(
    initialNotifications.notifications.find((entry) => entry.id === `${approved.id}:approved`)?.linkUrl,
    "https://pax-kun.com/myrequests"
  );
  assert.equal(
    initialNotifications.notifications.find((entry) => entry.id === String(completed.id))?.titleUrl,
    "https://pax-kun.com/title/webtoon/dan-da-dan"
  );

  const approvedAck = await fetch(`${baseUrl}/api/internal/portal/notifications/requests/${encodeURIComponent(`${approved.id}:approved`)}/ack`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({})
  }).then((response) => response.json());
  assert.equal(approvedAck.requestId, `${approved.id}:approved`);

  const deniedAck = await fetch(`${baseUrl}/api/internal/portal/notifications/requests/${encodeURIComponent(`${denied.id}:denied`)}/ack`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({})
  }).then((response) => response.json());
  assert.equal(deniedAck.requestId, `${denied.id}:denied`);

  const remainingNotifications = await fetch(`${baseUrl}/api/internal/portal/notifications/requests`, {
    headers: portalHeaders
  }).then((response) => response.json());
  assert.deepEqual(
    remainingNotifications.notifications.map((entry) => entry.id).sort(),
    [
      `${completed.id}:approved`,
      String(completed.id)
    ].sort()
  );

  const completedAck = await fetch(`${baseUrl}/api/internal/portal/notifications/requests/${completed.id}/ack`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({})
  }).then((response) => response.json());
  assert.equal(completedAck.requestId, String(completed.id));

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage emits blocked, ready, source-found, and expired request notifications for duplicate waitlists and unavailable requests", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub({libraryTitles: [defaultLibraryTitle]});
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PUBLIC_BASE_URL = "https://pax-kun.com";
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  try {
    const ownerClaim = await signInViaDiscord(baseUrl);
    const portalHeaders = {
      "Authorization": "Bearer portal-dev-token",
      "Content-Type": "application/json"
    };
    const vaultHeaders = {
      "Authorization": "Bearer vault-dev-token",
      "Content-Type": "application/json"
    };

    await fetch(`http://127.0.0.1:${vaultPort}/api/service/users/upsert-discord`, {
      method: "POST",
      headers: vaultHeaders,
      body: JSON.stringify({
        discordUserId: "reader-2",
        username: "Reader Two",
        role: "member"
      })
    });
    await fetch(`http://127.0.0.1:${vaultPort}/api/service/users/upsert-discord`, {
      method: "POST",
      headers: vaultHeaders,
      body: JSON.stringify({
        discordUserId: "reader-3",
        username: "Reader Three",
        role: "member"
      })
    });

    const blocked = await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
      method: "POST",
      headers: vaultHeaders,
      body: JSON.stringify({
        source: "moon",
        title: "One Piece",
        requestType: "manga",
        requestedBy: ownerClaim.user.discordUserId,
        status: "pending",
        details: {
          query: "one piece",
          selectedMetadata: {
            provider: "mangadex",
            providerSeriesId: "md-op",
            title: "One Piece"
          },
          selectedDownload: {
            providerId: "weebcentral",
            titleUrl: "https://weebcentral.com/series/one-piece",
            requestType: "manga"
          },
          availability: "available",
          waitlist: [{
            discordUserId: "reader-2",
            username: "Reader Two",
            source: "moon",
            attachedAt: "2026-04-21T00:00:00.000Z"
          }]
        }
      })
    }).then((response) => response.json());

    const completed = await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
      method: "POST",
      headers: vaultHeaders,
      body: JSON.stringify({
        source: "moon",
        title: "Dandadan",
        requestType: "webtoon",
        requestedBy: ownerClaim.user.discordUserId,
        status: "completed",
        details: {
          query: "dandadan",
          selectedMetadata: {
            provider: "mangadex",
            providerSeriesId: "md-1",
            title: "Dandadan"
          },
          selectedDownload: {
            providerId: "weebcentral",
            titleUrl: "https://weebcentral.com/series/dan-da-dan",
            requestType: "webtoon",
            libraryTypeSlug: "webtoon"
          },
          availability: "available",
          waitlist: [{
            discordUserId: "reader-3",
            username: "Reader Three",
            source: "discord",
            attachedAt: "2026-04-21T00:00:00.000Z"
          }]
        }
      })
    }).then((response) => response.json());

    const sourceFound = await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
      method: "POST",
      headers: vaultHeaders,
      body: JSON.stringify({
        source: "moon",
        title: "No Source Yet",
        requestType: "manga",
        requestedBy: ownerClaim.user.discordUserId,
        status: "pending",
        details: {
          query: "no source yet",
          selectedMetadata: {
            provider: "mangadex",
            providerSeriesId: "md-unavailable",
            title: "No Source Yet"
          },
          availability: "available",
          sourceFoundAt: "2026-04-21T12:00:00.000Z",
          sourceFoundOptions: [{
            providerId: "weebcentral",
            providerName: "WeebCentral",
            titleName: "No Source Yet",
            titleUrl: "https://weebcentral.com/series/no-source-yet",
            requestType: "manga",
            libraryTypeLabel: "Manga",
            libraryTypeSlug: "manga"
          }]
        }
      })
    }).then((response) => response.json());

    const expired = await fetch(`http://127.0.0.1:${vaultPort}/api/service/requests`, {
      method: "POST",
      headers: vaultHeaders,
      body: JSON.stringify({
        source: "moon",
        title: "Never Matched",
        requestType: "manga",
        requestedBy: ownerClaim.user.discordUserId,
        status: "expired",
        details: {
          query: "never matched",
          selectedMetadata: {
            provider: "mangadex",
            providerSeriesId: "md-expired",
            title: "Never Matched"
          },
          availability: "unavailable"
        }
      })
    }).then((response) => response.json());

    const notifications = await fetch(`${baseUrl}/api/internal/portal/notifications/requests`, {
      headers: portalHeaders
    }).then((response) => response.json());
    const ids = notifications.notifications.map((entry) => entry.id).sort();
    assert.ok(ids.includes(`${blocked.id}:blocked:reader-2`));
    assert.ok(ids.includes(`${completed.id}:approved`));
    assert.ok(ids.includes(String(completed.id)));
    assert.ok(ids.includes(`${completed.id}:ready:reader-3`));
    assert.ok(ids.includes(`${sourceFound.id}:source-found`));
    assert.ok(ids.includes(`${expired.id}:expired`));

    const sourceFoundNotification = notifications.notifications.find((entry) => entry.id === `${sourceFound.id}:source-found`);
    assert.equal(sourceFoundNotification.sourceFoundOptions.length, 1);
    assert.equal(sourceFoundNotification.sourceFoundOptions[0].providerId, "weebcentral");

    await fetch(`${baseUrl}/api/internal/portal/notifications/requests/${encodeURIComponent(`${blocked.id}:blocked:reader-2`)}/ack`, {
      method: "POST",
      headers: portalHeaders,
      body: JSON.stringify({})
    });
    await fetch(`${baseUrl}/api/internal/portal/notifications/requests/${encodeURIComponent(`${completed.id}:ready:reader-3`)}/ack`, {
      method: "POST",
      headers: portalHeaders,
      body: JSON.stringify({})
    });
    await fetch(`${baseUrl}/api/internal/portal/notifications/requests/${encodeURIComponent(`${sourceFound.id}:source-found`)}/ack`, {
      method: "POST",
      headers: portalHeaders,
      body: JSON.stringify({})
    });
    await fetch(`${baseUrl}/api/internal/portal/notifications/requests/${encodeURIComponent(`${expired.id}:expired`)}/ack`, {
      method: "POST",
      headers: portalHeaders,
      body: JSON.stringify({})
    });

    const afterAck = await fetch(`${baseUrl}/api/internal/portal/notifications/requests`, {
      headers: portalHeaders
    }).then((response) => response.json());
    const afterAckIds = afterAck.notifications.map((entry) => entry.id);
    assert.equal(afterAckIds.includes(`${blocked.id}:blocked:reader-2`), false);
    assert.equal(afterAckIds.includes(`${completed.id}:ready:reader-3`), false);
    assert.equal(afterAckIds.includes(`${sourceFound.id}:source-found`), false);
    assert.equal(afterAckIds.includes(`${expired.id}:expired`), false);
  } finally {
    await closeServer(sageServer);
    await closeServer(vaultServer);
    await closeServer(dependencyStub.server);
  }
});

test("sage round-trips brokered Portal Discord settings and exposes them in admin settings", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub();
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";
  process.env.SCRIPTARR_DISCORD_TOKEN = "discord-bot-token";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const headers = {
    "Authorization": `Bearer ${ownerClaim.token}`,
    "Content-Type": "application/json"
  };

  const savedDiscord = await fetch(`${baseUrl}/api/admin/settings/portal/discord`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      guildId: "guild-123",
      superuserId: "owner-1",
      onboarding: {
        channelId: "channel-456",
        template: "Welcome to {siteName}, {username}!"
      },
      notifications: {
        releaseChannelId: "release-789"
      },
      commands: {
        request: {
          enabled: true,
          roleId: "role-request"
        },
        subscribe: {
          enabled: false,
          roleId: "role-sub"
        }
      }
    })
  }).then((response) => response.json());

  assert.equal(savedDiscord.guildId, "guild-123");
  assert.equal(savedDiscord.superuserId, "owner-1");
  assert.equal(savedDiscord.commands.request.roleId, "role-request");
  assert.equal(savedDiscord.commands.subscribe.enabled, false);
  assert.equal(savedDiscord.notifications.releaseChannelId, "release-789");
  assert.equal(savedDiscord.runtime.authConfigured, true);
  assert.equal(savedDiscord.runtime.botTokenConfigured, true);

  const onboardingPreview = await fetch(`${baseUrl}/api/admin/settings/portal/discord/onboarding/test`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: "CaptainPax"
    })
  }).then((response) => response.json());
  assert.equal(onboardingPreview.rendered, "Welcome to Scriptarr, CaptainPax!");

  const discordPayload = await fetch(`${baseUrl}/api/moon-v3/admin/discord`, {
    headers
  }).then((response) => response.json());
  assert.equal(discordPayload.settings.notifications.releaseChannelId, "release-789");
  assert.ok(discordPayload.commandCatalog.some((command) => command.id === "request"));

  const savedV3 = await fetch(`${baseUrl}/api/moon-v3/admin/discord`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      ...discordPayload.settings,
      notifications: {
        releaseChannelId: "release-999"
      }
    })
  }).then((response) => response.json());
  assert.equal(savedV3.settings.notifications.releaseChannelId, "release-999");
  assert.equal(savedV3.runtime.reload.ok, true);

  const releaseTest = await fetch(`${baseUrl}/api/moon-v3/admin/discord/release-notifications/test`, {
    method: "POST",
    headers,
    body: JSON.stringify(savedV3.settings)
  }).then((response) => response.json());
  assert.equal(releaseTest.channelId, "release-999");
  assert.equal(dependencyStub.calls.releaseNotificationTest, 1);

  const aggregatedSettings = await fetch(`${baseUrl}/api/moon-v3/admin/settings`, {
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`
    }
  }).then((response) => response.json());
  assert.equal(aggregatedSettings.discord.guildId, "guild-123");
  assert.equal(aggregatedSettings.discord.commands.request.roleId, "role-request");
  assert.equal(aggregatedSettings.discord.notifications.releaseChannelId, "release-999");

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage no longer exposes a dev-session claim endpoint", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub();
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const response = await fetch(`http://127.0.0.1:${sagePort}/api/auth/claim`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({discordUserId: "owner-1"})
  });

  assert.equal(response.status, 404);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage defaults a blank LocalAI model to an AIO-friendly alias", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub();
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_DISCORD_CLIENT_ID = "discord-client-id";
  process.env.SCRIPTARR_DISCORD_CLIENT_SECRET = "discord-client-secret";

  installDiscordFetchStub();

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const ownerClaim = await signInViaDiscord(baseUrl);
  const response = await fetch(`${baseUrl}/api/admin/settings/oracle`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${ownerClaim.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      enabled: true,
      provider: "localai",
      model: "",
      localAiProfileKey: "cpu",
      localAiImageMode: "preset",
      localAiCustomImage: ""
    })
  });
  const oracleSettings = await response.json();

  assert.equal(response.status, 200);
  assert.equal(oracleSettings.provider, "localai");
  assert.equal(oracleSettings.model, "gpt-4");

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage brokers service-to-service routes with internal service auth", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub();
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;

  const portalHeaders = {
    "Authorization": "Bearer portal-dev-token",
    "Content-Type": "application/json"
  };
  const oracleHeaders = {
    "Authorization": "Bearer oracle-dev-token",
    "Content-Type": "application/json"
  };
  const ravenHeaders = {
    "Authorization": "Bearer raven-dev-token",
    "Content-Type": "application/json"
  };
  const vaultHeaders = {
    "Authorization": "Bearer sage-dev-token"
  };

  const createdUser = await fetch(`${baseUrl}/api/internal/vault/users/upsert-discord`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      discordUserId: "discord-123",
      username: "Portal User",
      role: "member"
    })
  }).then((response) => response.json());
  assert.equal(createdUser.discordUserId, "discord-123");

  const request = await fetch(`${baseUrl}/api/internal/vault/requests`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      source: "discord",
      title: "The Fable",
      requestType: "manga",
      requestedBy: "discord-123"
    })
  }).then((response) => response.json());
  assert.equal(request.title, "The Fable");

  const portalDiscordConfig = await fetch(`${baseUrl}/api/internal/portal/discord-config`, {
    headers: portalHeaders
  }).then((response) => response.json());
  assert.equal(portalDiscordConfig.discord.guildId, "");
  assert.equal(portalDiscordConfig.commandCatalog.some((entry) => entry.id === "downloadall"), true);

  const librarySearch = await fetch(`${baseUrl}/api/internal/portal/library/search?query=dandadan`, {
    headers: portalHeaders
  }).then((response) => response.json());
  assert.equal(librarySearch.results[0].title, "Dandadan");
  assert.match(librarySearch.results[0].moonTitleUrl, /\/title\/webtoon\/dan-da-dan$/);

  const intakeSearch = await fetch(`${baseUrl}/api/internal/portal/intake/search?query=dandadan`, {
    headers: portalHeaders
  }).then((response) => response.json());
  assert.equal(intakeSearch.results[0].availability, "available");

  const discordRequest = await fetch(`${baseUrl}/api/internal/portal/requests`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      source: "discord",
      requestedBy: "discord-123",
      query: "dandadan",
      selectedMetadata: {
        provider: "mangadex",
        providerSeriesId: "md-1",
        title: "Dandadan"
      }
    })
  }).then((response) => response.json());
  assert.equal(discordRequest.status, "pending");
  assert.equal(discordRequest.details.selectedDownload, null);

  const ravenPatchedRequest = await fetch(`${baseUrl}/api/internal/vault/requests/${discordRequest.id}`, {
    method: "PATCH",
    headers: ravenHeaders,
    body: JSON.stringify({
      status: "downloading",
      detailsMerge: {
        availability: "available",
        selectedDownload: {
          providerId: "weebcentral",
          titleName: "Dandadan",
          titleUrl: "https://weebcentral.com/series/dan-da-dan"
        }
      }
    })
  }).then((response) => response.json());
  assert.equal(ravenPatchedRequest.status, "downloading");

  const following = await fetch(`${baseUrl}/api/internal/portal/following`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      discordUserId: "discord-123",
      titleId: "dan-da-dan",
      title: "Dandadan",
      latestChapter: "166",
      mediaType: "webtoon",
      libraryTypeLabel: "Webtoon",
      libraryTypeSlug: "webtoon"
    })
  }).then((response) => response.json());
  assert.equal(following.following[0].libraryTypeSlug, "webtoon");

  const bulkQueue = await fetch(`${baseUrl}/api/internal/portal/raven/bulk-queue`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      providerId: "weebcentral",
      type: "Manga",
      nsfw: false,
      titlePrefix: "a",
      requestedBy: "owner-1"
    })
  }).then((response) => response.json());
  assert.equal(bulkQueue.status, "queued");
  assert.equal(dependencyStub.calls.bulkQueue, 1);

  const rejectedBulkQueue = await fetch(`${baseUrl}/api/internal/portal/raven/bulk-queue`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      providerId: "mangadex",
      type: "Manga",
      nsfw: false,
      titlePrefix: "a",
      requestedBy: "owner-1"
    })
  });
  assert.equal(rejectedBulkQueue.status, 400);
  assert.equal(dependencyStub.calls.bulkQueue, 1);

  const bulkRun = await fetch(`${baseUrl}/api/internal/portal/downloads/bulk-runs`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      providerId: "weebcentral",
      type: "all",
      nsfw: false,
      titlePrefix: "all",
      requestedBy: "owner-1"
    })
  }).then((response) => response.json());
  assert.equal(bulkRun.runId, "bulk-run-1");
  assert.equal(bulkRun.status, "paused");
  assert.equal(dependencyStub.calls.bulkRunCreate, 1);

  const bulkRunStatus = await fetch(`${baseUrl}/api/internal/portal/downloads/bulk-runs/bulk-run-1`, {
    headers: portalHeaders
  }).then((response) => response.json());
  assert.equal(bulkRunStatus.message, "Waiting for owner continuation.");
  assert.equal(dependencyStub.calls.bulkRunStatus, 1);

  const bulkRunContinue = await fetch(`${baseUrl}/api/internal/portal/downloads/bulk-runs/bulk-run-1/continue`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({requestedBy: "owner-1"})
  }).then((response) => response.json());
  assert.equal(bulkRunContinue.message, "Next batch queued.");
  assert.equal(dependencyStub.calls.bulkRunContinue, 1);

  const bulkRunCancel = await fetch(`${baseUrl}/api/internal/portal/downloads/bulk-runs/bulk-run-1/cancel`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({requestedBy: "owner-1"})
  }).then((response) => response.json());
  assert.equal(bulkRunCancel.status, "cancelled");
  assert.equal(dependencyStub.calls.bulkRunCancel, 1);

  const oracleStatus = await fetch(`${baseUrl}/api/internal/warden/bootstrap`, {
    headers: oracleHeaders
  }).then((response) => response.json());
  assert.equal(oracleStatus.managedNetworkName, "scriptarr-network-bootstrap");

  const updatedOracleSettings = await fetch(`${baseUrl}/api/internal/vault/settings/oracle.settings`, {
    method: "PUT",
    headers: {
      "Authorization": "Bearer warden-dev-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      value: {
        provider: "localai",
        model: "gpt-4"
      }
    })
  }).then((response) => response.json());
  assert.equal(updatedOracleSettings.value.provider, "localai");

  const brokeredOracleSettings = await fetch(`${baseUrl}/api/internal/vault/settings/oracle.settings`, {
    headers: {
      "Authorization": "Bearer warden-dev-token"
    }
  }).then((response) => response.json());
  assert.equal(brokeredOracleSettings.value.model, "gpt-4");

  const oracleChat = await fetch(`${baseUrl}/api/internal/oracle/chat`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({message: "hello"})
  }).then((response) => response.json());
  assert.equal(oracleChat.reply, "stubbed:hello");

  const noonaRemember = await fetch(`${baseUrl}/api/internal/portal/noona-chat`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      message: "remember that I like cozy manga",
      user: {discordUserId: "discord-123", username: "Portal User"},
      guildId: "guild-1",
      channelId: "general"
    })
  }).then((response) => response.json());
  assert.equal(noonaRemember.reply, "I will remember that.");

  const noonaRecall = await fetch(`${baseUrl}/api/internal/portal/noona-chat`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      message: "what do you remember about me?",
      user: {discordUserId: "discord-123", username: "Portal User"},
      guildId: "guild-1",
      channelId: "general"
    })
  }).then((response) => response.json());
  assert.match(noonaRecall.reply, /cozy manga/i);

  const ravenJob = await fetch(`${baseUrl}/api/internal/jobs/raven-job-1`, {
    method: "PUT",
    headers: ravenHeaders,
    body: JSON.stringify({
      kind: "download",
      ownerService: "scriptarr-raven",
      status: "queued",
      label: "Raven download"
    })
  }).then((response) => response.json());
  assert.equal(ravenJob.jobId, "raven-job-1");

  const ravenTask = await fetch(`${baseUrl}/api/internal/vault/raven/download-tasks/task-broker-1`, {
    method: "PUT",
    headers: ravenHeaders,
    body: JSON.stringify({
      taskId: "task-broker-1",
      titleId: "dan-da-dan",
      titleName: "Dandadan",
      titleUrl: "https://weebcentral.com/series/dan-da-dan",
      providerId: "weebcentral",
      requestId: String(discordRequest.id),
      requestType: "webtoon",
      requestedBy: "discord-123",
      status: "queued",
      percent: 0
    })
  }).then((response) => response.json());
  assert.equal(ravenTask.taskId, "task-broker-1");

  const durableEvents = await fetch(`http://127.0.0.1:${vaultPort}/api/service/events?domain=requests&domain=activity&domain=system`, {
    headers: vaultHeaders
  }).then((response) => response.json());
  assert.equal(durableEvents.some((event) =>
    event.domain === "requests"
    && event.eventType === "request-downloading"
    && event.targetId === String(discordRequest.id)
  ), true);
  assert.equal(durableEvents.some((event) =>
    event.domain === "activity"
    && event.eventType === "download-task-created"
    && event.targetId === "task-broker-1"
  ), true);
  assert.equal(durableEvents.some((event) =>
    event.domain === "system"
    && event.eventType === "job-created"
    && event.targetId === "raven-job-1"
  ), true);

  const removedRavenTask = await fetch(`${baseUrl}/api/internal/vault/raven/download-tasks/task-broker-1`, {
    method: "DELETE",
    headers: ravenHeaders
  }).then((response) => response.json());
  assert.equal(removedRavenTask.removed, 1);

  const removalEvents = await fetch(`http://127.0.0.1:${vaultPort}/api/service/events?domain=activity`, {
    headers: vaultHeaders
  }).then((response) => response.json());
  assert.equal(removalEvents.some((event) =>
    event.eventType === "download-task-removed"
    && event.targetId === "task-broker-1"
  ), true);

  const forbidden = await fetch(`${baseUrl}/api/internal/jobs/raven-job-1`, {
    headers: portalHeaders
  });
  assert.equal(forbidden.status, 403);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage returns a service error instead of crashing when an internal proxy fetch fails", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub();
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  const closedServer = http.createServer();
  closedServer.listen(0);
  const closedPort = closedServer.address().port;
  await closeServer(closedServer);

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${closedPort}`;

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;
  const portalHeaders = {
    "Authorization": "Bearer portal-dev-token",
    "Content-Type": "application/json"
  };

  const failedProxy = await fetch(`${baseUrl}/api/internal/portal/raven/bulk-queue`, {
    method: "POST",
    headers: portalHeaders,
    body: JSON.stringify({
      providerId: "weebcentral",
      type: "Manga",
      nsfw: false,
      titlePrefix: "s",
      requestedBy: "owner-1"
    })
  });
  const failedPayload = await failedProxy.json();
  assert.equal(failedProxy.status, 503);
  assert.match(failedPayload.error, /fetch failed/i);

  const stillAlive = await fetch(`${baseUrl}/api/internal/portal/discord-config`, {
    headers: portalHeaders
  });
  assert.equal(stillAlive.status, 200);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

test("sage returns a service error instead of crashing when a brokered Vault call fails", async () => {
  const dependencyStub = await createDependencyStub();
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  const closedServer = http.createServer();
  closedServer.listen(0);
  const closedPort = closedServer.address().port;
  await closeServer(closedServer);

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${closedPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;
  const ravenHeaders = {
    "Authorization": "Bearer raven-dev-token",
    "Content-Type": "application/json"
  };

  const failedBrokerCall = await fetch(`${baseUrl}/api/internal/vault/raven/titles/title-1`, {
    headers: ravenHeaders
  });
  const failedPayload = await failedBrokerCall.json();
  assert.equal(failedBrokerCall.status, 500);
  assert.match(failedPayload.error, /fetch failed/i);

  const stillAlive = await fetch(`${baseUrl}/health`);
  assert.equal(stillAlive.status, 200);

  await closeServer(sageServer);
  await closeServer(dependencyStub.server);
});

test("sage brokers oversized Raven title payloads without tripping internal JSON limits", async () => {
  const {app: vaultApp} = await createVaultApp();
  const vaultServer = vaultApp.listen(0);
  const vaultPort = vaultServer.address().port;

  const dependencyStub = await createDependencyStub();
  dependencyStub.server.listen(0);
  const dependencyPort = dependencyStub.server.address().port;

  process.env.SCRIPTARR_VAULT_BASE_URL = `http://127.0.0.1:${vaultPort}`;
  process.env.SCRIPTARR_WARDEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_PORTAL_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_ORACLE_BASE_URL = `http://127.0.0.1:${dependencyPort}`;
  process.env.SCRIPTARR_RAVEN_BASE_URL = `http://127.0.0.1:${dependencyPort}`;

  const {app: sageApp} = await createSageApp();
  const sageServer = sageApp.listen(0);
  const sagePort = sageServer.address().port;
  const baseUrl = `http://127.0.0.1:${sagePort}`;
  const ravenHeaders = {
    "Authorization": "Bearer raven-dev-token",
    "Content-Type": "application/json"
  };

  const oversizedTitle = {
    id: "title-large",
    title: "Oversized Title Payload",
    mediaType: "manhwa",
    libraryTypeLabel: "Manhwa",
    libraryTypeSlug: "manhwa",
    status: "active",
    latestChapter: "411",
    coverAccent: "#ff6a3d",
    summary: "x".repeat(150_000),
    releaseLabel: "2026",
    chapterCount: 411,
    chaptersDownloaded: 411,
    author: "Scriptarr",
    tags: ["action"],
    aliases: ["Oversized"],
    metadataProvider: "mangadex",
    metadataMatchedAt: "2026-04-21T00:00:00.000Z",
    relations: [],
    sourceUrl: "https://weebcentral.com/series/oversized-title",
    coverUrl: "https://cdn.example.com/oversized.jpg",
    workingRoot: "/downloads/downloading/manhwa/Oversized_Title",
    downloadRoot: "/downloads/downloaded/manhwa/Oversized_Title",
    chapters: Array.from({length: 411}, (_value, index) => ({
      id: `title-large-c${index + 1}`,
      label: `Chapter ${index + 1}`,
      chapterNumber: String(index + 1),
      pageCount: 12,
      releaseDate: "2026-04-21T00:00:00.000Z",
      available: true,
      archivePath: `/downloads/downloaded/manhwa/Oversized_Title/Chapter_${index + 1}.cbz`,
      sourceUrl: `https://weebcentral.com/chapters/oversized-${index + 1}`
    }))
  };

  const stored = await fetch(`${baseUrl}/api/internal/vault/raven/titles/title-large`, {
    method: "PUT",
    headers: ravenHeaders,
    body: JSON.stringify(oversizedTitle)
  });
  assert.equal(stored.status, 200);

  const loaded = await fetch(`${baseUrl}/api/internal/vault/raven/titles/title-large`, {
    headers: ravenHeaders
  }).then((response) => response.json());
  assert.equal(loaded.id, "title-large");
  assert.equal(loaded.chapters.length, 411);
  assert.equal(loaded.summary.length, 150_000);

  await closeServer(sageServer);
  await closeServer(vaultServer);
  await closeServer(dependencyStub.server);
});

