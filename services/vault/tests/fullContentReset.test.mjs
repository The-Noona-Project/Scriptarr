/** @file Full reset removes modern content state while preserving non-content service state. */
import test from "node:test";
import assert from "node:assert/strict";
import {createStore} from "../lib/createStore.mjs";
import {createCachedStore} from "../lib/createCachedStore.mjs";
import {createMemoryConversionRepository} from "../lib/conversionJobs.mjs";
import {clearFullResetExtras, previewFullResetExtras} from "../lib/fullContentReset.mjs";
import {seedScopedResetFixture} from "./support/scopedResetProof.mjs";

test("full reset clears aliases, conversion work, scoped fences and Discord content receipts", async () => {
  const base = createStore({driver: "memory"}); await base.init(); const store = createCachedStore(base);
  const body = await seedScopedResetFixture(store);
  await store.createConversionJob({input: {titleId: "unrelated", chapterId: "reset-chapter", sourceFingerprint: {sha256: "a".repeat(64), size: 123}, sourcePageCount: 1, archiveName: "chapter.cbz", entries: ["001.png"]}});
  const preview = await store.previewScopedContentReset(body);
  await store.beginScopedContentReset({...body, scopeDigest: preview.scopeDigest});
  await store.setSecret("preserved-key", "unchanged");
  for (const kind of ["portal-downloadall-delivery", "portal-downloadall-prompt", "portal-downloadall-action", "noona-trivia", "github-update"]) await store.upsertJob({jobId: kind, ownerService: "scriptarr-sage", kind, status: "queued", payload: {}, result: {}});
  await store.getJob("portal-downloadall-prompt"); await store.listRavenTitles();
  const before = await store.previewContentReset();
  assert.ok(before.counts.ravenTitleAliases > 0); assert.ok(before.counts.conversionJobs > 0); assert.ok(before.counts.contentResetOperations > 0);
  await store.executeContentReset();
  const after = await store.previewContentReset();
  assert.ok(Object.values(after.counts).every(n => n === 0));
  assert.deepEqual(await store.listRavenTitles(), []);
  assert.equal(await store.getJob("portal-downloadall-prompt"), null);
  assert.ok(await store.getJob("noona-trivia")); assert.ok(await store.getJob("github-update"));
  assert.deepEqual((await store.getSetting("preserved-setting")).value, {userState: "keep"});
  assert.equal((await store.getSecret("preserved-key")).value, "unchanged");
  assert.equal((await store.getConversionPool()).queuedJobs, 0);
  await store.executeContentReset(); assert.ok(Object.values((await store.previewContentReset()).counts).every(n => n === 0));
});

test("memory reset serializes after an in-flight conversion transaction and retains workers", async () => {
  const repository = createMemoryConversionRepository(); let release;
  const barrier = new Promise(resolve => release = resolve);
  const pending = repository.transaction(async tx => {await barrier; await tx.put({jobId: "old", spec: {input: {titleId: "title"}}}); await tx.putClaim("worker", "claim", {jobId: "old"}); await tx.putReset({operationId: "old-reset"}); await tx.putWorker({workerId: "worker"});});
  const reset = repository.transaction(tx => tx.clearContent()); release(); await pending;
  assert.deepEqual(await reset, {conversionJobs: 1, conversionClaims: 1, contentResetOperations: 1});
  assert.equal(repository.records.size, 0); assert.equal(repository.claims.size, 0); assert.equal(repository.fences.size, 0); assert.equal(repository.workers.size, 1);
});

test("MySQL extra reset touches only reviewed content tables", async () => {
  const calls = [], connection = {query: async sql => {calls.push(sql); return [[{count: 2}]];}};
  assert.deepEqual(await previewFullResetExtras(connection), {ravenTitleAliases: 2, conversionClaims: 2, conversionJobs: 2, contentResetOperations: 2});
  await clearFullResetExtras(connection);
  assert.deepEqual(calls.slice(4), ["DELETE FROM raven_title_aliases", "DELETE FROM raven_conversion_claims", "DELETE FROM raven_conversion_jobs", "DELETE FROM raven_content_resets"]);
});
