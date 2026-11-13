/** @file Root-authorized selected chapter repair, brokered through the existing download queue. */

/**
 * Register bounded repair intake and observational task projections.
 * @param {object} app Express-compatible router.
 * @param {object} dependencies Existing authorization, catalog, event and transport owners.
 * @param {Function} dependencies.read Library read authorization.
 * @param {Function} dependencies.root Library root authorization.
 * @param {Function} dependencies.loadTitle Canonical title loader.
 * @param {object} dependencies.vaultClient Brokered durable task reader.
 * @param {Function} dependencies.serviceJson Internal transport.
 * @param {string} dependencies.ravenBaseUrl Download coordinator URL.
 * @param {Function} dependencies.recordQueued Accepted action event writer.
 * @returns {void}
 */
export const registerChapterRepairRoutes = (app, {
  read, root, loadTitle, vaultClient, serviceJson, ravenBaseUrl, recordQueued
}) => {
  const path = "/api/moon-v3/admin/library/:titleId/repair-chapters";
  app.get(path, read(async (req, res) => {
    const title = await loadTitle(req.params.titleId);
    if (!title?.id) return res.status(404).json({error: "Title not found."});
    const tasks = (await vaultClient.listRavenDownloadTasks())
      .filter(task => task.titleId === title.id && task.details?.chapterRepair?.titleId === title.id)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, 10)
      .map(task => ({taskId: task.taskId, status: task.status, percent: task.percent, message: task.message,
        updatedAt: task.updatedAt, chapterNumbers: (task.details.chapterRepair.chapters || []).map(c => c.chapter_number),
        problems: (task.details.completionProblems || []).map(p => ({chapterNumber: p.chapterNumber, code: p.code,
          missingPageCount: p.missingPageCount, message: p.message})),
        progress: {stage: task.details.stage, completedChapters: task.details.ingestCompletedChapters,
          totalChapters: task.details.ingestTotalChapters}}));
    return res.json({titleId: title.id, tasks});
  }));
  app.post(path, root(async (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.chapterIds) || body.chapterIds.length < 1 || body.chapterIds.length > 50
      || body.chapterIds.some(id => typeof id !== "string" || [".", ".."].includes(id) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id))
      || typeof body.requestId !== "string" || !/^[A-Za-z0-9:._-]{1,200}$/.test(body.requestId)) {
      return res.status(400).json({error: "Select 1–50 chapter IDs and provide a stable requestId."});
    }
    if (new Set(body.chapterIds).size !== body.chapterIds.length) return res.status(400).json({error: "Chapter IDs must be unique."});
    const response = await serviceJson(ravenBaseUrl, `/v1/library/${encodeURIComponent(req.params.titleId)}/repair-chapters`, {
      method: "POST", body: {chapterIds: body.chapterIds, requestId: body.requestId, requestedBy: req.user.discordUserId}
    });
    if (!response.ok) return res.status(response.status || 502).json(response.payload || {error: "Chapter repair could not be queued."});
    if (!response.payload?.replayed) await recordQueued(req, response.payload);
    return res.status(202).json(response.payload);
  }));
};
