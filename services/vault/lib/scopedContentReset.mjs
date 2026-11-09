import {createHash} from "node:crypto";

const clone = value => structuredClone(value);
const canonical = value => value == null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const text = value => typeof value === "string" ? value.trim() : "";
const id = value => { const result = text(value); if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(result)) throw Object.assign(new Error("Invalid reset operation or run id."), {status: 400, code: "CONTENT_RESET_INVALID"}); return result; };
const reject = message => { throw Object.assign(new Error(message), {status: 409, code: "CONTENT_RESET_CONFLICT"}); };
const strings = value => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const unique = value => Array.from(new Set(value)).sort();

/** Resolve exactly the selected download plans, retaining their durable request snapshots. */
export const selectedResetPlans = (run, allPlans, body, ownedTaskIds = []) => {
  if (!run || run.kind !== "raven-bulk-downloadall" || run.ownerService !== "scriptarr-raven") reject("The selected bulk run does not exist.");
  const selected = allPlans.filter(p => p.payload?.kind === "bulk-title-plan" && text(p.payload.downloadTaskId || p.result?.downloadTaskId)
    && (["queued", "appended"].includes(p.result?.category) || ownedTaskIds.includes(text(p.payload.downloadTaskId || p.result?.downloadTaskId))));
  const requested = unique(strings(body.planIds));
  if (!requested.length || requested.length > 1000 || requested.length !== body.planIds?.length
    || canonical(requested) !== canonical(unique(selected.map(p => p.taskId)))) reject("The reset must include exactly the bulk run's selected download plans.");
  return selected.filter(p => requested.includes(p.taskId)).map(p => ({planId: p.taskId, downloadTaskId: text(p.payload.downloadTaskId || p.result.downloadTaskId),
    titleName: text(p.payload.titleName || p.payload.request?.titleName), requestType: text(p.payload.requestType || p.payload.type || p.payload.request?.requestType),
    titleUrl: text(p.payload.titleUrl || p.payload.request?.titleUrl), request: clone(p.payload.request || {})})).sort((a, b) => a.planId.localeCompare(b.planId));
};

/** Collect stable title references without assuming every cancelled task acquired a UUID. */
export const resetTitleReferences = (plans, tasks) => unique([
  ...tasks.map(t => t.titleId), ...tasks.map(t => t.details?.selectedDownload?.appendTitleId),
  ...plans.map(p => p.request?.selectedDownload?.appendTitleId), ...plans.map(p => p.request?.replacementTitleId)
].map(text).filter(Boolean));

/** Build an immutable selection digest while retaining full scoped filesystem evidence. */
export const buildScopedResetSnapshot = ({body, run, plans, tasks, titles, titleIds, logicalKeys, fencedTitleIds = titleIds}) => {
  const planIds = plans.map(p => p.planId);
  const taskIds = new Set(plans.map(p => p.downloadTaskId));
  if (tasks.some(t => !taskIds.has(t.taskId) || (t.details?.bulkRunId && t.details.bulkRunId !== run.jobId))) reject("A download task does not belong to this bulk run.");
  const stable = {version: 1, runId: run.jobId, planIds, titleIds: unique(titleIds), fencedTitleIds: unique(fencedTitleIds), logicalKeys: unique(logicalKeys),
    plans: plans.map(p => ({planId: p.planId, downloadTaskId: p.downloadTaskId, titleName: p.titleName, requestType: p.requestType, titleUrl: p.titleUrl, request: p.request})),
    titles: titles.map(t => ({id: t.id, workingRoot: t.workingRoot || "", downloadRoot: t.downloadRoot || "", archives: unique((t.chapters || []).map(c => c.archivePath).filter(Boolean))})).sort((a, b) => a.id.localeCompare(b.id)),
    tasks: tasks.map(t => ({taskId: t.taskId, titleId: t.titleId || "", downloadRoot: t.downloadRoot || "", workingRoot: t.workingRoot || "", details: Object.fromEntries(["downloadRoot", "workingRoot", "libraryTypeSlug"].filter(k => t.details?.[k] != null).map(k => [k, t.details[k]]))})).sort((a, b) => a.taskId.localeCompare(b.taskId))};
  return {operationId: id(body.operationId), runId: run.jobId, planIds, titleIds: stable.titleIds, fencedTitleIds: stable.fencedTitleIds, logicalKeys: stable.logicalKeys,
    scopeDigest: digest(stable), status: "planned", plans, tasks, titles, previewedAt: new Date().toISOString(), sourceRunStatus: run.status};
};

