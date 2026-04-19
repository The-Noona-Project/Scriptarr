/**
 * Register the runtime information routes surfaced by Warden.
 *
 * @param {import("express").Express} app
 * @param {{
 *   getRuntime: () => Record<string, unknown>,
 *   getBootstrap: () => Record<string, unknown>,
 *   getStorageLayout: () => Record<string, unknown>,
 *   getDiscordCallbackUrl: () => string
 * }} runtime
 */
export const registerRuntimeRoutes = (app, runtime) => {
  app.get("/api/runtime", (_req, res) => {
    res.json(runtime.getRuntime());
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
};
