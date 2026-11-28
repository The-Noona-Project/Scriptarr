/** @file Portal-authenticated release feed mutations and bounded artwork transport. */
import {sageFetch} from "./httpTransport.mjs";
import {createReleaseFeedBroker} from "./releaseFeedBroker.mjs";

/** Register the catalog-backed feed without changing legacy release callers before cutover.
 * @param {object} app Express application.
 * @param {{config: object, vaultClient: object, requireService: Function, fetchImpl?: Function, logger?: object}} options Auth, configuration and storage dependencies.
 * @returns {object} Broker used by observational legacy-compatible list routes.
 */
export const registerReleaseFeedRoutes = (app, {config, vaultClient, requireService, fetchImpl = sageFetch, logger}) => {
  const feed = createReleaseFeedBroker({config, vaultClient});
  const prefix = "/api/internal/portal/notifications/releases";
  const route = (method, suffix, action) => app[method](prefix + suffix, requireService(["scriptarr-portal"]), async (req, res) => {
    try { await action(req, res); }
    catch (error) {
      logger?.warn?.("Release feed operation failed.", {operation: `${method} ${suffix}`, status: error.status || 503, reason: error.message});
      if (res.headersSent) res.destroy(); else res.status(error.status || 503).json({error: error.status < 500 ? error.message : "Release feed temporarily unavailable."});
    }
  });
  route("post", "/prepare", async (_req, res) => res.json(await feed.prepare()));
  route("post", "/:notificationId/begin", async (req, res) => res.json({delivery: await feed.begin(req.params.notificationId)}));
  route("post", "/:notificationId/delivery", async (req, res) => res.json({delivery: await feed.record(req.params.notificationId, req.body || {})}));
  route("get", "/:notificationId/art", async (req, res) => {
    const event = await feed.event(req.params.notificationId);
    if (!event || event.kind !== "title") {res.status(404).end(); return;}
    const token = config.serviceTokens?.["scriptarr-raven"] || config.serviceToken;
    const response = await fetchImpl(`${config.ravenBaseUrl}/v1/library/${encodeURIComponent(event.titleId)}/notification-art`,
      {headers: {Authorization: `Bearer ${token}`}, redirect: "error", signal: AbortSignal.timeout(25000)});
    if (!response.ok) {await response.body?.cancel(); res.status(503).json({error: "Release artwork is not ready."}); return;}
    const mime = response.headers.get("content-type")?.split(";")[0];
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {await response.body?.cancel(); throw new Error("Invalid release artwork.");}
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error("Release artwork exceeds its bound.");
      chunks.push(Buffer.from(chunk));
    }
    if (!size) throw new Error("Release artwork is empty.");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", mime);
    res.setHeader("X-Scriptarr-Art-Source", response.headers.get("x-scriptarr-art-source") || "cover");
    res.end(Buffer.concat(chunks));
  });
  return feed;
};
