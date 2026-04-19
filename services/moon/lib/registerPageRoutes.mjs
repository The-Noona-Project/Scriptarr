import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Read a static Moon HTML entry file.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
const readHtml = (filePath) => fs.readFile(filePath, "utf8");

const toVersionedAssetPath = (assetPath, content) => {
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
  return `${assetPath}?v=${hash}`;
};

const renderVersionedHtml = async (htmlPath, replacements) => {
  let html = await readHtml(htmlPath);
  for (const [from, to] of replacements) {
    html = html.replaceAll(from, to);
  }
  return html;
};

const hashContent = (content) => crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);

const collectAssetFiles = async (rootPath) => {
  const entries = await fs.readdir(rootPath, {withFileTypes: true});
  const files = [];

  for (const entry of entries) {
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

/**
 * Register Moon's static assets, legacy redirects, and the two HTML program
 * entry points used by the admin and user SPAs.
 *
 * @param {import("express").Express} app
 * @returns {void}
 */
export const registerPageRoutes = (app) => {
  const userHtmlPath = path.join(process.cwd(), "apps", "user", "index.html");
  const adminHtmlPath = path.join(process.cwd(), "apps", "admin", "index.html");
  const userAssetsPath = path.join(process.cwd(), "apps", "user", "assets");
  const adminAssetsPath = path.join(process.cwd(), "apps", "admin", "assets");
  const userStylesPath = path.join(process.cwd(), "apps", "user", "assets", "styles.css");
  const userAppPath = path.join(process.cwd(), "apps", "user", "assets", "app.js");
  const adminStylesPath = path.join(process.cwd(), "apps", "admin", "assets", "styles.css");
  const adminAppPath = path.join(process.cwd(), "apps", "admin", "assets", "app.js");
  const resolveUserJsVersion = () => resolveAssetVersion(userAssetsPath, new Set([".js"]));
  const resolveAdminJsVersion = () => resolveAssetVersion(adminAssetsPath, new Set([".js"]));

  registerVersionedJsAssets(app, "/user-assets", userAssetsPath, resolveUserJsVersion);
  registerVersionedJsAssets(app, "/admin-assets", adminAssetsPath, resolveAdminJsVersion);
  app.use("/user-assets", express.static(userAssetsPath, staticAssetOptions()));
  app.use("/admin-assets", express.static(adminAssetsPath, staticAssetOptions()));

  app.get("/downloads", (_req, res) => {
    res.redirect("/admin/activity/queue");
  });

  app.get("/settings", (_req, res) => {
    res.redirect("/admin/settings");
  });

  app.get("/setupwizard", (_req, res) => {
    res.redirect("/admin");
  });

  app.get("/admin", async (_req, res) => {
    const [styles, jsVersion] = await Promise.all([
      fs.readFile(adminStylesPath, "utf8"),
      resolveAdminJsVersion()
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(await renderVersionedHtml(adminHtmlPath, [
      ["/admin-assets/styles.css", toVersionedAssetPath("/admin-assets/styles.css", styles)],
      ["/admin-assets/app.js", appendAssetVersion("/admin-assets/app.js", jsVersion)]
    ]));
  });

  app.get("/admin/*splat", async (_req, res) => {
    const [styles, jsVersion] = await Promise.all([
      fs.readFile(adminStylesPath, "utf8"),
      resolveAdminJsVersion()
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(await renderVersionedHtml(adminHtmlPath, [
      ["/admin-assets/styles.css", toVersionedAssetPath("/admin-assets/styles.css", styles)],
      ["/admin-assets/app.js", appendAssetVersion("/admin-assets/app.js", jsVersion)]
    ]));
  });

  app.get("/", async (_req, res) => {
    const [styles, jsVersion] = await Promise.all([
      fs.readFile(userStylesPath, "utf8"),
      resolveUserJsVersion()
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(await renderVersionedHtml(userHtmlPath, [
      ["/user-assets/styles.css", toVersionedAssetPath("/user-assets/styles.css", styles)],
      ["/user-assets/app.js", appendAssetVersion("/user-assets/app.js", jsVersion)]
    ]));
  });

  app.get("/*splat", async (_req, res) => {
    const [styles, jsVersion] = await Promise.all([
      fs.readFile(userStylesPath, "utf8"),
      resolveUserJsVersion()
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(await renderVersionedHtml(userHtmlPath, [
      ["/user-assets/styles.css", toVersionedAssetPath("/user-assets/styles.css", styles)],
      ["/user-assets/app.js", appendAssetVersion("/user-assets/app.js", jsVersion)]
    ]));
  });
};

/**
 * Express is loaded lazily here to keep the route registration module small and
 * focused on Moon's static asset and HTML behavior.
 */
const express = await import("express").then((module) => module.default);

export default registerPageRoutes;
