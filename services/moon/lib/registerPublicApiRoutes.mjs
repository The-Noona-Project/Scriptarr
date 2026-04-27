import {proxyJson} from "./proxy.mjs";

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const docsHtml = () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Scriptarr Moon Public API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
    <style>
      body { margin: 0; background: #fff; }
      #swagger-ui { min-height: 100vh; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/api/public/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        persistAuthorization: true
      });
    </script>
  </body>
</html>`;

/**
 * Register Moon-owned public API proxy routes and the same-origin Swagger page.
 *
 * @param {import("express").Express} app
 * @param {{config: {sageBaseUrl: string}}} options
 * @returns {void}
 */
export const registerPublicApiRoutes = (app, {config}) => {
  const proxyToSage = (req, path, options = {}) => proxyJson({
    baseUrl: config.sageBaseUrl,
    path,
    method: options.method,
    body: options.body,
    headers: {
      ...(req.get("X-Scriptarr-Api-Key") ? {"X-Scriptarr-Api-Key": req.get("X-Scriptarr-Api-Key")} : {})
    }
  });

  app.get("/api/public/openapi.json", async (req, res) => {
    const result = await proxyToSage(req, "/api/public/openapi.json");
    res.status(result.status).json(result.payload);
  });

  app.get("/api/public/v1/search", async (req, res) => {
    const query = normalizeString(req.query.q);
    const result = await proxyToSage(req, `/api/public/v1/search?q=${encodeURIComponent(query)}`);
    res.status(result.status).json(result.payload);
  });

  app.post("/api/public/v1/requests", async (req, res) => {
    const result = await proxyToSage(req, "/api/public/v1/requests", {
      method: "POST",
      body: req.body
    });
    res.status(result.status).json(result.payload);
  });

  app.get("/api/public/v1/requests/:id", async (req, res) => {
    const result = await proxyToSage(req, `/api/public/v1/requests/${encodeURIComponent(req.params.id)}`);
    res.status(result.status).json(result.payload);
  });

  app.get("/api/public/docs", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(docsHtml());
  });
};

export default registerPublicApiRoutes;
