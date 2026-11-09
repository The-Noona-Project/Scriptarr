import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {createConversionJobs, createMemoryConversionRepository, normalizeConversionSpec} from "../lib/conversionJobs.mjs";
import {createStore} from "../lib/createStore.mjs";

const spec = (chapterId = "chapter-1") => ({input: {titleId: "title-1", chapterId, sourceFingerprint: {sha256: "a".repeat(64), size: 123}, sourcePageCount: 2, archiveName: "chapter.cbz", entries: ["001.png", "002.png"]}});
const claim = (workerId = "worker-1", claimId = "claim-1") => ({workerId, instanceId: `${workerId}-instance`, claimId, leaseToken: `${workerId.replace(/-/g, "_")}_` + "T".repeat(40), capabilities: {format: "webp", profileVersion: 1, selfTestPassed: true}});
const artifact = {sha256: "b".repeat(64), manifestSha256: "c".repeat(64), size: 456, pageCount: 2, segmentCount: 3};
const readyChapter = {id: "chapter-1", label: "Chapter 1", chapterNumber: "1", pageCount: 2, sourcePageCount: 2, expectedPageCount: 2,
  available: true, ingestStatus: "ready", ingestRevision: "webp-0123456789abcdef", ingestedPageCount: 2, expectedSegmentCount: 3,
  ingestedSegmentCount: 3, segmentsReady: true, ingestManifestPath: "/downloads/ingested/manhua/title-1/chapter-1/webp-0123456789abcdef/manifest.json", ingestedAt: "2026-11-08T00:00:00.000Z"};
