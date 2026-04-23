import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {deriveShortSiteName, normalizeSiteName, readMoonBranding} from "./branding.mjs";
import {proxyJson} from "./proxy.mjs";

/**
 * Read a static Moon HTML entry file.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
const readHtml = (filePath) => fs.readFile(filePath, "utf8");

const hashContent = (content) => crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);

const toVersionedAssetPath = (assetPath, content) => `${assetPath}?v=${hashContent(content)}`;

const renderVersionedHtml = async (htmlPath, replacements) => {
  let html = await readHtml(htmlPath);
  for (const [from, to] of replacements) {
    html = html.replaceAll(from, to);
  }
  return html;
};

const collectAssetFiles = async (rootPath) => {
  const entries = await fs.readdir(rootPath, {withFileTypes: true});
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && [".next", "node_modules"].includes(entry.name)) {
      continue;
    }
    const nextPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectAssetFiles(nextPath));
    } else if (entry.isFile()) {
      files.push(nextPath);
    }
  }

  return files.sort();
};

const resolveAssetVersion = async (rootPath, extensions) => {
  const files = await collectAssetFiles(rootPath);
  const hash = crypto.createHash("sha256");

  for (const filePath of files) {
    if (!extensions.has(path.extname(filePath))) {
      continue;
    }
    hash.update(path.relative(rootPath, filePath));
    hash.update("\n");
    hash.update(await fs.readFile(filePath));
    hash.update("\n");
  }

  return hash.digest("hex").slice(0, 12);
};

const appendAssetVersion = (assetPath, version) => {
  if (!version) {
    return assetPath;
  }
  return assetPath.includes("?") ? `${assetPath}&v=${version}` : `${assetPath}?v=${version}`;
};

const canAccessAdmin = (user) => Boolean(
  user
  && (
    user.role === "owner"
    || user.role === "admin"
    || (Array.isArray(user.permissions) && user.permissions.includes("admin"))
  )
);

const rewriteJavascriptImports = (source, version) =>
  source
    .replace(/(from\s*["'])(\.{1,2}\/[^"']+\.js)(["'])/g, (_match, prefix, specifier, suffix) =>
      `${prefix}${appendAssetVersion(specifier, version)}${suffix}`
    )
    .replace(/(import\s*["'])(\.{1,2}\/[^"']+\.js)(["'])/g, (_match, prefix, specifier, suffix) =>
      `${prefix}${appendAssetVersion(specifier, version)}${suffix}`
    )
    .replace(/(import\s*\(\s*["'])(\.{1,2}\/[^"']+\.js)(["']\s*\))/g, (_match, prefix, specifier, suffix) =>
      `${prefix}${appendAssetVersion(specifier, version)}${suffix}`
    );

const staticAssetOptions = () => ({
  immutable: true,
  maxAge: "1y",
  setHeaders: (response, assetPath) => {
    if (String(assetPath).endsWith(".js")) {
      response.setHeader("Cache-Control", "no-store");
    }
  }
});

const registerVersionedJsAssets = (app, routePrefix, assetsPath, resolveVersion) => {
  app.use(routePrefix, async (request, response, next) => {
    if (!request.path.endsWith(".js")) {
      next();
      return;
    }

    const relativePath = String(request.path).replace(/^\/+/, "");
    const assetPath = path.resolve(assetsPath, relativePath);
    const resolvedRoot = path.resolve(assetsPath);

    if (!assetPath.startsWith(resolvedRoot)) {
      response.status(400).end("Invalid asset path.");
      return;
    }

    try {
      const [source, version] = await Promise.all([
        fs.readFile(assetPath, "utf8"),
        resolveVersion()
      ]);
      response.setHeader("Cache-Control", "no-store");
      response.type("text/javascript").send(rewriteJavascriptImports(source, version));
    } catch (error) {
      if (error?.code === "ENOENT") {
        next();
        return;
      }
      next(error);
    }
  });
};

const renderServiceWorker = ({assetVersion}) => `
const STATIC_CACHE = "moon-static-${assetVersion}";
const READER_CACHE = "moon-reader-${assetVersion}";
const INDEX_REQUEST = "/__moon_recent_chapters__";
const MAX_RECENT_CHAPTERS = 5;
const STATIC_ASSETS = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-maskable.svg"];

const isReaderChapterRequest = (requestUrl) =>
  requestUrl.pathname.startsWith("/api/moon/v3/user/reader/title/") &&
  /\\/chapter\\/[^/]+$/.test(requestUrl.pathname);

const isReaderPageRequest = (requestUrl) =>
  requestUrl.pathname.startsWith("/api/moon/v3/user/reader/title/") &&
  /\\/chapter\\/[^/]+\\/page\\/\\d+$/.test(requestUrl.pathname);

const chapterPrefixFromPath = (pathname) => pathname.replace(/\\/page\\/\\d+$/, "");

const readRecentIndex = async () => {
  const cache = await caches.open(READER_CACHE);
  const response = await cache.match(INDEX_REQUEST);
  if (!response) {
    return [];
  }
  return response.json().catch(() => []);
};

const writeRecentIndex = async (entries) => {
  const cache = await caches.open(READER_CACHE);
  await cache.put(INDEX_REQUEST, new Response(JSON.stringify(entries), {
    headers: {"Content-Type": "application/json"}
  }));
};

const trimRecentChapters = async (keepPrefixes) => {
  const cache = await caches.open(READER_CACHE);
  const keys = await cache.keys();

  for (const request of keys) {
    const url = new URL(request.url);
    if (url.pathname === INDEX_REQUEST) {
      continue;
    }

    const chapterPrefix = chapterPrefixFromPath(url.pathname);
    if (!keepPrefixes.includes(chapterPrefix)) {
      await cache.delete(request);
    }
  }
};

const rememberChapter = async (requestUrl) => {
  const chapterPrefix = chapterPrefixFromPath(requestUrl.pathname);
  const entries = await readRecentIndex();
  const nextEntries = [chapterPrefix, ...entries.filter((entry) => entry !== chapterPrefix)].slice(0, MAX_RECENT_CHAPTERS);
  await writeRecentIndex(nextEntries);
  await trimRecentChapters(nextEntries);
};

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(STATIC_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => ![STATIC_CACHE, READER_CACHE].includes(key))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);

  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, {cache: "no-store"});
        const cache = await caches.open(STATIC_CACHE);
        await cache.put("/", response.clone());
        return response;
      } catch {
        const cache = await caches.open(STATIC_CACHE);
        return (await cache.match("/")) || Response.error();
      }
    })());
    return;
  }

  if (isReaderChapterRequest(requestUrl) || isReaderPageRequest(requestUrl)) {
    event.respondWith((async () => {
      const cache = await caches.open(READER_CACHE);
      const cached = await cache.match(event.request);
      if (cached) {
        return cached;
      }

      const response = await fetch(event.request);
      if (response.ok) {
        await cache.put(event.request, response.clone());
        await rememberChapter(requestUrl);
      }
      return response;
    })());
    return;
  }
});
`;

const renderUserFallbackHtml = ({siteName}) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${siteName}</title>
  <meta name="application-name" content="${siteName}">
  <meta name="theme-color" content="#0f1418">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon-maskable.svg">
  <link rel="manifest" href="/manifest.webmanifest">
</head>
<body>
  <main>
    <h1>${siteName}</h1>
    <p>Moon's user app now runs through the embedded Next runtime.</p>
  </main>
</body>
</html>`;

/**
 * Register Moon's static assets, legacy redirects, and the two HTML program
 * entry points used by the admin and user SPAs.
 *
 * @param {import("express").Express} app
 * @param {{
 *   config?: {sageBaseUrl?: string},
 *   getSessionToken?: (request: import("express").Request) => string,
 *   userNextRuntime?: {handle: (request: import("http").IncomingMessage, response: import("http").ServerResponse) => Promise<void>} | null
 * }} [options]
 * @returns {void}
 */
