import {buildScopedResetSnapshot, resetTitleReferences, selectedResetPlans} from "./scopedContentReset.mjs";

const unique = values => Array.from(new Set(values.filter(Boolean))).sort();
const planNames = plan => unique([plan.titleName, plan.request?.titleName].filter(v => typeof v === "string"));
const keysFor = (plans, catalogKeyFor) => unique(plans.flatMap(p => planNames(p).map(title => catalogKeyFor({title, mediaType: p.requestType, libraryTypeSlug: p.request?.selectedDownload?.libraryTypeSlug || p.requestType}))));
const urlsFor = plans => unique(plans.flatMap(p => [p.titleUrl, p.request?.titleUrl, p.request?.selectedDownload?.titleUrl, p.request?.selectedDownload?.url]).filter(v => typeof v === "string"));
const matchesSource = (plans, title, catalogKeyFor) => plans.some(p => urlsFor([p]).includes(title.sourceUrl)
  && catalogKeyFor({title: "x", libraryTypeSlug: p.request?.selectedDownload?.libraryTypeSlug || p.requestType}).split(":")[0] === catalogKeyFor(title).split(":")[0]);
const assertUnambiguousSources = (plans, candidates, resolve, catalogKeyFor) => {
  for (const plan of plans) if (unique(candidates.filter(t => matchesSource([plan], t, catalogKeyFor)).map(t => resolve(t.id))).length > 1) {
    throw Object.assign(new Error("The selected source identifies multiple canonical titles; resolve its ownership before resetting content."), {status: 409, code: "CONTENT_RESET_CONFLICT"});
  }
};
const emptyTitle = title => ({...title, chapters: [], chapterCount: 0, chaptersDownloaded: 0, latestChapter: "", workingRoot: "", downloadRoot: "",
  ingestStatus: "pending", ingestedChapterCount: 0, ingestError: "", qualityStatus: "missing", cleanChapterCount: 0, partialChapterCount: 0, missingContentCount: 0, qualitySummary: "Content removed for a fresh download."});

/** Scoped memory-store catalogue adapter; user and operational history maps are untouched. */
export const createMemoryScopedResetAdapter = ({state, resolveTitleId, catalogKeyFor, normalizeTitle}) => ({
  async loadScope(_tx, body) {
    const run = state.jobs.get(body.runId);
    const allPlans = Array.from(state.jobTasks.values()).filter(p => p.jobId === body.runId);
    const plans = selectedResetPlans(run, allPlans, body, Array.from(state.ravenDownloadTasks.keys()));
    const taskIds = new Set(plans.map(p => p.downloadTaskId));
    const tasks = Array.from(state.ravenDownloadTasks.values()).filter(t => taskIds.has(t.taskId));
    const references = resetTitleReferences(plans, tasks).map(resolveTitleId);
    const keys = keysFor(plans, catalogKeyFor), urls = urlsFor(plans);
    const candidates = Array.from(state.ravenTitles.values()).filter(t => references.includes(resolveTitleId(t.id)) || (t.sourceUrl && urls.includes(t.sourceUrl) && matchesSource(plans, t, catalogKeyFor)));
    assertUnambiguousSources(plans, candidates, resolveTitleId, catalogKeyFor);
    const titleIds = unique([...references, ...candidates.map(t => resolveTitleId(t.id))]);
    const titles = titleIds.map(titleId => state.ravenTitles.get(titleId)).filter(Boolean).map(t => normalizeTitle(t, Array.from((state.ravenChapters.get(t.id) || new Map()).values())));
    const fencedTitleIds = unique([...titleIds, ...Array.from(state.ravenTitleAliases.keys()).filter(alias => titleIds.includes(resolveTitleId(alias)))]);
    return buildScopedResetSnapshot({body, run, plans, tasks, titles, titleIds, logicalKeys: keys, fencedTitleIds});
  },
  async clearContent(tx, reset) {
    let chaptersCleared = 0;
    for (const titleId of reset.titleIds) chaptersCleared += state.ravenChapters.get(titleId)?.size || 0;
    tx.afterCommit(() => {
      for (const titleId of reset.titleIds) {
        state.ravenChapters.delete(titleId);
        const title = state.ravenTitles.get(titleId);
        if (title) state.ravenTitles.set(titleId, {...emptyTitle(title), updatedAt: new Date(tx.now).toISOString()});
      }
    });
    return {titlesCleared: reset.titleIds.filter(id => state.ravenTitles.has(id)).length, chaptersCleared, preservedTitleIds: reset.titleIds, userStatePreserved: true, operationalHistoryPreserved: true};
  }
});