const fixture = () => {
  let clock = Date.parse("2026-11-08T00:00:00Z");
  const repository = createMemoryConversionRepository({now: () => clock});
  return {repository, store: createConversionJobs({repository, now: () => clock, publishChapter: async (_tx, _job, chapter) => chapter}), advance: ms => { clock += ms; }};
};
const fenced = error => error.status === 409 && error.code === "CONVERSION_FENCE_CONFLICT";
const orderedSpec = (entries = ["001.png", "002.png"]) => ({
  ...spec(), profile: {segmentationVersion: 2},
  input: {...spec().input, entries, contentIdentityVersion: 2,
    orderedEntriesSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex")}
});

test("versioned ordered-page identity matches the shared Java golden and preserves legacy hashes", () => {
  const legacyRequest = {input: {...spec().input, titleId: "title", chapterId: "chapter", entries: ["001_p2.png", "002_p1.png"]}, profile: {segmentationVersion: 2}};
  const legacy = normalizeConversionSpec(legacyRequest);
  assert.equal(legacy.jobId, "raven_webp_034f6974ed73996b8425563ae9fc1d4936bc750d91a2958bb2dcf8de9911871b");
  assert.equal(legacy.specHash, "b2797a9663e8681cf3db8d7a7369bbb46d47b4e96c0409981147dd6309172c5e");
  assert.equal(legacy.profileHash, "89d58e7c4a81b0a0469a9c7eb5acd32a2d47fe8c35fcc12385d3062e64121fd3");
  assert.equal(Object.hasOwn(legacy.spec.input, "contentIdentityVersion"), false);
  assert.equal(Object.hasOwn(legacy.spec.input, "orderedEntriesSha256"), false);
  const versioned = normalizeConversionSpec({...legacyRequest, input: {...legacyRequest.input, contentIdentityVersion: 2,
    orderedEntriesSha256: "4b0f5a02f1e1896d7aad8df2b60988ef8a9d4878ed642ffffa6ed26abefe68d6"}});
  assert.equal(versioned.jobId, "raven_webp_e34a056fd6c2b79a6dfc21d949c6362f3efb911742eb9ff438272af98ca8db30");
  assert.equal(versioned.spec.input.contentIdentityVersion, 2);
  assert.equal(versioned.spec.input.orderedEntriesSha256, "4b0f5a02f1e1896d7aad8df2b60988ef8a9d4878ed642ffffa6ed26abefe68d6");
  assert.notEqual(versioned.specHash, legacy.specHash);
  assert.equal(versioned.profileHash, legacy.profileHash, "Page ordering must not change the encoder profile.");
});

test("same ordered-page requests replay while reordering the same archive creates a distinct durable job", async () => {
  const {store} = fixture(), request = orderedSpec();
  const legacy = await store.createConversionJob({...spec(), profile: request.profile});
  const first = await store.createConversionJob(request);
  assert.deepEqual(await store.createConversionJob({jobId: first.jobId, spec: {input: request.input, profile: request.profile}}), first);
  const reordered = orderedSpec([...request.input.entries].reverse());
  const next = await store.createConversionJob(reordered);
  assert.notEqual(next.jobId, first.jobId); assert.notEqual(next.specHash, first.specHash);
  assert.notEqual(first.jobId, legacy.jobId);
  assert.deepEqual(await store.getConversionJob(legacy.jobId), legacy, "New ordering identities must not rewrite legacy jobs.");
  assert.deepEqual(await store.getConversionJob(first.jobId), first);
  await assert.rejects(store.createConversionJob({...reordered, jobId: first.jobId}), error => error.status === 409 && error.code === "CONVERSION_ID_CONFLICT");
});

test("ordered-page digest uses compact JSON rather than an ambiguous delimiter join", () => {
  const left = ["a.png,b.png", "c.png"], right = ["a.png", "b.png,c.png"];
  assert.equal(left.join(","), right.join(","));
  assert.notEqual(normalizeConversionSpec(orderedSpec(left)).jobId, normalizeConversionSpec(orderedSpec(right)).jobId);
  const unicode = orderedSpec(['pages/雪".png', "pages/002.png"]);
  assert.equal(normalizeConversionSpec(unicode).spec.input.orderedEntriesSha256,
    createHash("sha256").update('["pages/雪\\\".png","pages/002.png"]').digest("hex"));
});

test("ordered-page identity rejects partial fields, unknown versions, and mismatched digests", () => {
  const request = orderedSpec(), invalid = error => error.status === 400 && error.code === "CONVERSION_INVALID";
  for (const input of [
    {...spec().input, contentIdentityVersion: 2}, {...spec().input, orderedEntriesSha256: request.input.orderedEntriesSha256},
    Object.assign(Object.create({contentIdentityVersion: 2}), {...spec().input, orderedEntriesSha256: request.input.orderedEntriesSha256}),
    Object.assign(Object.create({orderedEntriesSha256: request.input.orderedEntriesSha256}), {...spec().input, contentIdentityVersion: 2}),
    ...[1, 3, "2", null, undefined].map(contentIdentityVersion => ({...request.input, contentIdentityVersion})),
    ...[null, undefined, "not-a-digest", "a".repeat(64)].map(orderedEntriesSha256 => ({...request.input, orderedEntriesSha256})),
    {...request.input, entries: [...request.input.entries].reverse()}
  ]) assert.throws(() => normalizeConversionSpec({...request, input}), invalid);
});

test("cached memory store retains ordered identities and independent reordered jobs", async () => {
  const store = createStore({driver: "memory"}); await store.init();
  try {
    const request = orderedSpec(), first = await store.createConversionJob(request);
    assert.deepEqual((await store.getConversionJob(first.jobId)).spec.input, first.spec.input);
    assert.deepEqual(await store.createConversionJob(request), first);
    const next = await store.createConversionJob(orderedSpec([...request.input.entries].reverse()));
    assert.notEqual(next.jobId, first.jobId);
    assert.deepEqual((await store.getConversionJob(first.jobId)).spec.input.entries, request.input.entries);
    assert.deepEqual((await store.getConversionJob(next.jobId)).spec.input.entries, [...request.input.entries].reverse());
  } finally { await store.close?.(); }
});

test("conversion identity is deterministic, immutable, and ZIP-relative", async () => {
  const {store} = fixture();
  const first = await store.createConversionJob({...spec(), owner: {bulkRunId: "run-one"}});
  const replay = await store.createConversionJob({spec: {...spec(), owner: {bulkRunId: "another-run"}}});
  assert.equal(replay.jobId, first.jobId);
  assert.match(first.jobId, /^raven_webp_[a-f0-9]{64}$/);
  assert.equal(normalizeConversionSpec(spec()).jobId, first.jobId);
  await assert.rejects(store.createConversionJob({...spec(), input: {...spec().input, entries: ["../001.png", "002.png"]}}), /ZIP image/);
  await assert.rejects(store.createConversionJob({...spec(), input: {...spec().input, sourcePageCount: 3, entries: ["001.png", "002.png", "003.png"]}}), error => error.status === 409);
  assert.equal(JSON.stringify(first).includes("leaseToken"), false);
});

test("concurrent claims across workers grant one global encoding lease and replay the same claim", async () => {
  const {store} = fixture();
  await store.createConversionJob(spec()); await store.createConversionJob(spec("chapter-2"));
  const replies = await Promise.all(Array.from({length: 12}, (_, i) => store.claimConversionJob(claim(`worker-${i}`))));
  assert.equal(replies.filter(Boolean).length, 1);
  const lease = replies.find(Boolean), request = claim(lease.lease.workerId);
  assert.deepEqual(await store.claimConversionJob(request), lease);
  await assert.rejects(store.claimConversionJob({...request, leaseToken: "X".repeat(40)}), fenced);
  assert.equal((await store.getConversionPool()).activeJobs, 1);
});

test("fresh work precedes migration and promotes the same queued content identity without changing an active owner", async () => {
  const {store, advance} = fixture();
  const migration = await store.createConversionJob({...spec(), priority: "migration", owner: {kind: "migration", runId: "migration-run"}});
  advance(1);
  const bulk = await store.createConversionJob({...spec("bulk"), priority: "bulk", owner: {kind: "bulk", runId: "bulk-run"}});
  advance(1);
  const interactive = await store.createConversionJob({...spec("manual"), priority: "interactive", owner: {kind: "interactive", requestedBy: "reader"}});
  const promoted = await store.createConversionJob({...spec(), priority: "bulk", owner: {kind: "bulk", runId: "joined-bulk-run", downloadTaskId: "owned-task"}});
  assert.equal(promoted.jobId, migration.jobId); assert.equal(promoted.specHash, migration.specHash);
  assert.equal(promoted.priority, "bulk"); assert.equal(promoted.spec.owner.downloadTaskId, "owned-task");
  assert.notEqual(promoted.spec.coordinatorGeneration, migration.spec.coordinatorGeneration);
  assert.equal((await store.createConversionJob({...spec(), priority: "bulk", owner: promoted.spec.owner})).spec.coordinatorGeneration, promoted.spec.coordinatorGeneration);
  await assert.rejects(store.cancelConversionJob(migration.jobId, {expectedEpoch: 0, expectedCoordinatorGeneration: migration.spec.coordinatorGeneration}), fenced);
  const first = await store.claimConversionJob(claim());
  assert.equal(first.job.jobId, interactive.jobId, "A newer user job must precede all background work.");
  await store.cancelConversionJob(first.job.jobId);
  const second = await store.claimConversionJob(claim("worker-2", "claim-2"));
  assert.equal(second.job.jobId, migration.jobId, "Equal priority remains stable by original queue order.");
  const replay = await store.createConversionJob({...spec(), priority: "interactive", owner: {kind: "interactive", requestedBy: "another-reader"}});
  assert.equal(replay.priority, "bulk"); assert.equal(replay.spec.owner.runId, "joined-bulk-run", "An active lease's attribution must remain immutable.");
  await store.cancelConversionJob(second.job.jobId);
  assert.equal((await store.claimConversionJob(claim("worker-3", "claim-3"))).job.jobId, bulk.jobId);
  await assert.rejects(store.createConversionJob({...spec("bad-priority"), priority: "unbounded"}), error => error.status === 400);
});

test("lease expiry fences former worker input, progress, submit, and late old claim retry", async () => {
  const {store, advance} = fixture(); const job = await store.createConversionJob(spec());
  const first = await store.claimConversionJob(claim());
  const old = {...claim(), epoch: first.lease.epoch};
  advance(120001);
  const second = await store.claimConversionJob(claim("worker-2", "claim-2"));
  assert.equal(second.job.jobId, job.jobId); assert.equal(second.lease.epoch, first.lease.epoch + 1);
  await assert.rejects(store.authorizeConversionLease(job.jobId, old), fenced);
  await assert.rejects(store.renewConversionJob(job.jobId, old), fenced);
  await assert.rejects(store.submitConversionJob(job.jobId, {...old, artifact}), fenced);
  await assert.rejects(store.claimConversionJob(claim()), fenced);
});

test("heartbeats renew server lease, keep logical progress monotone, and expire availability", async () => {
  const {store, advance} = fixture(); const job = await store.createConversionJob(spec()); const leased = await store.claimConversionJob(claim());
  const body = {...claim(), epoch: leased.lease.epoch};
  advance(20000);
  const renewed = await store.renewConversionJob(job.jobId, {...body, completedLogicalPages: 1, totalLogicalPages: 2});
  assert.equal(Date.parse(renewed.lease.expiresAt) - Date.parse(leased.lease.expiresAt), 20000);
  assert.equal((await store.renewConversionJob(job.jobId, {...body, completedLogicalPages: 0})).progress.completedLogicalPages, 1);
  await assert.rejects(store.renewConversionJob(job.jobId, {...body, totalLogicalPages: 3}), /totals cannot change/);
  assert.equal((await store.getConversionPool()).workers[0].ready, true);
  advance(120001); assert.equal((await store.getConversionPool()).workers[0].ready, false);
});

test("accepted artifact frees encoder slot, survives lease expiry, and publishes exactly once", async () => {
  const {store, advance} = fixture(); const job = await store.createConversionJob(spec()); advance(1); await store.createConversionJob(spec("chapter-2"));
  const leased = await store.claimConversionJob(claim()); const proof = {...claim(), epoch: leased.lease.epoch, artifact};
  const submitted = await store.submitConversionJob(job.jobId, proof);
  assert.equal(submitted.status, "result-ready");
  assert.equal(submitted.progress.completedSegments, 3); assert.equal(submitted.progress.completedLogicalPages, 2);
  assert.deepEqual(await store.submitConversionJob(job.jobId, proof), submitted);
  await assert.rejects(store.submitConversionJob(job.jobId, {...proof, artifact: {...artifact, sha256: "d".repeat(64)}}), fenced);
  advance(120001);
  const second = await store.claimConversionJob(claim("worker-2", "claim-2")); assert.equal(second.job.spec.input.chapterId, "chapter-2");
  const publication = {epoch: leased.lease.epoch, artifactSha256: artifact.sha256};
  assert.equal((await store.publishConversionJob(job.jobId, publication)).status, "publishing");
  const done = await store.completeConversionJob(job.jobId, {...publication, chapter: readyChapter});
  assert.equal(done.job.status, "completed");
  assert.deepEqual(await store.completeConversionJob(job.jobId, {...publication, chapter: readyChapter}), done);
  await assert.rejects(store.completeConversionJob(job.jobId, {...publication, chapter: {...readyChapter, label: "different"}}), fenced);
  assert.deepEqual(await store.submitConversionJob(job.jobId, proof), done.job);
});

test("cancellation and explicit retry fence stale completion and keep retry receipts durable", async () => {
  const {store} = fixture(); const job = await store.createConversionJob(spec()); const leased = await store.claimConversionJob(claim());
  const cancelled = await store.cancelConversionJob(job.jobId, {expectedEpoch: leased.lease.epoch});
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(await store.cancelConversionJob(job.jobId, {expectedEpoch: leased.lease.epoch}), cancelled);
  await assert.rejects(store.submitConversionJob(job.jobId, {...claim(), epoch: leased.lease.epoch, artifact}), fenced);
  const retried = await store.retryConversionJob(job.jobId, {expectedEpoch: cancelled.lease.epoch, requestId: "retry-one"});
  assert.deepEqual(await store.retryConversionJob(job.jobId, {expectedEpoch: cancelled.lease.epoch, requestId: "retry-one"}), retried);
  assert.equal(retried.status, "queued"); assert.equal(retried.lease.epoch, cancelled.lease.epoch + 1);
});

test("coordinator generation cancels a newly claimed same execution but fences every newer retry", async () => {
  const {store, advance} = fixture();
  const created = await store.createConversionJob({...spec(), coordinatorGeneration: "caller-must-not-choose", owner: {kind: "migration", runId: "migration"}});
  const generation = created.spec.coordinatorGeneration;
  assert.match(generation, /^[a-f0-9-]{36}$/); assert.notEqual(generation, "caller-must-not-choose");
  const lease = await store.claimConversionJob(claim());
  assert.equal(lease.job.spec.coordinatorGeneration, generation);
  advance(120001);
  const reassigned = await store.claimConversionJob(claim("worker-2", "claim-2"));
  assert.equal(reassigned.job.spec.coordinatorGeneration, generation, "Worker lease reassignment is not a new coordinator execution.");
  const cancelled = await store.cancelConversionJob(created.jobId, {expectedCoordinatorGeneration: generation});
  assert.equal(cancelled.status, "cancelled", "The originally queued owner can stop its claimed/reassigned worker without a stale epoch0 failure.");
  const retryBody = {expectedEpoch: cancelled.lease.epoch, requestId: "approved-retry", priority: "interactive", owner: {kind: "interactive", requestedBy: "same-user"}, coordinatorGeneration: generation};
  const retried = await store.retryConversionJob(created.jobId, retryBody);
  assert.notEqual(retried.spec.coordinatorGeneration, generation); assert.equal(retried.priority, "interactive");
  assert.equal(retried.spec.owner.requestedBy, "same-user");
  assert.deepEqual(await store.retryConversionJob(created.jobId, retryBody), retried);
  await assert.rejects(store.cancelConversionJob(created.jobId, {expectedCoordinatorGeneration: generation}), fenced);
  const running = await store.claimConversionJob(claim("worker-3", "claim-3"));
  assert.equal(running.job.spec.coordinatorGeneration, retried.spec.coordinatorGeneration);
  await assert.rejects(store.cancelConversionJob(created.jobId, {expectedCoordinatorGeneration: generation}), fenced);
  assert.equal((await store.getConversionJob(created.jobId)).status, "running");
  const stopped = await store.cancelConversionJob(created.jobId, {expectedCoordinatorGeneration: retried.spec.coordinatorGeneration});
  const lower = await store.retryConversionJob(created.jobId, {expectedEpoch: stopped.lease.epoch, requestId: "background-retry", priority: "migration", owner: {kind: "migration", runId: "lower"}});
  assert.equal(lower.priority, "interactive"); assert.equal(lower.spec.owner.requestedBy, "same-user", "Background work cannot demote foreground priority or attribution.");
  assert.notEqual(lower.spec.coordinatorGeneration, stopped.spec.coordinatorGeneration);
  await assert.rejects(store.cancelConversionJob(created.jobId, {expectedCoordinatorGeneration: ""}), error => error.status === 400);
});

test("cached memory store atomically checkpoints complete segments and invalidates catalogue projections", async () => {
  const store = createStore({driver: "memory"}); await store.init();
  await store.upsertRavenTitle({id: "title-1", title: "Scoped", mediaType: "manhua", chapterCount: 1});
  await store.replaceRavenChapters("title-1", [{id: "chapter-1", pageCount: 2, ingestStatus: "pending"}]);
  assert.equal((await store.getRavenTitle("title-1")).chapters[0].ingestStatus, "pending");
  const job = await store.createConversionJob(spec()); const lease = await store.claimConversionJob(claim());
  await store.submitConversionJob(job.jobId, {...claim(), epoch: lease.lease.epoch, artifact});
  await store.publishConversionJob(job.jobId, {epoch: lease.lease.epoch, artifactSha256: artifact.sha256});
  await assert.rejects(store.completeConversionJob(job.jobId, {epoch: lease.lease.epoch, artifactSha256: artifact.sha256, chapter: {...readyChapter, ingestedSegmentCount: 2}}), /complete conversion/);
  assert.equal((await store.getConversionJob(job.jobId)).status, "publishing");
  await store.completeConversionJob(job.jobId, {epoch: lease.lease.epoch, artifactSha256: artifact.sha256, chapter: readyChapter});
  const saved = (await store.getRavenTitle("title-1")).chapters[0];
  assert.equal(saved.pageCount, 2); assert.equal(saved.expectedSegmentCount, 3); assert.equal(saved.ingestStatus, "ready");
  const {sourcePageCount, expectedSegmentCount, ingestedSegmentCount, segmentsReady, ...metadata} = saved;
  await store.upsertRavenChapter("title-1", {...metadata, label: "Metadata edit"});
  const edited = (await store.getRavenTitle("title-1")).chapters[0];
  assert.equal(edited.expectedSegmentCount, 3); assert.equal(edited.segmentsReady, true);
});
