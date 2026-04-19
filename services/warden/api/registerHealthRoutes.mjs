/**
 * Register the basic health route for the Warden API.
 *
 * @param {import("express").Express} app
 * @param {{config: {stackMode: string}}} runtime
 */
export const registerHealthRoutes = (app, runtime) => {
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "scriptarr-warden",
      stackMode: runtime.config.stackMode
    });
  });
};