/** Scoped MySQL adapter uses the conversion transaction's connection and exact title IDs. */
export const createMysqlScopedResetAdapter = ({resolveTitleId, catalogKeyFor, toJob, toTask, toTitle, toChapter}) => ({
  async loadScope(tx, body) {
    const connection = tx.raw;
    const [runRows] = await connection.query("SELECT * FROM vault_jobs WHERE job_id = ?", [body.runId]);
    const run = runRows[0] ? toJob(runRows[0]) : null;
    const [planRows] = await connection.query("SELECT * FROM vault_job_tasks WHERE job_id = ?", [body.runId]);
    const allPlans = planRows.map(toTask);
    const potentialTaskIds = unique(allPlans.filter(p => p.payload?.kind === "bulk-title-plan").map(p => p.payload.downloadTaskId || p.result?.downloadTaskId));
    const [taskRows] = potentialTaskIds.length ? await connection.query(`SELECT * FROM raven_download_tasks WHERE task_id IN (${potentialTaskIds.map(() => "?").join(",")})`, potentialTaskIds) : [[]];
    const plans = selectedResetPlans(run, allPlans, body, taskRows.map(row => row.task_id));
    const selectedTaskIds = new Set(plans.map(p => p.downloadTaskId));
    const tasks = taskRows.filter(row => selectedTaskIds.has(row.task_id)).map(row => {
      const details = typeof row.details_json === "string" ? JSON.parse(row.details_json) : row.details_json || {};
      return {taskId: row.task_id, titleId: row.title_id, titleName: row.title_name, titleUrl: row.title_url, providerId: row.provider_id,
        requestId: row.request_id == null ? "" : String(row.request_id), requestType: row.request_type, requestedBy: row.requested_by,
        status: row.status_name, message: row.message_text, percent: row.percent_value, details, downloadRoot: details.downloadRoot || "", workingRoot: details.workingRoot || "",
        queuedAt: row.queued_at?.toISOString(), updatedAt: row.updated_at?.toISOString()};
    });
    const references = [];
    for (const reference of resetTitleReferences(plans, tasks)) references.push(await resolveTitleId(reference, connection));
    const keys = keysFor(plans, catalogKeyFor), urls = urlsFor(plans);
    const clauses = [], params = [];
    for (const [column, values] of [["title_id", references], ["source_url", urls]]) if (values.length) {
      clauses.push(`${column} IN (${values.map(() => "?").join(",")})`); params.push(...values);
    }
    const [candidateRows] = clauses.length ? await connection.query(`SELECT title_id,catalog_key,source_url,library_type_slug,title FROM raven_titles WHERE ${clauses.join(" OR ")}`, params) : [[]];
    const titleIds = [...references], candidates = [];
    for (const row of candidateRows) {
      const title = {id: row.title_id, title: row.title, sourceUrl: row.source_url, libraryTypeSlug: row.library_type_slug};
      if (references.includes(row.title_id) || matchesSource(plans, title, catalogKeyFor)) {
        const canonicalId = await resolveTitleId(row.title_id, connection);
        candidates.push({...title, id: canonicalId}); titleIds.push(canonicalId);
      }
    }
    assertUnambiguousSources(plans, candidates, titleId => titleId, catalogKeyFor);
    const resolvedIds = unique(titleIds);
    let titles = [];
    if (resolvedIds.length) {
      const placeholders = resolvedIds.map(() => "?").join(",");
      const [rows] = await connection.query(`SELECT * FROM raven_titles WHERE title_id IN (${placeholders})`, resolvedIds);
      const [chapters] = await connection.query(`SELECT * FROM raven_chapters WHERE title_id IN (${placeholders})`, resolvedIds);
      titles = rows.map(row => toTitle(row, chapters.filter(c => c.title_id === row.title_id).map(toChapter)));
    }
    const fencedTitleIds = [...resolvedIds];
    if (resolvedIds.length) {
      let previous = 0;
      for (let depth = 0; depth < 20 && previous !== fencedTitleIds.length; depth += 1) {
        previous = fencedTitleIds.length;
        const [aliases] = await connection.query(`SELECT alias_title_id FROM raven_title_aliases WHERE canonical_title_id IN (${fencedTitleIds.map(() => "?").join(",")})`, fencedTitleIds);
        for (const alias of aliases) if (!fencedTitleIds.includes(alias.alias_title_id)) fencedTitleIds.push(alias.alias_title_id);
      }
    }
    return buildScopedResetSnapshot({body, run, plans, tasks, titles, titleIds: resolvedIds, logicalKeys: keys, fencedTitleIds});
  },
  async clearContent(tx, reset) {
    if (!reset.titleIds.length) return {titlesCleared: 0, chaptersCleared: 0, preservedTitleIds: [], userStatePreserved: true, operationalHistoryPreserved: true};
    const placeholders = reset.titleIds.map(() => "?").join(",");
    const [removed] = await tx.raw.query(`DELETE FROM raven_chapters WHERE title_id IN (${placeholders})`, reset.titleIds);
    const [updated] = await tx.raw.query(`UPDATE raven_titles SET chapter_count=0,chapters_downloaded=0,latest_chapter='',working_root=NULL,download_root=NULL,
      ingest_status='pending',ingested_chapter_count=0,ingest_error=NULL,quality_status='missing',clean_chapter_count=0,partial_chapter_count=0,
      missing_content_count=0,quality_summary='Content removed for a fresh download.',updated_at=NOW() WHERE title_id IN (${placeholders})`, reset.titleIds);
    return {titlesCleared: updated.affectedRows, chaptersCleared: removed.affectedRows, preservedTitleIds: reset.titleIds, userStatePreserved: true, operationalHistoryPreserved: true};
  }
});
