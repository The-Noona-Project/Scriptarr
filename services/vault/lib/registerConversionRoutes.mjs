/** Register Sage-only durable conversion operations after Vault service authentication. */
export const registerConversionRoutes = (app, {store, requireJson}) => {
  const base = "/api/service/raven-ingest";
  app.use(base, (req, res, next) => {
    if (req.serviceName !== "scriptarr-sage") { res.status(403).json({error: "Only Sage may access conversion storage."}); return; }
    next();
  });
  const route = (verb, path, action) => app[verb](base + path, ...(verb === "get" ? [] : [requireJson]), async (req, res) => {
    try {
      const result = await action(req);
      if (result == null) { res.status(204).end(); return; }
      res.json(result);
    } catch (error) {
      const status = Number(error.status) || 500;
      res.status(status).json({error: status >= 500 ? "Conversion storage is unavailable." : error.message, code: error.code || "CONVERSION_STORE_ERROR"});
    }
  });
  route("get", "/pool", () => store.getConversionPool());
  route("post", "/workers/heartbeat", req => store.heartbeatConversionWorker(req.body));
  route("post", "/jobs", req => store.createConversionJob(req.body));
  route("get", "/jobs", req => store.listConversionJobs(req.query));
  route("get", "/jobs/:jobId", async req => {
    const job = await store.getConversionJob(req.params.jobId);
    if (!job) throw Object.assign(new Error("Conversion job not found."), {status: 404});
    return job;
  });
  route("post", "/claims", req => store.claimConversionJob(req.body));
  route("post", "/jobs/:jobId/lease", req => store.authorizeConversionLease(req.params.jobId, req.body, {artifactReplay: req.body.artifactReplay === true}));
  route("post", "/jobs/:jobId/heartbeat", req => store.renewConversionJob(req.params.jobId, req.body, {coordinator: req.body.coordinator === true}));
  for (const [suffix, method] of [["submit", "submitConversionJob"], ["publish", "publishConversionJob"], ["complete", "completeConversionJob"], ["cancel", "cancelConversionJob"], ["retry", "retryConversionJob"], ["fail", "failConversionJob"]]) {
    route("post", `/jobs/:jobId/${suffix}`, req => store[method](req.params.jobId, req.body));
  }
  for (const [suffix, method] of [["preview", "previewScopedContentReset"], ["begin", "beginScopedContentReset"], ["apply", "applyScopedContentReset"], ["finish", "finishScopedContentReset"]]) {
    route("post", `/content-reset/${suffix}`, req => store[method](req.body));
  }
};
