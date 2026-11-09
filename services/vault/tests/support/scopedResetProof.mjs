import assert from "node:assert/strict";

const chapter = {id: "old-chapter", label: "Chapter 1", chapterNumber: "1", pageCount: 1, available: true,
  archivePath: "/downloads/downloaded/manhua/selected/c001.cbz", ingestStatus: "ready", ingestRevision: "avif-0123456789abcdef", ingestedPageCount: 1};
const conversion = (titleId = "selected") => ({input: {titleId, chapterId: "new-chapter", sourceFingerprint: {sha256: "a".repeat(64), size: 123}, sourcePageCount: 1, archiveName: "chapter.cbz", entries: ["001.png"]}});

/** Seed two selected plans sharing one canonical title, and one never-catalogued plan. */
export const seedScopedResetFixture = async store => {
  await store.upsertRavenTitle({id: "selected", title: "Selected", mediaType: "manhua", libraryTypeSlug: "manhua", coverUrl: "https://art.example/keep.jpg", status: "completed",
    sourceUrl: "https://source.example/selected", chapterCount: 1, chaptersDownloaded: 1, workingRoot: "/downloads/downloading/manhua/selected", downloadRoot: "/downloads/downloaded/manhua/selected"});
  await store.upsertRavenChapter("selected", chapter);
  await store.upsertRavenTitle({id: "selected-alias", title: "Selected", mediaType: "manhua", libraryTypeSlug: "manhua", coverUrl: "https://art.example/keep.jpg", status: "completed", sourceUrl: "https://source.example/selected"});
  await store.upsertRavenTitle({id: "unrelated", title: "Unrelated", mediaType: "manhua", libraryTypeSlug: "manhua", sourceUrl: "https://source.example/unrelated"});
  await store.upsertRavenChapter("unrelated", {...chapter, archivePath: "/downloads/downloaded/manhua/unrelated/c001.cbz"});
  await store.upsertRavenTitle({id: "other-type", title: "Selected", mediaType: "manga", libraryTypeSlug: "manga", sourceUrl: "https://source.example/selected"});
  await store.upsertRavenTitle({id: "unrelated-avatar", title: "Avatar", mediaType: "manhua", libraryTypeSlug: "manhua", sourceUrl: "https://source.example/actually-unrelated-avatar"});
  await store.upsertRavenChapter("unrelated-avatar", {...chapter, archivePath: "/downloads/downloaded/manhua/unrelated-avatar/c001.cbz"});
  await store.upsertJob({jobId: "selected-run", ownerService: "scriptarr-raven", kind: "raven-bulk-downloadall", status: "cancelled", payload: {approvalId: "approval-preserve", decisions: {old: {decision: "cancel"}}}});
  for (const [offset, titleId] of ["selected-alias", "selected", null].entries()) {
    const planId = `plan-${offset}`, downloadTaskId = `download-${offset}`;
    await store.upsertJobTask("selected-run", {taskId: planId, taskKey: "bulk-title-plan", status: "completed", payload: {kind: "bulk-title-plan", downloadTaskId,
      titleName: offset === 2 ? "Not Yet Catalogued" : "Selected", requestType: "Manhua", titleUrl: `https://source.example/${offset === 2 ? "not-yet" : "selected"}`,
      request: {titleName: offset === 2 ? "Not Yet Catalogued" : "Selected", requestType: "Manhua", selectedMetadata: {title: "Avatar", aliases: ["Avatar", "Unrelated"]}, selectedDownload: {libraryTypeSlug: "manhua"}}}});
    await store.upsertRavenDownloadTask({taskId: downloadTaskId, jobId: downloadTaskId, titleId, titleName: offset === 2 ? "Not Yet Catalogued" : "Selected", titleUrl: `https://source.example/${offset === 2 ? "not-yet" : "selected"}`, status: "cancelled",
      details: {bulkRunId: "selected-run", bulkPlanId: planId}, downloadRoot: `/downloads/downloading/manhua/${offset === 2 ? "not-yet" : "selected"}`});
  }
  await store.upsertJobTask("selected-run", {taskId: "batch-0", taskKey: "bulk-batch", status: "paused", payload: {kind: "bulk-batch"}});
  await store.upsertJobTask("selected-run", {taskId: "discovery", taskKey: "bulk-discovery-plan", status: "completed", payload: {kind: "bulk-discovery-plan"}});
  await store.upsertJobTask("selected-run", {taskId: "no-metadata", taskKey: "bulk-title-plan", status: "completed", payload: {kind: "bulk-title-plan", downloadTaskId: "never-created", titleName: "Policy Skip"}, result: {category: "noMetadata", downloadTaskId: ""}});
  await store.upsertJobTask("selected-run", {taskId: "unresolved", taskKey: "bulk-title-plan", status: "cancelled", payload: {kind: "bulk-title-plan", downloadTaskId: "never-created-either", titleName: "Unresolved"}, result: {category: "unresolved"}});
  await store.setSetting("preserved-setting", {userState: "keep"});
  await store.upsertProgress({discordUserId: "reader", mediaId: "selected", chapterLabel: "Chapter 1", positionRatio: 0.5, bookmark: {chapterId: "old-chapter", pageIndex: 5}});
  return {runId: "selected-run", operationId: "scoped-reset-1", planIds: ["plan-0", "plan-1", "plan-2"]};
};

