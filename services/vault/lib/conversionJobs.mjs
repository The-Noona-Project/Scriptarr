import {createHash, randomUUID, timingSafeEqual} from "node:crypto";

export const CONVERSION_LEASE_MS = 120000;
const LEASE_RENEW_SECONDS = 20;
const ACTIVE = new Set(["running", "result-ready", "publishing"]);
const PRIORITIES = {interactive: 0, bulk: 10, migration: 100};
const hash = value => createHash("sha256").update(value).digest("hex");
const copy = value => value == null ? value : structuredClone(value);
const text = value => typeof value === "string" ? value.trim() : "";
const fail = (status, code, message) => { throw Object.assign(new Error(message), {status, code}); };
const integer = (value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(400, "CONVERSION_INVALID", `Invalid ${name}.`);
  return value;
};
const identifier = (value, name) => {
  const result = text(value);
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(result)) fail(400, "CONVERSION_INVALID", `Invalid ${name}.`);
  return result;
};
const sha = (value, name) => {
  const result = text(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) fail(400, "CONVERSION_INVALID", `Invalid ${name}.`);
  return result;
};
const canonical = value => value == null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const secretHash = value => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) fail(400, "CONVERSION_INVALID", "A random lease token is required.");
  return hash(value);
};
const sameSecret = (left, right) => typeof left === "string" && typeof right === "string"
  && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const publicJob = job => job ? Object.fromEntries(Object.entries(copy(job)).filter(([key]) => !key.startsWith("_"))) : null;
const conflict = message => fail(409, "CONVERSION_FENCE_CONFLICT", message);
const ownerValue = value => {
  const owner = copy(value || {});
  if (!owner || typeof owner !== "object" || Array.isArray(owner) || Buffer.byteLength(JSON.stringify(owner)) > 65536) fail(400, "CONVERSION_INVALID", "Invalid conversion owner.");
  return owner;
};
const priorityValue = value => {
  if (typeof value !== "string" || !Object.hasOwn(PRIORITIES, value)) fail(400, "CONVERSION_INVALID", "Invalid conversion priority.");
  return value;
};

/** Normalize immutable chapter conversion inputs and derive its content identity. */
export const normalizeConversionSpec = body => {
  const input = body?.input || body?.spec?.input || {};
  const supplied = body?.profile || body?.spec?.profile || {};
  const profile = {
    format: "webp", quality: 85, method: 4, threads: 2, pageConcurrency: 1,
    maxDimension: 16383, segmentationVersion: 1,
    ...supplied
  };
  const expectedKeys = ["format", "quality", "method", "threads", "pageConcurrency", "maxDimension", "segmentationVersion"];
  if (Object.keys(profile).some(key => !expectedKeys.includes(key)) || profile.format !== "webp"
    || profile.quality !== 85 || profile.method !== 4 || profile.threads !== 2 || profile.pageConcurrency !== 1
    || profile.maxDimension !== 16383 || ![1, 2].includes(profile.segmentationVersion)) {
    fail(400, "CONVERSION_INVALID", "Unsupported conversion profile.");
  }
  const archiveName = text(input.archiveName);
  if (!archiveName || archiveName.length > 512 || /[\\/\0\r\n]/.test(archiveName) || !archiveName.toLowerCase().endsWith(".cbz")) fail(400, "CONVERSION_INVALID", "Invalid archive name.");
  const entries = input.entries;
  if (!Array.isArray(entries) || entries.length !== input.sourcePageCount || new Set(entries).size !== entries.length
    || entries.some(name => typeof name !== "string" || !name || name.length > 2048 || /[\\\0\r\n]/.test(name)
      || name.startsWith("/") || /^[a-z]:/i.test(name) || name.split("/").some(part => part === ".." || part === "."))) {
    fail(400, "CONVERSION_INVALID", "Ordered ZIP image entries are required.");
  }
  const normalizedInput = {
    titleId: identifier(input.titleId, "title id"), chapterId: identifier(input.chapterId, "chapter id"),
    sourceFingerprint: {sha256: sha(input.sourceFingerprint?.sha256, "source SHA256"), size: integer(input.sourceFingerprint?.size, "source size", 1, 20 * 1024 ** 3)},
    sourcePageCount: integer(input.sourcePageCount, "logical page count", 1, 100000), archiveName, entries: [...entries]
  };
  const profileHash = hash(canonical(profile));
  const jobId = `raven_webp_${hash(canonical({titleId: normalizedInput.titleId, chapterId: normalizedInput.chapterId, sourceSha256: normalizedInput.sourceFingerprint.sha256, profile}))}`;
  if (body.jobId && body.jobId !== jobId) fail(409, "CONVERSION_ID_CONFLICT", "The conversion id does not match its immutable inputs.");
  const owner = ownerValue(body.owner || body.spec?.owner);
  const priority = priorityValue(body.priority || owner.kind || "interactive");
  return {jobId, priority, profileHash, specHash: hash(canonical({input: normalizedInput, profile})), spec: {input: normalizedInput, profile, owner}};
};