export const registerPageRoutes = (app, {config = {}, getSessionToken = () => "", userNextRuntime = null} = {}) => {
  const adminHtmlPath = path.join(process.cwd(), "apps", "admin", "index.html");
  const adminAssetsPath = path.join(process.cwd(), "apps", "admin", "assets");
  const userNextAppPath = path.join(process.cwd(), "apps", "user-next");
  const userIconPath = path.join(userNextAppPath, "app", "icon.svg");
  const userMaskableIconPath = path.join(userNextAppPath, "app", "icon-maskable.svg");
  const adminStylesPath = path.join(process.cwd(), "apps", "admin", "assets", "styles.css");
  const resolveUserAssetVersion = () => resolveAssetVersion(userNextAppPath, new Set([".js", ".jsx", ".css", ".svg"]));
  const resolveAdminJsVersion = () => resolveAssetVersion(adminAssetsPath, new Set([".js"]));
  const loadBranding = () => readMoonBranding(config.sageBaseUrl || "");

  registerVersionedJsAssets(app, "/admin-assets", adminAssetsPath, resolveAdminJsVersion);
  app.use("/admin-assets", express.static(adminAssetsPath, staticAssetOptions()));

  const renderAdminHtml = async () => {
    const [styles, jsVersion, branding] = await Promise.all([
      fs.readFile(adminStylesPath, "utf8"),
      resolveAdminJsVersion(),
      loadBranding()
    ]);

    return renderVersionedHtml(adminHtmlPath, [
      ["__MOON_ADMIN_TITLE__", `${normalizeSiteName(branding.siteName)} Admin`],
      ["__MOON_SITE_NAME__", normalizeSiteName(branding.siteName)],
      ["/admin-assets/styles.css", toVersionedAssetPath("/admin-assets/styles.css", styles)],
      ["/admin-assets/app.js", appendAssetVersion("/admin-assets/app.js", jsVersion)]
    ]);
  };

  app.get("/downloads", (_req, res) => {
    res.redirect("/admin/activity/queue");
  });

  app.get("/settings", (_req, res) => {
    res.redirect("/admin/settings");
  });

  app.get("/setupwizard", (_req, res) => {
    res.redirect("/admin");
  });

  app.get("/icon.svg", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(userIconPath);
  });

  app.get("/icon-maskable.svg", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(userMaskableIconPath);
  });

  app.get("/manifest.webmanifest", async (_req, res) => {
    const branding = await loadBranding();
    res.setHeader("Cache-Control", "no-store");
    res.type("application/manifest+json").send(JSON.stringify({
      name: normalizeSiteName(branding.siteName),
      short_name: deriveShortSiteName(branding.siteName),
      description: `${normalizeSiteName(branding.siteName)} lets readers browse, follow, and read type-scoped libraries from one installable web app.`,
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#0f1418",
      theme_color: "#0f1418",
      icons: [
        {
          src: "/icon.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any"
        },
        {
          src: "/icon-maskable.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "maskable"
        }
      ]
    }));
  });

  app.get("/service-worker.js", async (_req, res) => {
    const assetVersion = await resolveUserAssetVersion();
    res.setHeader("Cache-Control", "no-store");
    res.type("text/javascript").send(renderServiceWorker({
      assetVersion
    }));
  });

  const guardAdminRequest = async (req, res) => {
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      return false;
    }

    try {
      const auth = await proxyJson({
        baseUrl: config.sageBaseUrl || "",
        path: "/api/auth/status",
        sessionToken
      });

      if (auth.status === 401) {
        return false;
      }

      const user = auth.payload?.user || auth.payload || null;

      if (!canAccessAdmin(user)) {
        res.redirect("/");
        return true;
      }
    } catch {
      return false;
    }

    return false;
  };

  app.get("/admin", async (req, res) => {
    if (await guardAdminRequest(req, res)) {
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(await renderAdminHtml());
  });

  app.get("/admin/*splat", async (req, res) => {
    if (await guardAdminRequest(req, res)) {
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(await renderAdminHtml());
  });

  app.get("/", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (userNextRuntime) {
      await userNextRuntime.handle(_req, res);
      return;
    }
    const branding = await loadBranding();
    res.type("html").send(renderUserFallbackHtml({
      siteName: normalizeSiteName(branding.siteName)
    }));
  });

  if (userNextRuntime) {
    app.all("/_next/*splat", async (req, res) => {
      await userNextRuntime.handle(req, res);
    });
  }

  app.all("/api/*splat", (_req, res) => {
    res.status(404).json({error: "Not found"});
  });

  app.get("/*splat", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (userNextRuntime) {
      await userNextRuntime.handle(_req, res);
      return;
    }
    const branding = await loadBranding();
    res.type("html").send(renderUserFallbackHtml({
      siteName: normalizeSiteName(branding.siteName)
    }));
  });
};

/**
 * Express is loaded lazily here to keep the route registration module small and
 * focused on Moon's static asset and HTML behavior.
 */
const express = await import("express").then((module) => module.default);

export default registerPageRoutes;
