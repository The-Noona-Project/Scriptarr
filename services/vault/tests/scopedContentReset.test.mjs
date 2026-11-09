import test from "node:test";
import assert from "node:assert/strict";
import {createStore} from "../lib/createStore.mjs";
import {createCachedStore} from "../lib/createCachedStore.mjs";

import {seedScopedResetFixture, proveScopedReset} from "./support/scopedResetProof.mjs";

test("scoped reset retains canonical identities, user state, history and unrelated content with fenced replay", async () => {
  const base = createStore({driver: "memory"}); await base.init();
  await proveScopedReset(createCachedStore(base));
});

test("scoped reset begin rejects an active original run and changed filesystem inventory", async () => {
  const store = createStore({driver: "memory"}); await store.init();
  const body = await seedScopedResetFixture(store), preview = await store.previewScopedContentReset(body);
  await store.upsertJob({...await store.getJob(body.runId), status: "running"});
  await assert.rejects(store.beginScopedContentReset({...body, scopeDigest: preview.scopeDigest}), error => error.status === 409);
  await store.upsertJob({...await store.getJob(body.runId), status: "cancelled"});
  await store.upsertRavenChapter("selected", {id: "old-chapter", pageCount: 1, archivePath: "/downloads/downloaded/manhua/selected/different.cbz"});
  await assert.rejects(store.beginScopedContentReset({...body, scopeDigest: preview.scopeDigest}), error => error.status === 409);
  assert.equal((await store.getRavenTitle("selected")).chapters.length, 1);
});

test("an exact selected source shared by distinct canonical titles fails closed", async () => {
  const store = createStore({driver: "memory"}); await store.init();
  const body = await seedScopedResetFixture(store);
  await store.upsertRavenTitle({id: "source-collision", title: "Different canonical name", mediaType: "manhua", libraryTypeSlug: "manhua", sourceUrl: "https://source.example/selected"});
  await assert.rejects(store.previewScopedContentReset(body), error => error.status === 409 && /multiple canonical/.test(error.message));
  assert.equal((await store.getRavenTitle("selected")).chapters.length, 1);
});