const artifactValue = (value, job) => ({
  sha256: sha(value?.sha256, "artifact SHA256"), manifestSha256: sha(value?.manifestSha256, "manifest SHA256"),
  size: integer(value?.size, "artifact size", 1, 20 * 1024 ** 3),
  pageCount: integer(value?.pageCount, "artifact logical pages", job.spec.input.sourcePageCount, job.spec.input.sourcePageCount),
  ...(value?.segmentCount == null ? {} : {segmentCount: integer(value.segmentCount, "segment count", job.spec.input.sourcePageCount, 1000000)})
});

/** Create authoritative conversion state transitions over a transactional repository. */
export const createConversionJobs = ({repository, now = Date.now, publishChapter = null, repairChapter = null}) => {
  const time = tx => Number.isFinite(tx.now) ? tx.now : now();
  const requireJob = async (tx, id) => {
    const job = await tx.get(identifier(id, "job id"));
    if (!job) fail(404, "CONVERSION_NOT_FOUND", "Conversion job not found.");
    return job;
  };
  const assertUnfenced = async (tx, job) => {
    if (await tx.isTitleFenced?.(job.spec.input.titleId, job.spec.owner)) conflict("This content is under maintenance.");
  };
  const epoch = (job, body) => {
    if (integer(body.epoch, "lease epoch", 1) !== job.lease.epoch) conflict("This conversion epoch is no longer current.");
  };
  const workerProof = (job, body) => {
    epoch(job, body);
    if (identifier(body.workerId, "worker id") !== job.lease.workerId || !sameSecret(secretHash(body.leaseToken), job._leaseTokenHash)) conflict("This worker does not own the conversion lease.");
  };
  const liveWorker = (tx, job, body) => {
    workerProof(job, body);
    if (job.status !== "running" || Date.parse(job.lease.expiresAt) <= time(tx)) conflict("The conversion lease expired or is no longer encoding.");
  };
  const save = async (tx, job) => {
    job.updatedAt = new Date(time(tx)).toISOString();
    await tx.put(job);
    return publicJob(job);
  };
  const coordinatorFence = async (tx, job, body, statuses) => {
    epoch(job, body);
    await assertUnfenced(tx, job);
    if (!statuses.includes(job.status)) conflict("The conversion is not in the expected state.");
    if (body.artifactSha256 !== job.result?.artifact?.sha256) conflict("The artifact digest does not match the accepted result.");
  };
  const workerHeartbeat = async (tx, body, {existingOnly = false} = {}) => {
    const workerId = identifier(body.workerId, "worker id");
    const previous = await tx.getWorker?.(workerId);
    if (existingOnly && !previous) return;
    const capabilities = body.capabilities || previous?.capabilities || {};
    if (!existingOnly && (capabilities.format !== "webp" || capabilities.profileVersion !== 1 || typeof capabilities.selfTestPassed !== "boolean")) fail(400, "CONVERSION_INVALID", "A real WebP self-test result is required.");
    const worker = {workerId, instanceId: identifier(body.instanceId || previous?.instanceId || workerId, "worker instance id"),
      capabilities: {format: capabilities.format, profileVersion: capabilities.profileVersion, selfTestPassed: capabilities.selfTestPassed === true},
      lastSeenAt: new Date(time(tx)).toISOString(), ...(body.hostId || previous?.hostId ? {hostId: identifier(body.hostId || previous.hostId, "host id")} : {})};
    await tx.putWorker?.(worker);
    return worker;
  };
  return {
    async getConversionPool() {
      const snapshot = await repository.pool();
      const current = snapshot.now ?? now();
      return {capacity: 1, activeJobs: snapshot.jobs.filter(j => j.status === "running" && Date.parse(j.expiresAt) > current).length,
        queuedJobs: snapshot.jobs.filter(j => j.status === "queued" || (j.status === "running" && Date.parse(j.expiresAt) <= current)).length,
        resultReadyJobs: snapshot.jobs.filter(j => j.status === "result-ready").length, publishingJobs: snapshot.jobs.filter(j => j.status === "publishing").length,
        workers: snapshot.workers.map(w => ({workerId: w.workerId, instanceId: w.instanceId, ready: w.capabilities.selfTestPassed === true && Date.parse(w.lastSeenAt) + CONVERSION_LEASE_MS > current,
          lastSeenAt: w.lastSeenAt, format: w.capabilities.format, ...(w.hostId ? {hostId: w.hostId} : {})}))};
    },
    async heartbeatConversionWorker(body) { return repository.transaction(tx => workerHeartbeat(tx, body)); },
    async createConversionJob(body) {
      const normalized = normalizeConversionSpec(body);
      return repository.transaction(async tx => {
        const existing = await tx.get(normalized.jobId);
        if (existing) {
          if (existing.specHash !== normalized.specHash) fail(409, "CONVERSION_ID_CONFLICT", "This conversion id already has different inputs.");
          await assertUnfenced(tx, existing);
          if (existing.status === "queued" && PRIORITIES[normalized.priority] < PRIORITIES[existing.priority || "interactive"]) {
            existing.priority = normalized.priority;
            existing.spec.owner = normalized.spec.owner;
            existing.spec.coordinatorGeneration = randomUUID();
            return save(tx, existing);
          }
          return publicJob(existing);
        }
        const job = {...normalized, status: "queued", lease: {epoch: 0, workerId: null, expiresAt: null}, progress: {completedLogicalPages: 0, totalLogicalPages: normalized.spec.input.sourcePageCount}, result: {}, createdAt: new Date(time(tx)).toISOString()};
        job.spec.coordinatorGeneration = randomUUID();
        await assertUnfenced(tx, job);
        return save(tx, job);
      });
    },
    async getConversionJob(id) { return publicJob(await repository.get(identifier(id, "job id"))); },
    async listConversionJobs(filters = {}) { return (await repository.list(filters)).map(publicJob); },
    async claimConversionJob(body) {
      const workerId = identifier(body.workerId, "worker id"), claimId = identifier(body.claimId, "claim id"), tokenHash = secretHash(body.leaseToken);
      if (body.capabilities?.format !== "webp" || body.capabilities?.profileVersion !== 1 || body.capabilities?.selfTestPassed !== true) fail(400, "CONVERSION_INVALID", "A successful real WebP self-test is required before claiming.");
      return repository.transaction(async tx => {
        await workerHeartbeat(tx, body);
        const receipt = await tx.getClaim(workerId, claimId);
        if (receipt) {
          if (!sameSecret(receipt.tokenHash, tokenHash)) conflict("This claim id was already used with a different token.");
          const previous = await requireJob(tx, receipt.jobId);
          if (previous.lease.epoch !== receipt.epoch || previous.lease.workerId !== workerId || previous.status !== "running" || Date.parse(previous.lease.expiresAt) <= time(tx)) conflict("The previous claim is no longer active; use a new claim id.");
          return {job: publicJob(previous), lease: {...previous.lease, renewAfterSeconds: LEASE_RENEW_SECONDS}};
        }
        const jobs = await tx.list();
        if (jobs.some(job => job.status === "running" && Date.parse(job.lease.expiresAt) > time(tx))) return null;
        const candidates = jobs.filter(job => job.status === "queued" || (job.status === "running" && Date.parse(job.lease.expiresAt) <= time(tx)))
          .sort((a, b) => PRIORITIES[a.priority || "interactive"] - PRIORITIES[b.priority || "interactive"] || a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
        for (const job of candidates) {
          if (await tx.isTitleFenced?.(job.spec.input.titleId, job.spec.owner)) continue;
          job.status = "running";
          job.lease = {workerId, epoch: job.lease.epoch + 1, expiresAt: new Date(time(tx) + CONVERSION_LEASE_MS).toISOString()};
          job._leaseTokenHash = tokenHash;
          job.progress = {completedLogicalPages: 0, totalLogicalPages: job.spec.input.sourcePageCount, actualProgressAt: new Date(time(tx)).toISOString()};
          job.result = {};
          delete job.error;
          await save(tx, job);
          await tx.putClaim(workerId, claimId, {jobId: job.jobId, epoch: job.lease.epoch, tokenHash});
          return {job: publicJob(job), lease: {...job.lease, renewAfterSeconds: LEASE_RENEW_SECONDS}};
        }
        return null;
      });
    },
    async authorizeConversionLease(id, body, {artifactReplay = false} = {}) {
      return repository.transaction(async tx => {
        const job = await requireJob(tx, id);
        await assertUnfenced(tx, job);
        if (artifactReplay && ["result-ready", "publishing", "completed"].includes(job.status)) {
          workerProof(job, body);
          if (body.artifactSha256 !== job.result?.artifact?.sha256) conflict("A completed upload may only replay the same artifact.");
        } else liveWorker(tx, job, body);
        return publicJob(job);
      });
    },
    async renewConversionJob(id, body, {coordinator = false} = {}) {
      return repository.transaction(async tx => {
        const job = await requireJob(tx, id);
        await assertUnfenced(tx, job);
        if (coordinator) { epoch(job, body); if (!ACTIVE.has(job.status)) conflict("This conversion is not active."); }
        else liveWorker(tx, job, body);
        if (!coordinator) await workerHeartbeat(tx, body, {existingOnly: true});
        const progress = body.progress || body;
        const previousLogical = job.progress.completedLogicalPages || 0, previousSegments = job.progress.completedSegments || 0;
        if (progress.totalLogicalPages != null && progress.totalLogicalPages !== job.spec.input.sourcePageCount) fail(400, "CONVERSION_INVALID", "Logical page totals cannot change.");
        if (progress.completedLogicalPages != null) job.progress.completedLogicalPages = Math.max(job.progress.completedLogicalPages, integer(progress.completedLogicalPages, "completed logical pages", 0, job.spec.input.sourcePageCount));
        for (const field of ["completedSegments", "totalSegments", "currentLogicalPage"]) if (progress[field] != null) job.progress[field] = Math.max(job.progress[field] || 0, integer(progress[field], field, 0, field === "currentLogicalPage" ? job.spec.input.sourcePageCount : 1000000));
        if (job.progress.totalSegments != null && (job.progress.completedSegments || 0) > job.progress.totalSegments) fail(400, "CONVERSION_INVALID", "Completed segments exceed the reported total.");
        if (job.progress.completedLogicalPages > previousLogical || (job.progress.completedSegments || 0) > previousSegments) job.progress.actualProgressAt = new Date(time(tx)).toISOString();
        job.lease.expiresAt = new Date(time(tx) + CONVERSION_LEASE_MS).toISOString();
        return save(tx, job);
      });
    },
    async submitConversionJob(id, body) {
      return repository.transaction(async tx => {
        const job = await requireJob(tx, id);
        workerProof(job, body);
        await assertUnfenced(tx, job);
        const artifact = artifactValue(body.artifact, job);
        if (["result-ready", "publishing", "completed"].includes(job.status)) {
          if (canonical(artifact) !== canonical(job.result.artifact)) conflict("This epoch already accepted a different artifact.");
          return publicJob(job);
        }
        liveWorker(tx, job, body);
        job.status = "result-ready";
        job.result = {artifact, submittedAt: new Date(time(tx)).toISOString()};
        job.progress.completedLogicalPages = job.spec.input.sourcePageCount;
        if (artifact.segmentCount != null) {
          job.progress.completedSegments = artifact.segmentCount;
          job.progress.totalSegments = artifact.segmentCount;
        }
        job.progress.actualProgressAt = job.result.submittedAt;
        return save(tx, job);
      });
    },
    async publishConversionJob(id, body) {
      return repository.transaction(async tx => {
        const job = await requireJob(tx, id);
        await coordinatorFence(tx, job, body, ["result-ready", "publishing", "completed"]);
        if (job.status === "completed") return publicJob(job);
        job.status = "publishing";
        return save(tx, job);
      });
    },
    async completeConversionJob(id, body) {
      return repository.transaction(async tx => {
        const job = await requireJob(tx, id);
        await coordinatorFence(tx, job, body, ["publishing", "completed"]);
        if (!body.chapter || typeof body.chapter !== "object") fail(400, "CONVERSION_INVALID", "A fenced chapter checkpoint is required.");
        if (body.repair != null) {
          if (job.status !== "completed" || body.expectedCoordinatorGeneration !== job.spec.coordinatorGeneration) conflict("This completed coordinator execution no longer owns the repair.");
          const requestId = identifier(body.repair.requestId, "repair request id");
          sha(body.repair.expectedCurrentChapterFingerprint, "current chapter fingerprint");
          if (!repairChapter) fail(503, "CONVERSION_PUBLISH_UNAVAILABLE", "The catalogue repair publisher is unavailable.");
          const requestHash = hash(canonical(body));
          const previous = job._repairReceipts?.[requestId];
          if (previous && previous.requestHash !== requestHash) conflict("This repair request id already accepted different content.");
          const chapter = await repairChapter(tx, job, body, {replay: Boolean(previous)});
          if (previous) return copy(previous.response);
          const response = {job: publicJob(job), chapter, repair: {requestId, repairedAt: chapter.updatedAt}};
          job._repairReceipts ||= {};
          job._repairReceipts[requestId] = {requestHash, response: copy(response)};
          // A repair receipt must not rewrite the original public completion checkpoint or timestamps.
          await tx.put(job);
          return response;
        }
        const completionHash = hash(canonical(body.chapter));
        if (job.status === "completed") {
          if (job._completionHash !== completionHash) conflict("This conversion already completed with another chapter checkpoint.");
          return {job: publicJob(job), chapter: copy(job.result.chapter)};
        }
        if (!publishChapter) fail(503, "CONVERSION_PUBLISH_UNAVAILABLE", "The catalogue publisher is unavailable.");
        const chapter = await publishChapter(tx, job, body.chapter);
        job.status = "completed";
        job.finishedAt = new Date(time(tx)).toISOString();
        job._completionHash = completionHash;
        job.result.chapter = copy(chapter);
        return {job: await save(tx, job), chapter};
      });
    },
    async failConversionJob(id, body) {
      return repository.transaction(async tx => {
        const job = await requireJob(tx, id);
        workerProof(job, body);
        await assertUnfenced(tx, job);
        const error = {code: identifier(body.error?.code || "ENCODE_FAILED", "error code"), message: text(body.error?.message).slice(0, 1000) || "Worker conversion failed."};
        if (job.status === "failed" && canonical(job.error) === canonical(error)) return publicJob(job);
        liveWorker(tx, job, body);
        job.status = "failed"; job.error = error; job.finishedAt = new Date(time(tx)).toISOString();
        return save(tx, job);
      });
    },
    async cancelConversionJob(id, body = {}) {
      return repository.transaction(async tx => {
        const job = await requireJob(tx, id);
        if (Object.hasOwn(body, "expectedCoordinatorGeneration")) {
          if (typeof body.expectedCoordinatorGeneration !== "string" || !body.expectedCoordinatorGeneration || body.expectedCoordinatorGeneration.length > 160) fail(400, "CONVERSION_INVALID", "A captured coordinator generation is required.");
          if (body.expectedCoordinatorGeneration !== job.spec.coordinatorGeneration) conflict("This coordinator execution no longer owns the conversion.");
        }
        if (["cancelled", "completed"].includes(job.status)) return publicJob(job);
        if (body.expectedEpoch != null && body.expectedEpoch !== job.lease.epoch) conflict("This cancellation epoch is no longer current.");
        job.status = "cancelled"; job.lease.epoch += 1; job.lease.expiresAt = null;
        job.finishedAt = new Date(time(tx)).toISOString();
        return save(tx, job);
      });
    },
    async retryConversionJob(id, body) {
      const requestId = identifier(body.requestId, "retry request id");
      return repository.transaction(async tx => {
        const job = await requireJob(tx, id);
        if (job._retryReceipts?.[requestId]) return copy(job._retryReceipts[requestId]);
        if (body.expectedEpoch !== job.lease.epoch || !["failed", "cancelled"].includes(job.status)) conflict("This conversion cannot be retried in its current state.");
        await assertUnfenced(tx, job);
        const owner = body.owner == null ? null : ownerValue(body.owner);
        const priority = priorityValue(body.priority || owner?.kind || job.priority || "interactive");
        job.status = "queued"; job.lease = {epoch: job.lease.epoch + 1, workerId: null, expiresAt: null};
        job.progress = {completedLogicalPages: 0, totalLogicalPages: job.spec.input.sourcePageCount}; job.result = {};
        delete job.error; delete job.finishedAt; delete job._leaseTokenHash; delete job._completionHash;
        if (PRIORITIES[priority] <= PRIORITIES[job.priority || "interactive"]) {
          job.priority = priority;
          if (owner) job.spec.owner = owner;
        }
        job.spec.coordinatorGeneration = randomUUID();
        job._retryReceipts ||= {};
        job.updatedAt = new Date(time(tx)).toISOString();
        const result = publicJob(job);
        job._retryReceipts[requestId] = result;
        await save(tx, job);
        return result;
      });
    }
  };
};

/** In-memory transactional repository used by development and deterministic tests. */
export const createMemoryConversionRepository = ({now = Date.now, records = new Map(), claims = new Map(), fences = new Map(), workers = new Map()} = {}) => {
  let tail = Promise.resolve();
  return {
    records, claims, fences, workers,
    async init() {},
    async get(id) { return copy(records.get(id) || null); },
    async list(filters = {}) { return Array.from(records.values()).filter(j => (!filters.titleId || j.spec.input.titleId === filters.titleId) && (!filters.status || j.status === filters.status)).map(copy); },
    async pool() { return {now: now(), jobs: Array.from(records.values()).filter(j => ACTIVE.has(j.status) || j.status === "queued").map(j => ({status: j.status, expiresAt: j.lease.expiresAt})), workers: Array.from(workers.values()).map(copy)}; },
    async transaction(action) {
      const work = tail.catch(() => {}).then(async () => {
        const working = new Map(Array.from(records, ([id, value]) => [id, copy(value)]));
        const claimWorking = new Map(Array.from(claims, ([id, value]) => [id, copy(value)]));
        const fenceWorking = new Map(Array.from(fences, ([id, value]) => [id, copy(value)]));
        const workerWorking = new Map(Array.from(workers, ([id, value]) => [id, copy(value)]));
        const commits = [];
        const result = await action({now: now(), raw: null, afterCommit: fn => commits.push(fn), get: async id => copy(working.get(id) || null), put: async job => working.set(job.jobId, copy(job)), list: async () => Array.from(working.values()).map(copy), getClaim: async (worker, id) => copy(claimWorking.get(`${worker}:${id}`) || null), putClaim: async (worker, id, value) => claimWorking.set(`${worker}:${id}`, copy(value)),
          getWorker: async id => copy(workerWorking.get(id) || null), putWorker: async w => workerWorking.set(w.workerId, copy(w)),
          getReset: async id => copy(fenceWorking.get(id) || null), putReset: async reset => fenceWorking.set(reset.operationId, copy(reset)),
          jobsForTitles: async ids => Array.from(working.values()).filter(j => ids.includes(j.spec.input.titleId)).map(copy),
          isTitleFenced: async (titleId, owner = {}) => Array.from(fenceWorking.values()).some(f => ["maintenance", "catalog-cleared"].includes(f.status) && ((f.fencedTitleIds || f.titleIds).includes(titleId) || (owner.logicalKey && f.logicalKeys.includes(owner.logicalKey))))});
        for (const commit of commits) commit();
        records.clear(); for (const [id, value] of working) records.set(id, value);
        claims.clear(); for (const [id, value] of claimWorking) claims.set(id, value);
        fences.clear(); for (const [id, value] of fenceWorking) fences.set(id, value);
        workers.clear(); for (const [id, value] of workerWorking) workers.set(id, value);
        return copy(result);
      });
      tail = work;
      return work;
    }
  };
};
