/**
 * @file Scriptarr Warden module: services/warden/api/registerHealthRoutes.mjs.
 */
/**
 * Register the basic health route for the Warden API.
 *
 * @param {import("express").Express} app
 * @param {{getHealth: () => Promise<Record<string, unknown>>}} runtime
 */
export const registerHealthRoutes = (app, runtime) => {
  app.get("/health", async (_req, res) => {
    res.json(await runtime.getHealth());
  });
};