/** Add transactional scoped maintenance fences and content-only catalogue clearing. */
export const createScopedContentReset = ({repository, loadScope, clearContent}) => {
  const requireReset = async (tx, body) => {
    const reset = await tx.getReset(id(body.operationId));
    if (!reset || reset.scopeDigest !== body.scopeDigest) reject("The reset selection is missing or has changed.");
    return reset;
  };
  return {
    async previewScopedContentReset(body) {
      id(body.operationId);
      return repository.transaction(async tx => {
        const saved = await tx.getReset(body.operationId);
        if (saved) {
          if ((body.scopeDigest != null && body.scopeDigest !== saved.scopeDigest)
            || (body.runId != null && body.runId !== saved.runId)
            || (body.planIds != null && canonical(unique(strings(body.planIds))) !== canonical(saved.planIds))) reject("This operation id already refers to another reset selection.");
          return saved;
        }
        id(body.runId);
        const snapshot = await loadScope(tx, body);
        await tx.putReset(snapshot);
        return snapshot;
      });
    },
    async beginScopedContentReset(body) {
      return repository.transaction(async tx => {
        const reset = await requireReset(tx, body);
        if (["maintenance", "catalog-cleared", "finished"].includes(reset.status)) return reset;
        const current = await loadScope(tx, reset);
        if (current.scopeDigest !== reset.scopeDigest || current.sourceRunStatus !== "cancelled") reject("Cancel the original run and refresh the reset selection before maintenance.");
        reset.status = "maintenance"; reset.beganAt = new Date(tx.now).toISOString();
        for (const job of await tx.jobsForTitles(reset.fencedTitleIds || reset.titleIds)) {
          const previousStatus = job.status;
          job.status = "cancelled"; job.lease.epoch += 1; job.lease.expiresAt = null;
          job.result ||= {};
          job.result.contentReset = {operationId: reset.operationId, previousStatus, invalidatedAt: reset.beganAt};
          job.updatedAt = reset.beganAt;
          await tx.put(job);
        }
        await tx.putReset(reset);
        return reset;
      });
    },
    async applyScopedContentReset(body) {
      return repository.transaction(async tx => {
        const reset = await requireReset(tx, body);
        const proof = body.filesystemProof || body;
        const normalized = {operationId: proof.operationId, scopeDigest: proof.scopeDigest, quiescent: proof.quiescent,
          removedTitleIds: unique(strings(proof.removedTitleIds)), filesystemScopeDigest: text(proof.filesystemScopeDigest),
          removedPathCount: proof.removedPathCount, remainingScopedPathCount: proof.remainingScopedPathCount};
        if (normalized.operationId !== reset.operationId || normalized.scopeDigest !== reset.scopeDigest || normalized.quiescent !== true
          || canonical(normalized.removedTitleIds) !== canonical(reset.titleIds) || !/^[a-f0-9]{64}$/.test(normalized.filesystemScopeDigest)
          || !Number.isSafeInteger(normalized.removedPathCount) || normalized.removedPathCount < 0 || normalized.remainingScopedPathCount !== 0) reject("The exact quiescent filesystem removal proof is required.");
        const proofDigest = digest(normalized);
        if (["catalog-cleared", "finished"].includes(reset.status)) {
          if (reset.proofDigest !== proofDigest) reject("This reset already committed another filesystem proof.");
          return reset;
        }
        if (reset.status !== "maintenance") reject("Begin fenced maintenance before deleting content.");
        reset.result = await clearContent(tx, reset);
        reset.status = "catalog-cleared"; reset.proofDigest = proofDigest; reset.filesystemProof = normalized;
        reset.appliedAt = new Date(tx.now).toISOString();
        await tx.putReset(reset);
        return reset;
      });
    },
    async finishScopedContentReset(body) {
      return repository.transaction(async tx => {
        const reset = await requireReset(tx, body);
        if (reset.status === "finished") return reset;
        if (reset.status !== "catalog-cleared") reject("The content reset has not completed its guarded catalogue checkpoint.");
        reset.status = "finished"; reset.finishedAt = new Date(tx.now).toISOString();
        await tx.putReset(reset);
        return reset;
      });
    }
  };
};
