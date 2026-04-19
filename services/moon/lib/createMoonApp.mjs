import express from "express";
import {resolveMoonConfig} from "./config.mjs";
import {parseCookies} from "./cookies.mjs";
import {registerAuthRoutes} from "./registerAuthRoutes.mjs";
import {registerLegacyApiRoutes} from "./registerLegacyApiRoutes.mjs";
import {registerMoonV3ProxyRoutes} from "./registerMoonV3ProxyRoutes.mjs";
import {registerPageRoutes} from "./registerPageRoutes.mjs";

/**
 * Build the Scriptarr Moon HTTP application.
 *
 * Moon remains a single runtime that serves two distinct browser programs:
 * the forward-facing reader UI at `/` and the Arr-style admin UI at `/admin`.
 *
 * @returns {Promise<{
 *   app: import("express").Express,
 *   config: ReturnType<typeof resolveMoonConfig>
 * }>}
 */
export const createMoonApp = async () => {
  const config = resolveMoonConfig();
  const app = express();

  app.use(express.json());

  /**
   * Read the Moon session token from the request cookie jar.
   *
   * @param {import("express").Request} request
   * @returns {string}
   */
  const getSessionToken = (request) => parseCookies(request.headers.cookie || "")[config.sessionCookieName] || "";

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "scriptarr-moon",
      programs: ["/", "/admin"]
    });
  });

  registerAuthRoutes(app, {config, getSessionToken});
  registerLegacyApiRoutes(app, {config, getSessionToken});
  registerMoonV3ProxyRoutes(app, {config, getSessionToken});
  registerPageRoutes(app);

  return {app, config};
};

export default createMoonApp;
