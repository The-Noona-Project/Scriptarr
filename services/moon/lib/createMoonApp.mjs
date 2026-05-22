import express from "express";
import {createLogger} from "@scriptarr/logging";
import {resolveMoonConfig} from "./config.mjs";
import {parseCookies} from "./cookies.mjs";
import {registerAuthRoutes} from "./registerAuthRoutes.mjs";
import {registerLegacyApiRoutes} from "./registerLegacyApiRoutes.mjs";
import {registerMoonV3ProxyRoutes} from "./registerMoonV3ProxyRoutes.mjs";
import {registerPageRoutes} from "./registerPageRoutes.mjs";
import {registerPublicApiRoutes} from "./registerPublicApiRoutes.mjs";
import {createAdminNextRuntime} from "./createAdminNextRuntime.mjs";
import {createReaderNextRuntime} from "./createReaderNextRuntime.mjs";
import {createUserNextRuntime} from "./createUserNextRuntime.mjs";
import {proxyRequest} from "./proxy.mjs";

const SAGE_WARMUP_TIMEOUT_MS = 7000;
const SAGE_WARMUP_PATHS = Object.freeze([
  "/api/moon-v3/public/branding",
  "/api/auth/status",
  "/api/auth/bootstrap-status"
]);

/**
 * Warm Moon's internal Sage connection before the public listener opens.
 *
 * @param {{sageBaseUrl: string}} config
 * @param {{info?: Function, warn?: Function}} logger
 * @returns {Promise<void>}
 */
const warmSageBrokerConnection = async (config, logger) => {
  if (process.env.NODE_ENV === "test") {
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SAGE_WARMUP_TIMEOUT_MS);
  try {
    const responses = await Promise.all(SAGE_WARMUP_PATHS.map((path) => proxyRequest({
      baseUrl: config.sageBaseUrl,
      path,
      signal: controller.signal
    })));
    logger.info?.("Moon warmed the Sage broker connection.", {
      statuses: responses.map((response) => response.status)
    });
  } catch (error) {
    logger.warn?.("Moon could not warm the Sage broker connection.", {
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Build the Scriptarr Moon HTTP application.
 *
 * Moon remains a single runtime that serves three distinct browser programs:
 * the user library at `/`, the fullscreen reader at `/reader`, and the
 * Arr-style admin UI at `/admin`.
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
  const adminNextRuntime = await createAdminNextRuntime({logger});
  const readerNextRuntime = await createReaderNextRuntime({logger});
  const userNextRuntime = await createUserNextRuntime({logger});
  await warmSageBrokerConnection(config, logger);

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
      programs: ["/", "/reader", "/admin"]
    });
  });

  registerAuthRoutes(app, {config, getSessionToken, logger});
  registerLegacyApiRoutes(app, {config, getSessionToken});
  registerMoonV3ProxyRoutes(app, {config, getSessionToken, logger});
  registerPublicApiRoutes(app, {config});
  registerPageRoutes(app, {adminNextRuntime, config, getSessionToken, readerNextRuntime, userNextRuntime});

  logger.info("Moon app initialized.", {
    sageBaseUrl: config.sageBaseUrl
  });

  return {app, config};
};

export default createMoonApp;
