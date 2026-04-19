/**
 * Register the LocalAI configuration and lifecycle routes.
 *
 * @param {import("express").Express} app
 * @param {{
 *   getLocalAiStatus: () => Record<string, unknown>,
 *   refreshLocalAiStatus: () => Promise<Record<string, unknown>>,
 *   configureLocalAi: (payload?: {profileKey?: string, imageMode?: string, customImage?: string}) => Promise<Record<string, unknown>>,
 *   installLocalAi: () => Promise<Record<string, unknown>>,
 *   startLocalAi: () => Promise<Record<string, unknown>>
 * }} runtime
 */
export const registerLocalAiRoutes = (app, runtime) => {
  app.get("/api/localai/profile", (_req, res) => {
    res.json(runtime.getLocalAiStatus());
  });

  app.get("/api/localai/status", async (_req, res) => {
    res.json(await runtime.refreshLocalAiStatus());
  });

  app.put("/api/localai/config", async (req, res) => {
    res.json(await runtime.configureLocalAi(req.body || {}));
  });

  app.post("/api/localai/actions/install", async (_req, res) => {
    res.status(202).json(await runtime.installLocalAi());
  });

  app.post("/api/localai/actions/start", async (_req, res) => {
    res.status(202).json(await runtime.startLocalAi());
  });
};
