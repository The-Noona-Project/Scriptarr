import express from "express";
import {createLogger} from "@scriptarr/logging";
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
 * @param {{
 *   logger?: {info: Function, warn: Function}
 * }} [options]
 * @returns {Promise<{
 *   app: import("express").Express,
  *   config: ReturnType<typeof resolveMoonConfig>
  * }>}
 */
export const createMoonApp = async ({logger = createLogger("MOON")} = {}) => {
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

  registerAuthRoutes(app, {config, getSessionToken, logger});
  registerLegacyApiRoutes(app, {config, getSessionToken});
  registerMoonV3ProxyRoutes(app, {config, getSessionToken});
  registerPageRoutes(app, {config});

  logger.info("Moon app initialized.", {
    sageBaseUrl: config.sageBaseUrl
  });

  return {app, config};
};

export default createMoonApp;
