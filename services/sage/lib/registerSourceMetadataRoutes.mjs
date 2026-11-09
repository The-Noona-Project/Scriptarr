/** @file Authenticated metadata evidence and owner-only bulk metadata repair. */
import {sourceMetadataDisplay} from "./sourceMetadataDisplay.mjs";

/**
 * Register focused routes without growing the main Moon route assembler.
 * @param {any} app Express app.
 * @param {Record<string, any>} deps Broker clients and existing authorization wrappers.
 * @returns {void}
 */
export const registerSourceMetadataRoutes = (app, {userRead, adminRead, ownerWrite, loadUserSummary, loadTitle, readOwnerId, vaultClient, serviceJson, ravenBaseUrl}) => {
  app.get("/api/moon-v3/admin/activity/bulk-runs/:runId", ownerWrite(async (req, res) => {
    const owner = await readOwnerId();
    if (!owner || req.user.discordUserId !== owner) { res.status(403).json({error: "Only the configured downloadall owner can inspect this repair window."}); return; }
    const result = await serviceJson(ravenBaseUrl, `/v1/downloads/bulk-runs/${encodeURIComponent(req.params.runId)}`);
    if (result.ok && result.payload?.requestedBy !== owner) { res.status(403).json({error: "Run ownership does not match."}); return; }
    res.status(result.status || 503).json(result.payload);
  }));
  app.get("/api/moon-v3/user/title/:titleId/metadata", userRead(async (req, res) => {
    const summary = await loadUserSummary(req.user.discordUserId, req.params.titleId);
    if (!summary?.title?.id) { res.status(404).json({error: "Title not found."}); return; }
    res.json(sourceMetadataDisplay(await vaultClient.getRavenMetadataMatch(summary.title.id)));
  }));
  app.get("/api/moon-v3/admin/wanted/metadata/:titleId/evidence", adminRead(async (req, res) => {
    const title = await loadTitle(req.params.titleId);
    if (!title?.id) { res.status(404).json({error: "Title not found."}); return; }
    const [match, current] = await Promise.all([
      vaultClient.getRavenMetadataMatch(title.id),
      serviceJson(ravenBaseUrl, `/v1/metadata/source-evidence/${encodeURIComponent(title.id)}`)
    ]);
    const details = match?.details || {};
    const display = sourceMetadataDisplay(current.ok && current.payload?.ok ? {
      ...match, details: {...details, sourceBinding: {...(details.sourceBinding || {}), source: current.payload.source}}
    } : match);
    if (!current.ok || !current.payload?.ok) display.conflicts.push("Current source facts are unavailable; retained evidence is shown.");
    else if (!current.payload.matchesSaved) display.conflicts.push("Saved metadata has no current verified source binding.");
    res.json(display);
  }));
  app.post("/api/moon-v3/admin/activity/bulk-runs/:runId/recheck-metadata", ownerWrite(async (req, res) => {
    const owner = await readOwnerId();
    if (!owner || req.user.discordUserId !== owner) { res.status(403).json({error: "Only the configured downloadall owner can recheck metadata."}); return; }
    const base = `/v1/downloads/bulk-runs/${encodeURIComponent(req.params.runId)}`;
    const current = await serviceJson(ravenBaseUrl, base);
    if (!current.ok) { res.status(current.status || 503).json(current.payload); return; }
    if (current.payload?.requestedBy !== owner) { res.status(403).json({error: "Run ownership does not match."}); return; }
    const result = await serviceJson(ravenBaseUrl, `${base}/recheck-metadata`, {method: "POST", body: {approvalId: req.body?.approvalId, requestId: req.body?.requestId}});
    res.status(result.status || 503).json(result.payload);
  }));
};
