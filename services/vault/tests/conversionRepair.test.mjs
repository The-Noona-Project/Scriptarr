import test from "node:test";
import assert from "node:assert/strict";
import {createStore} from "../lib/createStore.mjs";
import {createCachedStore} from "../lib/createCachedStore.mjs";
import {createConversionJobs, createMemoryConversionRepository, normalizeConversionSpec} from "../lib/conversionJobs.mjs";
import {proveConversionRepair} from "./support/conversionRepairProof.mjs";

test("completed artifact repair preserves public snapshots, quality and original receipts through memory cache", async () => {
  const base = createStore({driver: "memory"}); await base.init();
  const result = await proveConversionRepair(createCachedStore(base), base);
  assert.equal(result.publicSnapshotCas, true); assert.equal(result.concurrentRepairs, 12);
});

test("segmentation profiles one and two keep separate immutable content identities and reject unknown profiles", () => {
  const input = {titleId: "title", chapterId: "chapter", sourceFingerprint: {sha256: "a".repeat(64), size: 1}, sourcePageCount: 1,
    archiveName: "chapter.cbz", entries: ["page.png"]};
  const legacy = normalizeConversionSpec({input}), next = normalizeConversionSpec({input, profile: {segmentationVersion: 2}});
  assert.equal(legacy.spec.profile.segmentationVersion, 1); assert.equal(next.spec.profile.segmentationVersion, 2);
  assert.notEqual(legacy.jobId, next.jobId); assert.notEqual(legacy.profileHash, next.profileHash);
  assert.throws(() => normalizeConversionSpec({input, profile: {segmentationVersion: 3}}), /Unsupported conversion profile/);
  assert.throws(() => normalizeConversionSpec({input, profile: {segmentationVersion: 2, maxPixels: 1}}), /Unsupported conversion profile/);
});

test("maintenance blocks completed repair and receipt replay before a publisher can observe or write catalog content", async () => {
  const repository = createMemoryConversionRepository();
  let repairs = 0;
  const store = createConversionJobs({repository, publishChapter: async (_tx, _job, chapter) => chapter,
    repairChapter: async (_tx, _job, body) => { repairs++; return {...body.chapter, updatedAt: "2026-11-08T00:00:01.000Z"}; }});
  const job = await store.createConversionJob({input: {titleId: "title", chapterId: "chapter", sourceFingerprint: {sha256: "a".repeat(64), size: 1},
    sourcePageCount: 1, archiveName: "chapter.cbz", entries: ["page.png"]}});
  const worker = {workerId: "worker", instanceId: "instance", claimId: "claim", leaseToken: "T".repeat(40), capabilities: {format: "webp", profileVersion: 1, selfTestPassed: true}};
  const lease = await store.claimConversionJob(worker), artifact = {sha256: "b".repeat(64), manifestSha256: "c".repeat(64), size: 1, pageCount: 1};
  await store.submitConversionJob(job.jobId, {...worker, epoch: lease.lease.epoch, artifact});
  const publication = {epoch: lease.lease.epoch, artifactSha256: artifact.sha256, chapter: {id: "chapter"}};
  await store.publishConversionJob(job.jobId, publication); await store.completeConversionJob(job.jobId, publication);
  const body = {...publication, expectedCoordinatorGeneration: job.spec.coordinatorGeneration, repair: {requestId: "repair", expectedCurrentChapterFingerprint: "d".repeat(64)}};
  await store.completeConversionJob(job.jobId, body); assert.equal(repairs, 1);
  repository.fences.set("maintenance", {status: "maintenance", titleIds: ["title"], logicalKeys: []});
  await assert.rejects(store.completeConversionJob(job.jobId, body), error => error.status === 409);
  await assert.rejects(store.completeConversionJob(job.jobId, {...body, repair: {...body.repair, requestId: "new-repair"}}), error => error.status === 409);
  assert.equal(repairs, 1);
});
