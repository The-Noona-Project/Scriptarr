/**
 * @file Scriptarr Warden module: services/warden/api/registerRuntimeRoutes.mjs.
 */
/**
 * Register the runtime information routes surfaced by Warden.
 *
 * @param {import("express").Express} app
 * @param {{
 *   getRuntime: () => Promise<Record<string, unknown>>,
 *   getBootstrap: () => Record<string, unknown>,
 *   getStorageLayout: () => Record<string, unknown>,
 *   getUpdates: () => Promise<Record<string, unknown>>,
 *   checkUpdates: (requestedServices?: string[]) => Promise<Record<string, unknown>>,
 *   installUpdates: (requestedServices?: string[]) => Promise<Record<string, unknown>>,
 *   getDiscordCallbackUrl: () => string
 * }} runtime
 */
export const registerRuntimeRoutes = (app, runtime) => {
  app.get("/api/runtime", async (_req, res) => {
    res.json(await runtime.getRuntime());
  });

  app.get("/api/bootstrap", (_req, res) => {
    res.json(runtime.getBootstrap());
  });

  app.get("/api/storage/layout", (_req, res) => {
    res.json(runtime.getStorageLayout());
  });

  app.get("/api/discord/callback-url", (_req, res) => {
    res.json({
      callbackUrl: runtime.getDiscordCallbackUrl()
    });
  });

  app.get("/api/updates", async (_req, res) => {
    res.json(await runtime.getUpdates());
  });

  app.post("/api/updates/check", async (req, res) => {
    res.json(await runtime.checkUpdates(req.body?.services));
  });

  app.post("/api/updates/install", async (req, res) => {
    res.status(202).json(await runtime.installUpdates(req.body?.services));
  });
};

