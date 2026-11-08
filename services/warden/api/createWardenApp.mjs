/**
 * @file Scriptarr Warden module: services/warden/api/createWardenApp.mjs.
 */
import express from "express";
import {registerHealthRoutes} from "./registerHealthRoutes.mjs";
import {registerLocalAiRoutes} from "./registerLocalAiRoutes.mjs";
import {registerRuntimeRoutes} from "./registerRuntimeRoutes.mjs";
import {createWardenRuntime} from "../core/createWardenRuntime.mjs";
import {createWardenControlAuthorization} from "./controlSecurity.mjs";

/**
 * Create the Scriptarr Warden Express app and its runtime wrapper.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{
 *   app: import("express").Express,
 *   runtime: ReturnType<typeof createWardenRuntime>,
 *   config: ReturnType<typeof createWardenRuntime>["config"],
 *   logger: ReturnType<typeof createWardenRuntime>["logger"]
 * }}
 */
export const createWardenApp = ({env = process.env} = {}) => {
  const runtime = createWardenRuntime({env});
  const app = express();

  app.use(express.json());

  registerHealthRoutes(app, runtime);
  app.use("/api", createWardenControlAuthorization({env}));
  registerRuntimeRoutes(app, runtime);
  registerLocalAiRoutes(app, runtime);
  app.use((error, _req, res, _next) => {
    res.status(Number.isInteger(error.status) ? error.status : 500).json({error: error.status ? error.message : "Warden control request failed."});
  });

  return {
    app,
    runtime,
    config: runtime.config,
    logger: runtime.logger
  };
};

