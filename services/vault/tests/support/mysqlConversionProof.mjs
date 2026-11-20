import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import mysql from "mysql2/promise";
import {createStore} from "../../lib/createStore.mjs";
import {createCachedStore} from "../../lib/createCachedStore.mjs";
import {proveScopedReset} from "./scopedResetProof.mjs";
import {proveCanonicalTitleIdentity} from "./canonicalTitleIdentityProof.mjs";

try {
  const parsed = new URL(process.env.SCRIPTARR_TEST_MYSQL_URL), database = "vault_conversion_" + randomUUID().replaceAll("-", "");
  const admin = mysql.createPool(process.env.SCRIPTARR_TEST_MYSQL_URL);
  const config = {driver: "mysql", mysql: {host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database}};
  const first = createStore(config), second = createStore(config);
  let inspector;
  try {
    const [[server]] = await admin.query("SELECT VERSION() AS version, @@SESSION.sql_mode AS sqlMode");
    assert.match(server.version, /^8\.4\./); assert.match(server.sqlMode, /STRICT_(?:TRANS|ALL)_TABLES/);
    await admin.query("CREATE DATABASE ??", [database]);
    inspector = mysql.createPool(config.mysql);
    await first.init(); await second.init();
    for (let index = 0; index < 110; index++) await first.upsertDiscordUser({discordUserId: `hydration-${String(index).padStart(3, "0")}`, username: `Hydration ${String(index).padStart(3, "0")}`});
    const hydratedUsers = await second.listUsers();
    assert.equal(hydratedUsers.length, 110, "User hydration must not overflow the bounded pool queue.");
    assert.equal(hydratedUsers[0].username, "Hydration 000"); assert.equal(hydratedUsers[109].username, "Hydration 109");
    const request = chapterId => ({input: {titleId: "conversion-title", chapterId, sourceFingerprint: {sha256: "a".repeat(64), size: 123}, sourcePageCount: 1, archiveName: "chapter.cbz", entries: ["001.png"]}});
    const worker = i => ({workerId: `mysql-worker-${i}`, instanceId: `mysql-instance-${i}`, claimId: `mysql-claim-${i}`, leaseToken: String(i).padEnd(40, "T"), capabilities: {format: "webp", profileVersion: 1, selfTestPassed: true}});
    await first.upsertRavenTitle({id: "conversion-title", title: "Conversion fixture", mediaType: "manhua", libraryTypeSlug: "manhua", chapterCount: 2});
    const migration = await first.createConversionJob({...request("a"), priority: "migration", owner: {kind: "migration", runId: "background"}});
    await second.createConversionJob({...request("b"), priority: "bulk", owner: {kind: "bulk", runId: "bulk-work"}});
    const interactive = await first.createConversionJob({...request("manual"), priority: "interactive", owner: {kind: "interactive", requestedBy: "reader"}});
    const promoted = await second.createConversionJob({...request("a"), priority: "bulk", owner: {kind: "bulk", runId: "joined"}});
    assert.equal(promoted.jobId, migration.jobId); assert.equal(promoted.priority, "bulk"); assert.equal(promoted.spec.owner.runId, "joined");
    assert.notEqual(promoted.spec.coordinatorGeneration, migration.spec.coordinatorGeneration);
    await assert.rejects(first.cancelConversionJob(migration.jobId, {expectedCoordinatorGeneration: migration.spec.coordinatorGeneration}), error => error.status === 409);
    const replies = await Promise.all(Array.from({length: 12}, (_, i) => (i % 2 ? first : second).claimConversionJob(worker(i))));
    assert.equal(replies.filter(Boolean).length, 1, "Different store instances must share the global encoding lock.");
    const claimed = replies.find(Boolean), jobId = claimed.job.jobId, owned = worker(replies.findIndex(Boolean));
    assert.equal(jobId, interactive.jobId, "A fresh user chapter must precede all earlier migration/bulk chapters across independent brokers.");
    assert.deepEqual(await second.claimConversionJob(owned), claimed, "A lost claim response must recover from MySQL, not process memory.");
    await inspector.query("UPDATE raven_conversion_jobs SET record_json=JSON_SET(record_json,'$.lease.expiresAt','2000-01-01T00:00:00.000Z') WHERE job_id=?", [jobId]);
    const replacement = await second.claimConversionJob(worker(99));
    assert.equal(replacement.job.jobId, jobId); assert.equal(replacement.lease.epoch, claimed.lease.epoch + 1);
    assert.equal(replacement.job.spec.coordinatorGeneration, claimed.job.spec.coordinatorGeneration);
    await assert.rejects(first.renewConversionJob(jobId, {...owned, epoch: claimed.lease.epoch}), error => error.status === 409);
    const proof = {...worker(99), epoch: replacement.lease.epoch}, artifact = {sha256: "b".repeat(64), manifestSha256: "c".repeat(64), size: 100, pageCount: 1, segmentCount: 2};
    await first.submitConversionJob(jobId, {...proof, artifact});
    await second.publishConversionJob(jobId, {epoch: proof.epoch, artifactSha256: artifact.sha256});
    const chapter = {id: replacement.job.spec.input.chapterId, label: "Chapter 1", chapterNumber: "1", available: true, pageCount: 1, sourcePageCount: 1,
      ingestedPageCount: 1, expectedSegmentCount: 2, ingestedSegmentCount: 2, segmentsReady: true, ingestStatus: "ready", ingestRevision: "webp-0123456789abcdef",
      ingestManifestPath: `/downloads/ingested/manhua/conversion-title/${replacement.job.spec.input.chapterId}/webp-0123456789abcdef/manifest.json`};
    await assert.rejects(first.completeConversionJob(jobId, {epoch: proof.epoch, artifactSha256: artifact.sha256, chapter: {...chapter, ingestedSegmentCount: 1}}), error => error.status === 409);
    assert.equal((await second.getConversionJob(jobId)).status, "publishing");
    assert.equal((await first.getRavenTitle("conversion-title")).chapters.length, 0);
    // Fail after the chapter INSERT but before conversion state save: both must roll back.
    await inspector.query("CREATE TRIGGER conversion_fixture_reject BEFORE UPDATE ON raven_conversion_jobs FOR EACH ROW BEGIN IF NEW.status_name='completed' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated rollback proof'; END IF; END");
    await assert.rejects(first.completeConversionJob(jobId, {epoch: proof.epoch, artifactSha256: artifact.sha256, chapter}), /isolated rollback proof/);
    assert.equal((await second.getRavenTitle("conversion-title")).chapters.length, 0);
    assert.equal((await second.getConversionJob(jobId)).status, "publishing");
    await inspector.query("DROP TRIGGER conversion_fixture_reject");
    const completion = await first.completeConversionJob(jobId, {epoch: proof.epoch, artifactSha256: artifact.sha256, chapter});
    assert.equal(completion.job.status, "completed"); assert.equal(completion.chapter.pageCount, 1); assert.equal(completion.chapter.ingestedSegmentCount, 2);
    assert.deepEqual(await second.completeConversionJob(jobId, {epoch: proof.epoch, artifactSha256: artifact.sha256, chapter}), completion);
    const stored = await second.getRavenTitle("conversion-title");
    assert.equal(stored.chapters[0].segmentsReady, true); assert.equal(stored.chapters[0].expectedSegmentCount, 2);
    const {sourcePageCount, expectedSegmentCount, ingestedSegmentCount, segmentsReady, ...metadata} = stored.chapters[0];
    await second.upsertRavenChapter("conversion-title", {...metadata, label: "Metadata preserved"});
    assert.equal((await first.getRavenTitle("conversion-title")).chapters[0].expectedSegmentCount, 2);
    assert.equal((await first.getConversionPool()).activeJobs, 0);
    const cancellationJob = await first.createConversionJob({...request("generation-cancel-race"), priority: "interactive", owner: {kind: "interactive", requestedBy: "same-reader"}});
    const capturedGeneration = cancellationJob.spec.coordinatorGeneration;
    const acquired = await second.claimConversionJob(worker(120));
    assert.equal(acquired.job.jobId, cancellationJob.jobId);
    assert.equal(acquired.job.spec.coordinatorGeneration, capturedGeneration);
    const stopped = await first.cancelConversionJob(cancellationJob.jobId, {expectedCoordinatorGeneration: capturedGeneration});
    assert.equal(stopped.status, "cancelled", "The queued owner's captured generation must cancel a lease claimed by another broker.");
    const retryBody = {expectedEpoch: stopped.lease.epoch, requestId: "mysql-approved-retry", priority: "interactive", owner: {kind: "interactive", requestedBy: "same-reader"}};
    const retried = await second.retryConversionJob(cancellationJob.jobId, retryBody);
    assert.notEqual(retried.spec.coordinatorGeneration, capturedGeneration, "Same owner does not imply the same approved execution.");
    assert.deepEqual(await first.retryConversionJob(cancellationJob.jobId, retryBody), retried);
    await assert.rejects(first.cancelConversionJob(cancellationJob.jobId, {expectedCoordinatorGeneration: capturedGeneration}), error => error.status === 409);
    const newLease = await second.claimConversionJob(worker(121));
    assert.equal(newLease.job.jobId, cancellationJob.jobId);
    await assert.rejects(first.cancelConversionJob(cancellationJob.jobId, {expectedCoordinatorGeneration: capturedGeneration}), error => error.status === 409);
    assert.equal((await second.getConversionJob(cancellationJob.jobId)).status, "running");
    assert.equal((await first.cancelConversionJob(cancellationJob.jobId, {expectedEpoch: newLease.lease.epoch})).status, "cancelled", "The legacy explicit epoch guard remains supported.");
    const originalCompletion = await first.getConversionJob(jobId);
    const entries = ["001_p2.png", "002_p1.png"];
    const versionedRequest = {...request("ordered-pages"), profile: {segmentationVersion: 2}, input: {...request("ordered-pages").input,
      sourcePageCount: 2, entries, contentIdentityVersion: 2, orderedEntriesSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex")}};
    const versioned = await first.createConversionJob(versionedRequest);
    assert.deepEqual(await second.getConversionJob(versioned.jobId), versioned, "An independent broker must read the exact versioned ordering from MySQL.");
    assert.deepEqual(await second.createConversionJob(versionedRequest), versioned, "Lost-response replay must preserve the ordering identity and generation.");
    const reversed = [...entries].reverse();
    const reordered = await second.createConversionJob({...versionedRequest, input: {...versionedRequest.input, entries: reversed,
      orderedEntriesSha256: createHash("sha256").update(JSON.stringify(reversed)).digest("hex")}});
    assert.notEqual(reordered.jobId, versioned.jobId); assert.notEqual(reordered.specHash, versioned.specHash);
    assert.deepEqual((await first.getConversionJob(versioned.jobId)).spec.input.entries, entries);
    assert.deepEqual((await first.getConversionJob(reordered.jobId)).spec.input.entries, reversed);
    assert.deepEqual(await second.getConversionJob(jobId), originalCompletion, "Versioned ordering must not rewrite a legacy completed receipt.");
    await first.cancelConversionJob(versioned.jobId, {expectedCoordinatorGeneration: versioned.spec.coordinatorGeneration});
    await second.cancelConversionJob(reordered.jobId, {expectedCoordinatorGeneration: reordered.spec.coordinatorGeneration});
    const rebuildRequest = {expectedEpoch: originalCompletion.lease.epoch, expectedCoordinatorGeneration: originalCompletion.spec.coordinatorGeneration,
      expectedArtifactSha256: originalCompletion.result.artifact.sha256, rebuildPublished: true, requestId: "missing-output-rebuild"};
    await assert.rejects(first.retryConversionJob(jobId, {...rebuildRequest, expectedArtifactSha256: "f".repeat(64)}), error => error.status === 409);
    const rebuilds = await Promise.all([first.retryConversionJob(jobId, rebuildRequest), second.retryConversionJob(jobId, rebuildRequest)]);
    assert.deepEqual(rebuilds[0], rebuilds[1], "Concurrent rebuild approvals must allocate one durable execution.");
    assert.equal(rebuilds[0].lease.epoch, originalCompletion.lease.epoch + 1);
    const [[historyRow]] = await inspector.query("SELECT record_json FROM raven_conversion_jobs WHERE job_id=?", [jobId]);
    const history = typeof historyRow.record_json === "string" ? JSON.parse(historyRow.record_json) : historyRow.record_json;
    assert.deepEqual(history._publicationHistory[originalCompletion.lease.epoch].result, originalCompletion.result);
    await assert.rejects(first.completeConversionJob(jobId, {epoch: originalCompletion.lease.epoch, artifactSha256: artifact.sha256, chapter}), error => error.status === 409);
    const rebuiltLease = await first.claimConversionJob(worker(140));
    assert.equal(rebuiltLease.job.jobId, jobId);
    const rebuiltArtifact = {...artifact, sha256: "d".repeat(64)}, rebuiltFence = {epoch: rebuiltLease.lease.epoch, artifactSha256: rebuiltArtifact.sha256};
    await second.submitConversionJob(jobId, {...worker(140), epoch: rebuiltLease.lease.epoch, artifact: rebuiltArtifact});
    await first.publishConversionJob(jobId, rebuiltFence);
    const publication = {jobId, epoch: originalCompletion.lease.epoch, artifactSha256: artifact.sha256, manifestSha256: "e".repeat(64)};
    const rebuiltCompletion = await second.completeConversionJob(jobId, {...rebuiltFence, chapter, publication});
    assert.deepEqual(rebuiltCompletion.job.result.publication, publication);
    assert.deepEqual((await first.getConversionJob(jobId)).result.publication, publication, "The manifest's retained identity must survive a database round trip.");
    const anotherRebuild = await first.retryConversionJob(jobId, {requestId: "changed-metadata-rebuild", rebuildPublished: true,
      expectedEpoch: rebuiltCompletion.job.lease.epoch, expectedCoordinatorGeneration: rebuiltCompletion.job.spec.coordinatorGeneration, expectedArtifactSha256: rebuiltArtifact.sha256});
    assert.deepEqual((await second.getConversionJob(jobId)).spec.rebuildPublication, {...publication, chapter: rebuiltCompletion.chapter});
    await first.cancelConversionJob(jobId, {expectedCoordinatorGeneration: anotherRebuild.spec.coordinatorGeneration});
    const legacy = await first.createConversionJob({...request("legacy-interrupted"), priority: "interactive"}), legacyClaim = worker(150);
    const legacyLease = await second.claimConversionJob(legacyClaim);assert.equal(legacyLease.job.jobId, legacy.jobId);
    await first.submitConversionJob(legacy.jobId, {...legacyClaim, epoch: legacyLease.lease.epoch, artifact});
    await second.publishConversionJob(legacy.jobId, {epoch: legacyLease.lease.epoch, artifactSha256: artifact.sha256});
    // Isolated pre-upgrade cancelled state: accepted bytes remain, but no publication-history feature existed yet.
    await inspector.query("UPDATE raven_conversion_jobs SET status_name='cancelled', record_json=JSON_SET(JSON_REMOVE(record_json,'$._publicationHistory'),'$.status','cancelled','$.lease.epoch',?,'$.lease.expiresAt',NULL) WHERE job_id=?", [legacyLease.lease.epoch + 1, legacy.jobId]);
    await first.retryConversionJob(legacy.jobId, {requestId: "legacy-approved-retry", expectedEpoch: legacyLease.lease.epoch + 1});
    const legacyRetryClaim = worker(151), legacyRetryLease = await second.claimConversionJob(legacyRetryClaim);assert.equal(legacyRetryLease.job.jobId, legacy.jobId);
    await first.submitConversionJob(legacy.jobId, {...legacyRetryClaim, epoch: legacyRetryLease.lease.epoch, artifact: rebuiltArtifact});
    const legacyFence = {epoch: legacyRetryLease.lease.epoch, artifactSha256: rebuiltArtifact.sha256};await second.publishConversionJob(legacy.jobId, legacyFence);
    const legacyPublication = {...publication, jobId: legacy.jobId, epoch: legacyLease.lease.epoch};
    await first.completeConversionJob(legacy.jobId, {...legacyFence, publication: legacyPublication, chapter: {...chapter, id: "legacy-interrupted",
      ingestManifestPath: "/downloads/ingested/manhua/conversion-title/legacy-interrupted/webp-0123456789abcdef/manifest.json"}});
    assert.deepEqual((await second.getConversionJob(legacy.jobId)).result.publication, legacyPublication);
    await proveScopedReset(createCachedStore(first));
    await proveCanonicalTitleIdentity(createCachedStore(second), {readAliases: async () => {
      const [rows] = await inspector.query("SELECT * FROM raven_title_aliases WHERE alias_title_id IN (?,?) ORDER BY alias_title_id", ["6639ab89-297c-4516-9228-913f0f020cb4", "merged-alias"]);
      return rows;
    }});
  } finally {
    await first.close?.(); await second.close?.(); await inspector?.end();
    if (/^vault_conversion_[a-f0-9]{32}$/.test(database)) await admin.query("DROP DATABASE IF EXISTS ??", [database]);
    await admin.end();
  }
  console.log(JSON.stringify({passed:true,concurrentClaims:12,encodingCapacity:1,rollbackProved:true,scopedResetPreservationProved:true,coordinatorCancellationRaceProved:true,versionedOrderingRoundtripProved:true,canonicalTitleIdentityProved:true}));
  process.exit(0);
} catch(error) { console.error(error.stack); process.exit(1); }
