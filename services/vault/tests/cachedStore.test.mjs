import test from "node:test";
import assert from "node:assert/strict";

import {createCachedStore} from "../lib/createCachedStore.mjs";

const createFakeBaseStore = () => {
  const settings = new Map();
  const progress = new Map();
  const calls = {
    getSetting: [],
    setSetting: [],
    getProgressByUser: [],
    listReaderTargets: [],
    upsertProgress: []
  };

  return {
    calls,
    store: {
      async getSetting(key) {
        calls.getSetting.push(key);
        return {
          key,
          value: settings.get(key) ?? null,
          loadCount: calls.getSetting.length
        };
      },
      async setSetting(key, value) {
        calls.setSetting.push(key);
        settings.set(key, value);
        return {key, value};
      },
      async getProgressByUser(discordUserId) {
        calls.getProgressByUser.push(discordUserId);
        return {
          key: `progress:${discordUserId}`,
          entries: progress.get(discordUserId) ?? []
        };
      },
      async listReaderTargets(filters = {}) {
        calls.listReaderTargets.push(filters);
        return [{key: "reader-targets", filters}];
      },
      async upsertProgress(payload) {
        calls.upsertProgress.push(payload);
        const entries = progress.get(payload.discordUserId) ?? [];
        const next = {...payload};
        progress.set(payload.discordUserId, [...entries, next]);
        return next;
      }
    }
  };
};

test("createCachedStore evicts least recently used entries when maxEntries is reached", async () => {
  let currentTime = 0;
  const base = createFakeBaseStore();
  const store = createCachedStore(base.store, {
    ttlMs: 1000,
    maxEntries: 2,
    now: () => currentTime
  });

  const firstA = await store.getSetting("a");
  await store.getSetting("b");
  const cachedA = await store.getSetting("a");
  await store.getSetting("c");

  assert.equal(store.cacheSize(), 2);
  assert.deepEqual(base.calls.getSetting, ["a", "b", "c"]);
  assert.deepEqual(cachedA, firstA);

  await store.getSetting("b");

  assert.deepEqual(base.calls.getSetting, ["a", "b", "c", "b"]);
  assert.equal(store.cacheSize(), 2);
});

test("createCachedStore prunes expired entries opportunistically on reads and writes", async () => {
  let currentTime = 0;
  const base = createFakeBaseStore();
  const store = createCachedStore(base.store, {
    ttlMs: 10,
    maxEntries: 10,
    now: () => currentTime
  });

  await store.getSetting("a");
  await store.getSetting("b");
  assert.equal(store.cacheSize(), 2);

  currentTime = 11;
  await store.getSetting("c");

  assert.equal(store.cacheSize(), 1);
  assert.deepEqual(base.calls.getSetting, ["a", "b", "c"]);

  currentTime = 22;
  await store.setSetting("d", {enabled: true});

  assert.equal(store.cacheSize(), 1);
  assert.deepEqual(base.calls.setSetting, ["d"]);
});

test("createCachedStore keeps normal write refresh and prefix invalidation behavior", async () => {
  let currentTime = 0;
  const base = createFakeBaseStore();
  const store = createCachedStore(base.store, {
    ttlMs: 1000,
    maxEntries: 10,
    now: () => currentTime
  });

  const written = await store.setSetting("moon.following.user-1", {titleIds: ["a"]});
  written.value.titleIds.push("mutated-after-write");

  const cached = await store.getSetting("moon.following.user-1");
  cached.value.titleIds.push("mutated-after-read");

  const cachedAgain = await store.getSetting("moon.following.user-1");
  assert.deepEqual(cachedAgain.value.titleIds, ["a"]);
  assert.deepEqual(base.calls.getSetting, []);

  await store.getProgressByUser("user-1");
  await store.listReaderTargets({discordUserId: "user-1"});
  assert.equal(store.cacheSize(), 3);

  await store.upsertProgress({
    discordUserId: "user-1",
    mediaId: "title-1",
    chapterId: "chapter-1"
  });

  assert.equal(store.cacheSize(), 1);
  const progressAfterInvalidation = await store.getProgressByUser("user-1");
  await store.listReaderTargets({discordUserId: "user-1"});

  assert.equal(progressAfterInvalidation.key, "progress:user-1");
  assert.equal(store.cacheSize(), 3);
});
