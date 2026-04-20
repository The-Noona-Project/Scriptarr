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
      body { margin: 0; background: #0c1117; color: #e8edf2; font-family: "IBM Plex Sans", system-ui, sans-serif; }
      .swagger-shell { padding: 24px; }
      .swagger-header { margin-bottom: 20px; }
      .swagger-header h1 { margin: 0 0 8px; font-size: 2rem; }
      .swagger-header p { margin: 0; color: #9fb0c2; }
      #swagger-ui { background: #ffffff; border-radius: 16px; overflow: hidden; }
    </style>
  </head>
  <body>
    <main class="swagger-shell">
      <header class="swagger-header">
        <h1>Scriptarr Moon Public API</h1>
        <p>Trusted automation API for safe title search and queueing. Use the <code>X-Scriptarr-Api-Key</code> header for protected operations.</p>
      </header>
      <div id="swagger-ui"></div>
    </main>
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
