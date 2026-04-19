import fs from "node:fs/promises";
import path from "node:path";

/**
 * Read a static Moon HTML entry file.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
const readHtml = (filePath) => fs.readFile(filePath, "utf8");

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

  app.use("/user-assets", express.static(path.join(process.cwd(), "apps", "user", "assets")));
  app.use("/admin-assets", express.static(path.join(process.cwd(), "apps", "admin", "assets")));

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
    res.type("html").send(await readHtml(adminHtmlPath));
  });

  app.get("/admin/*splat", async (_req, res) => {
    res.type("html").send(await readHtml(adminHtmlPath));
  });

  app.get("/", async (_req, res) => {
    res.type("html").send(await readHtml(userHtmlPath));
  });

  app.get("/*splat", async (_req, res) => {
    res.type("html").send(await readHtml(userHtmlPath));
  });
};

/**
 * Express is loaded lazily here to keep the route registration module small and
 * focused on Moon's static asset and HTML behavior.
 */
const express = await import("express").then((module) => module.default);

export default registerPageRoutes;
