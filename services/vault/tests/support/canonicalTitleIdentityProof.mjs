import assert from "node:assert/strict";

const kingId = "6639ab89-297c-4516-9228-913f0f020cb4";
const rebootId = "3ff280a2-70dc-4be0-89c3-a39059bb2cf9";
const kingSource = "https://source.example/series/original";
const rebootSource = "https://source.example/series/reboot";
const kingName = "Canonical identity Original";
const rebootName = "Canonical identity Reboot";
const title = (id, name, sourceUrl) => ({id, title: name, mediaType: "manhua", libraryTypeSlug: "manhua", sourceUrl,
  status: "completed", coverUrl: `https://art.example/${id}.jpg`, chapterCount: 1, chaptersDownloaded: 1,
  downloadRoot: `/downloads/downloaded/manhua/${id}`, workingRoot: `/downloads/downloading/manhua/${id}`});
const chapter = id => ({id: `chapter-${id}`, label: "Chapter 1", chapterNumber: "1", pageCount: 1, available: true,
  archivePath: `/downloads/downloaded/manhua/${id}/c001.cbz`, ingestStatus: "ready", ingestRevision: "avif-0123456789abcdef", ingestedPageCount: 1});

/** Reproduce a retained raw row whose ID is also a historical catalog-key alias, using ordinary store operations. */
export const proveCanonicalTitleIdentity = async (store, {readAliases = async () => null} = {}) => {
  await store.upsertRavenTitle(title(rebootId, rebootName, rebootSource));
  await store.upsertRavenTitle(title(kingId, rebootName, rebootSource));
  assert.equal((await store.getRavenTitle(kingId)).id, rebootId, "An alias without a raw title must still redirect.");
  const aliasesBefore = await readAliases();
  // Older key-based writes can leave a real, distinct provider edition underneath an existing alias.
  await store.upsertRavenTitle(title(kingId, kingName, kingSource));
  const king = await store.getRavenTitle(kingId), reboot = await store.getRavenTitle(rebootId);
  assert.equal(king.id, kingId, "An existing raw canonical row must win over a retained alias.");
  assert.equal(king.sourceUrl, kingSource); assert.equal(reboot.sourceUrl, rebootSource);
  await store.upsertRavenChapter(kingId, chapter(kingId));
  await store.upsertRavenChapter(rebootId, chapter(rebootId));
  assert.equal((await store.getRavenTitle(kingId)).chapters[0].id, chapter(kingId).id);
  assert.equal((await store.getRavenTitle(rebootId)).chapters[0].id, chapter(rebootId).id);
  const rebootBeforeUpdate = await store.getRavenTitle(rebootId);
  const updated = await store.upsertRavenTitle({...king, title: rebootName, summary: "Original edition update"});
  assert.equal(updated.id, kingId, "An existing ID update must not move into another row with the same catalog key.");
  assert.equal(updated.sourceUrl, kingSource);
  assert.deepEqual(await store.getRavenTitle(rebootId), rebootBeforeUpdate, "A key collision must not overwrite the other edition.");
  await store.upsertRavenTitle({...updated, title: kingName});

  await store.upsertRavenTitle(title("merged-alias", rebootName, rebootSource));
  const mergedUpdate = await store.upsertRavenTitle({...title("merged-alias", rebootName, rebootSource), latestChapter: "2"});
  assert.equal(mergedUpdate.id, rebootId, "Normal alias-only catalog-key writes keep their redirect.");
  assert.equal((await store.getRavenTitle("merged-alias")).id, rebootId);
  await store.upsertRavenTitle(title("identity-unrelated", "Canonical identity Unrelated", "https://source.example/identity-unrelated"));
  await store.upsertRavenChapter("identity-unrelated", chapter("identity-unrelated"));
  await store.setSetting("canonical-identity-preserve", {keep: true});
  await store.upsertProgress({discordUserId: "identity-reader", mediaId: kingId, positionRatio: 0.5, chapterLabel: "Chapter 1"});
  await store.upsertProgress({discordUserId: "identity-reader", mediaId: rebootId, positionRatio: 0.25, chapterLabel: "Chapter 1"});
  const runId = "canonical-identity-run", planIds = ["identity-original-plan", "identity-reboot-plan"];
  await store.upsertJob({jobId: runId, ownerService: "scriptarr-raven", kind: "raven-bulk-downloadall", status: "cancelled", payload: {approvalId: "preserved-approval"}});
  for (const [index, source] of [kingSource, rebootSource].entries()) {
    const taskId = `identity-download-${index}`;
    await store.upsertJobTask(runId, {taskId: planIds[index], status: "completed", payload: {kind: "bulk-title-plan", downloadTaskId: taskId,
      titleName: index ? rebootName : kingName, requestType: "Manhua", titleUrl: source,
      request: {selectedDownload: {libraryTypeSlug: "manhua"}}}});
    // Both old tasks were incorrectly attached to Reboot; exact selected source/type must recover the original row too.
    await store.upsertRavenDownloadTask({taskId, titleId: rebootId, titleName: rebootName, titleUrl: source, status: "cancelled",
      details: {bulkRunId: runId, bulkPlanId: planIds[index]}});
  }
  const before = {titles: await Promise.all([kingId, rebootId].map(id => store.getRavenTitle(id))), aliases: await readAliases(),
    progress: await store.getProgressByUser("identity-reader"), run: await store.getJob(runId), plans: await store.listJobTasks(runId),
    tasks: await store.listRavenDownloadTasks(), unrelated: await store.getRavenTitle("identity-unrelated")};
  if (aliasesBefore) assert.deepEqual(before.aliases.filter(row => row.alias_title_id === kingId), aliasesBefore);
  const preview = await store.previewScopedContentReset({operationId: "canonical-identity-reset", runId, planIds});
  assert.deepEqual(preview.titleIds, [rebootId, kingId].sort(), "Distinct selected source editions must retain both raw canonical IDs.");
  assert.equal(preview.titles.length, 2);
  await store.beginScopedContentReset({operationId: preview.operationId, scopeDigest: preview.scopeDigest});
  const proof = {operationId: preview.operationId, scopeDigest: preview.scopeDigest, quiescent: true, removedTitleIds: preview.titleIds,
    filesystemScopeDigest: "a".repeat(64), removedPathCount: 2, remainingScopedPathCount: 0};
  const applied = await store.applyScopedContentReset(proof);
  assert.equal(applied.result.chaptersCleared, 2);
  await store.finishScopedContentReset({operationId: preview.operationId, scopeDigest: preview.scopeDigest});
  for (const previous of before.titles) {
    const current = await store.getRavenTitle(previous.id);
    assert.equal(current.id, previous.id); assert.equal(current.title, previous.title); assert.equal(current.sourceUrl, previous.sourceUrl);
    assert.equal(current.coverUrl, previous.coverUrl); assert.equal(current.status, previous.status); assert.deepEqual(current.chapters, []);
  }
  assert.deepEqual(await readAliases(), before.aliases, "The fix and scoped reset must retain alias rows byte for byte.");
  assert.deepEqual(await store.getProgressByUser("identity-reader"), before.progress);
  assert.deepEqual(await store.getJob(runId), before.run); assert.deepEqual(await store.listJobTasks(runId), before.plans);
  assert.deepEqual(await store.listRavenDownloadTasks(), before.tasks); assert.deepEqual(await store.getRavenTitle("identity-unrelated"), before.unrelated);
  assert.deepEqual((await store.getSetting("canonical-identity-preserve")).value, {keep: true});
  assert.equal((await store.getRavenTitle("merged-alias")).id, rebootId);
  return {passed: true, canonicalIds: preview.titleIds, existingIdUpdatePreserved: true, aliasOnlyRedirectPreserved: true, scopedEditionsReset: true};
};
