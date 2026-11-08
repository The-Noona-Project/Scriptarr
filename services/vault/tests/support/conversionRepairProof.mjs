import assert from "node:assert/strict";
import {createHash} from "node:crypto";

const canonical = value => value == null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const fingerprint = value => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)))).digest("hex");

/** Prove actual public-snapshot repair CAS, lost responses and independent broker concurrency. */
export const proveConversionRepair = async (store, peer = store, hooks = {}) => {
  const titleId = "completed-repair-title", chapterId = "completed-repair-chapter";
  await store.upsertRavenTitle({id: titleId, title: "Immutable repair", mediaType: "manhua", chapterCount: 1});
  const job = await store.createConversionJob({input: {titleId, chapterId, sourceFingerprint: {sha256: "a".repeat(64), size: 123},
    sourcePageCount: 1, archiveName: "chapter.cbz", entries: ["page.png"]}, profile: {segmentationVersion: 2}});
  const worker = {workerId: "repair-worker", instanceId: "repair-instance", claimId: "repair-claim", leaseToken: "R".repeat(40),
    capabilities: {format: "webp", profileVersion: 1, selfTestPassed: true}};
  const lease = await store.claimConversionJob(worker);
  assert.equal(lease.job.jobId, job.jobId);
  const artifact = {sha256: "b".repeat(64), manifestSha256: "c".repeat(64), size: 100, pageCount: 1, segmentCount: 2};
  await store.submitConversionJob(job.jobId, {...worker, epoch: lease.lease.epoch, artifact});
  const publication = {epoch: lease.lease.epoch, artifactSha256: artifact.sha256};
  await store.publishConversionJob(job.jobId, publication);
  const chapter = {id: chapterId, label: "Original label", chapterNumber: "1", pageCount: 1, sourcePageCount: 1, available: true,
    archivePath: "/downloads/downloaded/manhua/repair/chapter.cbz", sourceUrl: "https://example.invalid/repair/chapter-1", qualityStatus: "clean",
    expectedPageCount: 1, missingPageCount: 0, missingPages: [], qualityNotes: [], ingestStatus: "ready", ingestRevision: "webp-0123456789abcdef",
    ingestedPageCount: 1, ingestedAt: "2026-11-08T00:00:00.000Z", ingestError: "", expectedSegmentCount: 2, ingestedSegmentCount: 2,
    segmentsReady: true, ingestManifestPath: `/downloads/ingested/manhua/${titleId}/${chapterId}/webp-0123456789abcdef/manifest.json`};
  const original = await store.completeConversionJob(job.jobId, {...publication, chapter});
  const get = async () => {
    // Independent brokers intentionally have independent read caches; exercise a fresh public snapshot for each CAS.
    peer.clearCache?.();
    return (await peer.getRavenTitle(titleId)).chapters.find(row => row.id === chapterId);
  };
  const fail = async () => store.upsertRavenChapter(titleId, {...await get(), label: "Current edited label", qualityStatus: "partial",
    missingPageCount: 1, missingPages: [1], qualityNotes: ["Preserve current quality evidence"], ingestStatus: "failed", segmentsReady: false,
    ingestError: "Missing derived tile; retry from canonical CBZ."});
  const request = (current, requestId) => ({...publication, expectedCoordinatorGeneration: job.spec.coordinatorGeneration,
    chapter: {...current, ingestStatus: "ready", segmentsReady: true, ingestError: ""},
    repair: {requestId, expectedCurrentChapterFingerprint: fingerprint(current)}});
  await fail();
  const failed = await get(), body = request(failed, "repair-first");
  for (const change of [{epoch: publication.epoch + 1}, {artifactSha256: "d".repeat(64)}, {expectedCoordinatorGeneration: "older-owner"},
    {chapter: {...body.chapter, archivePath: "/downloads/downloaded/replaced.cbz"}}, {chapter: {...body.chapter, ingestRevision: "webp-fedcba9876543210"}},
    {chapter: {...body.chapter, sourcePageCount: 2}}, {chapter: {...body.chapter, expectedSegmentCount: 3, ingestedSegmentCount: 3}}]) {
    await assert.rejects(store.completeConversionJob(job.jobId, {...body, ...change}), error => error.status === 409);
  }
  if (hooks.rollback) await hooks.rollback({jobId: job.jobId, body, failed, get});
  const replies = await Promise.all(Array.from({length: 12}, (_, index) => (index % 2 ? store : peer).completeConversionJob(job.jobId, body)));
  for (const response of replies) assert.deepEqual(response, replies[0]);
  const repaired = await get();
  assert.deepEqual(replies[0].chapter, repaired, "Locked read and public GET must expose exactly the same normalized JSON shape.");
  assert.equal(repaired.ingestStatus, "ready"); assert.equal(repaired.segmentsReady, true);
  assert.equal(repaired.label, "Current edited label"); assert.equal(repaired.qualityStatus, "partial");
  assert.deepEqual(repaired.missingPages, [1]); assert.deepEqual(repaired.qualityNotes, ["Preserve current quality evidence"]);
  assert.ok(Date.parse(repaired.updatedAt) > Date.parse(failed.updatedAt));
  assert.equal(replies[0].repair.repairedAt, repaired.updatedAt);
  assert.deepEqual(await peer.getConversionJob(job.jobId), original.job, "Repair must preserve original public completion receipt and timestamps.");
  assert.deepEqual(await store.completeConversionJob(job.jobId, {...publication, chapter}), original, "Original completion replay must remain unchanged.");
  await assert.rejects(store.completeConversionJob(job.jobId, {...body, chapter: {...body.chapter, label: "Changed request"}}), error => error.status === 409);
  await assert.rejects(store.completeConversionJob(job.jobId, request(failed, "stale-new-request")), error => error.status === 409);
  // A second real failure in the same wall-clock second must receive a new public checkpoint and repair identity.
  await fail();
  const failedAgain = await get();
  assert.ok(Date.parse(failedAgain.updatedAt) > Date.parse(repaired.updatedAt));
  assert.notEqual(fingerprint(failedAgain), fingerprint(failed));
  await assert.rejects(store.completeConversionJob(job.jobId, body), error => error.status === 409, "An old repair receipt cannot hide a subsequent real failure.");
  const secondBody = request(failedAgain, "repair-second");
  const second = await store.completeConversionJob(job.jobId, secondBody);
  assert.ok(Date.parse(second.chapter.updatedAt) > Date.parse(failedAgain.updatedAt));
  assert.deepEqual(await peer.completeConversionJob(job.jobId, secondBody), second);
  await store.upsertRavenChapter(titleId, {...await get(), ingestRevision: "webp-fedcba9876543210", ingestManifestPath: "/downloads/ingested/new/manifest.json"});
  await assert.rejects(peer.completeConversionJob(job.jobId, secondBody), error => error.status === 409, "Saved repair replay cannot acknowledge a superseded content identity.");
  if (hooks.inspect) await hooks.inspect({jobId: job.jobId, original});
  return {concurrentRepairs: 12, publicSnapshotCas: true, metadataPreserved: true, repeatedFailureRepair: true, supersededReplayRejected: true};
};
