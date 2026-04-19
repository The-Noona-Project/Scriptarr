/**
 * @file Scriptarr Warden module: services/warden/api/createWardenApp.mjs.
 */
import express from "express";
import {registerHealthRoutes} from "./registerHealthRoutes.mjs";
import {registerLocalAiRoutes} from "./registerLocalAiRoutes.mjs";
import {registerRuntimeRoutes} from "./registerRuntimeRoutes.mjs";
import {createWardenRuntime} from "../core/createWardenRuntime.mjs";

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
  registerRuntimeRoutes(app, runtime);
  registerLocalAiRoutes(app, runtime);

  return {
    app,
    runtime,
    config: runtime.config,
    logger: runtime.logger
  };
};