/** Exercise the same content-only contract against memory and real MySQL stores. */
export const proveScopedReset = async store => {
  const body = await seedScopedResetFixture(store);
  const tasksBefore = await store.listRavenDownloadTasks(), jobBefore = await store.getJob(body.runId);
  const progressBefore = await store.getProgressByUser("reader");
  const preview = await store.previewScopedContentReset(body);
  assert.deepEqual(preview.titleIds, ["selected"], "Plans/aliases deduplicate without absorbing a same-name title of a different type.");
  assert.ok(preview.fencedTitleIds.includes("selected-alias"));
  assert.equal(preview.plans.length, 3); assert.equal(preview.tasks.length, 3); assert.equal(preview.titles.length, 1);
  assert.deepEqual(await store.previewScopedContentReset({operationId: body.operationId, scopeDigest: preview.scopeDigest}), preview);
  assert.equal((await store.getRavenTitle("selected")).chapters.length, 1, "Preview is content read-only.");
  await assert.rejects(store.previewScopedContentReset({...body, planIds: ["plan-0"]}), error => error.status === 409);
  const oldJob = await store.createConversionJob(conversion());
  const oldAliasJob = await store.createConversionJob(conversion("selected-alias"));
  await store.beginScopedContentReset({operationId: body.operationId, scopeDigest: preview.scopeDigest});
  assert.equal((await store.getConversionJob(oldJob.jobId)).status, "cancelled");
  assert.equal((await store.getConversionJob(oldAliasJob.jobId)).status, "cancelled");
  await assert.rejects(store.createConversionJob({...conversion("selected-alias"), input: {...conversion("selected-alias").input, chapterId: "another"}}), error => error.status === 409);
  await assert.rejects(store.createConversionJob({...conversion(), input: {...conversion().input, chapterId: "another"}}), error => error.status === 409);
  await store.createConversionJob(conversion("unrelated"));
  await assert.rejects(store.applyScopedContentReset({operationId: body.operationId, scopeDigest: preview.scopeDigest}), error => error.status === 409);
  assert.equal((await store.getRavenTitle("selected")).chapters.length, 1, "Invalid proof must never clear content.");
  const proof = {operationId: body.operationId, scopeDigest: preview.scopeDigest, quiescent: true, removedTitleIds: ["selected"], filesystemScopeDigest: "f".repeat(64), removedPathCount: 3, remainingScopedPathCount: 0};
  const applied = await store.applyScopedContentReset(proof);
  assert.equal(applied.status, "catalog-cleared"); assert.equal(applied.result.chaptersCleared, 1);
  const cleared = await store.getRavenTitle("selected-alias");
  assert.equal(cleared.id, "selected"); assert.equal(cleared.chapters.length, 0); assert.equal(cleared.chapterCount, 0);
  assert.equal(cleared.coverUrl, "https://art.example/keep.jpg"); assert.equal(cleared.status, "completed");
  assert.equal(cleared.downloadRoot, ""); assert.equal(cleared.workingRoot, ""); assert.equal(cleared.ingestedChapterCount, 0);
  assert.equal((await store.getRavenTitle("unrelated")).chapters.length, 1);
  assert.equal((await store.getRavenTitle("unrelated-avatar")).chapters.length, 1, "A bad metadata alias cannot authorize deletion of unrelated content.");
  assert.ok(await store.getRavenTitle("other-type"));
  assert.deepEqual(await store.getProgressByUser("reader"), progressBefore);
  assert.deepEqual((await store.getSetting("preserved-setting")).value, {userState: "keep"});
  assert.deepEqual(await store.listRavenDownloadTasks(), tasksBefore);
  assert.deepEqual(await store.getJob(body.runId), jobBefore);
  await store.finishScopedContentReset({operationId: body.operationId, scopeDigest: preview.scopeDigest});
  await store.upsertRavenChapter("selected", {...chapter, id: "fresh-chapter"});
  assert.equal((await store.applyScopedContentReset(proof)).status, "finished");
  assert.equal((await store.getRavenTitle("selected")).chapters[0].id, "fresh-chapter", "A lost old apply response cannot clear content created after finish.");
  assert.deepEqual((await store.previewScopedContentReset({operationId: body.operationId, scopeDigest: preview.scopeDigest})).titles, preview.titles, "Crash recovery must retain the original filesystem inventory after deletion.");
  await assert.rejects(store.applyScopedContentReset({...proof, filesystemScopeDigest: "e".repeat(64)}), error => error.status === 409);
  return {passed: true, titleIds: preview.titleIds, selectedPlans: preview.plans.length};
};
