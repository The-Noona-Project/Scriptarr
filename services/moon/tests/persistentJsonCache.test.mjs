import test from "node:test";
import assert from "node:assert/strict";

import {logoutMoonSession} from "../apps/user-next/lib/api.js";
import {
  clearPersistentMoonJsonCache,
  clearPersistentMoonJsonCacheForStatus,
  isPersistentMoonJsonCacheable,
  prunePersistentMoonJsonCache,
  readPersistentMoonJsonCache,
  resolvePersistentMoonJsonCacheScope,
  writePersistentMoonJsonCache
} from "../apps/user-next/lib/persistentJsonCache.js";

class MemoryCache {
  constructor() {
    this.entries = new Map();
  }

  async put(request, response) {
    this.entries.set(request.url, response.clone());
  }

  async match(request) {
    const response = this.entries.get(request.url);
    return response ? response.clone() : undefined;
  }

  async delete(request) {
    return this.entries.delete(request.url);
  }

  async keys() {
    return Array.from(this.entries.keys()).map((url) => new Request(url));
  }
}

const installMemoryCacheStorage = () => {
  const previousCaches = globalThis.caches;
  const stores = new Map();
  globalThis.caches = {
    async open(name) {
      if (!stores.has(name)) {
        stores.set(name, new MemoryCache());
      }
      return stores.get(name);
    },
    async delete(name) {
      return stores.delete(name);
    }
  };
  return () => {
    if (previousCaches === undefined) {
      delete globalThis.caches;
      return;
    }
    globalThis.caches = previousCaches;
  };
};

test("persistent Moon JSON cache only allows card-heavy user routes", () => {
  assert.equal(resolvePersistentMoonJsonCacheScope("/api/moon-v3/user/home"), "home");
  assert.equal(resolvePersistentMoonJsonCacheScope("/api/moon-v3/user/profile"), "profile");
  assert.equal(resolvePersistentMoonJsonCacheScope("/api/moon-v3/user/library?view=card&pageSize=72"), "library");
  assert.equal(isPersistentMoonJsonCacheable("/api/moon-v3/user/library?view=card&q=solo"), true);
  assert.equal(isPersistentMoonJsonCacheable("/api/moon-v3/user/library?pageSize=72"), false);
  assert.equal(isPersistentMoonJsonCacheable("/api/moon-v3/user/title/dan-da-dan"), false);
  assert.equal(isPersistentMoonJsonCacheable("/api/moon-v3/user/api-keys"), false);
  assert.equal(isPersistentMoonJsonCacheable("/api/moon-v3/admin/system/status"), false);
});

test("persistent Moon JSON cache scopes payloads by user and exact URL", async () => {
  const restore = installMemoryCacheStorage();
  try {
    await writePersistentMoonJsonCache({
      url: "/api/moon-v3/user/library?view=card&pageSize=72",
      userKey: "reader-a",
      payload: {titles: [{id: "a"}]}
    });
    await writePersistentMoonJsonCache({
      url: "/api/moon-v3/user/library?view=card&pageSize=72",
      userKey: "reader-b",
      payload: {titles: [{id: "b"}]}
    });
    await writePersistentMoonJsonCache({
      url: "/api/moon-v3/user/library?view=card&pageSize=100",
      userKey: "reader-a",
      payload: {titles: [{id: "a-100"}]}
    });

    assert.deepEqual(
      await readPersistentMoonJsonCache({url: "/api/moon-v3/user/library?view=card&pageSize=72", userKey: "reader-a"}),
      {titles: [{id: "a"}]}
    );
    assert.deepEqual(
      await readPersistentMoonJsonCache({url: "/api/moon-v3/user/library?view=card&pageSize=72", userKey: "reader-b"}),
      {titles: [{id: "b"}]}
    );
    assert.deepEqual(
      await readPersistentMoonJsonCache({url: "/api/moon-v3/user/library?view=card&pageSize=100", userKey: "reader-a"}),
      {titles: [{id: "a-100"}]}
    );
  } finally {
    restore();
  }
});

test("persistent Moon JSON cache ignores non-allowlisted writes", async () => {
  const restore = installMemoryCacheStorage();
  try {
    assert.equal(await writePersistentMoonJsonCache({
      url: "/api/moon-v3/user/api-keys",
      userKey: "reader-a",
      payload: {apiKeys: [{id: "secret"}]}
    }), false);
    assert.equal(await readPersistentMoonJsonCache({
      url: "/api/moon-v3/user/api-keys",
      userKey: "reader-a"
    }), null);
  } finally {
    restore();
  }
});

test("persistent Moon JSON cache prunes older entries per user", async () => {
  const restore = installMemoryCacheStorage();
  try {
    await writePersistentMoonJsonCache({url: "/api/moon-v3/user/home", userKey: "reader-a", payload: {id: "home"}});
    await writePersistentMoonJsonCache({url: "/api/moon-v3/user/profile", userKey: "reader-a", payload: {id: "profile"}});
    await writePersistentMoonJsonCache({url: "/api/moon-v3/user/library?view=card&pageSize=72", userKey: "reader-a", payload: {id: "library"}});
    await writePersistentMoonJsonCache({url: "/api/moon-v3/user/home", userKey: "reader-b", payload: {id: "other-user"}});

    assert.equal(await prunePersistentMoonJsonCache("reader-a", {maxEntries: 2}), 1);
    assert.equal(await readPersistentMoonJsonCache({url: "/api/moon-v3/user/home", userKey: "reader-a"}), null);
    assert.deepEqual(await readPersistentMoonJsonCache({url: "/api/moon-v3/user/profile", userKey: "reader-a"}), {id: "profile"});
    assert.deepEqual(await readPersistentMoonJsonCache({url: "/api/moon-v3/user/home", userKey: "reader-b"}), {id: "other-user"});
  } finally {
    restore();
  }
});

test("persistent Moon JSON cache clears on auth failures and logout", async () => {
  const restoreCache = installMemoryCacheStorage();
  const previousFetch = globalThis.fetch;
  try {
    await writePersistentMoonJsonCache({url: "/api/moon-v3/user/home", userKey: "reader-a", payload: {id: "home"}});
    assert.equal(await clearPersistentMoonJsonCacheForStatus(401, "reader-a"), 1);
    assert.equal(await readPersistentMoonJsonCache({url: "/api/moon-v3/user/home", userKey: "reader-a"}), null);

    await writePersistentMoonJsonCache({url: "/api/moon-v3/user/profile", userKey: "reader-a", payload: {id: "profile"}});
    globalThis.fetch = async () => new Response(JSON.stringify({ok: true}), {
      status: 200,
      headers: {"Content-Type": "application/json"}
    });
    assert.equal((await logoutMoonSession()).ok, true);
    assert.equal(await readPersistentMoonJsonCache({url: "/api/moon-v3/user/profile", userKey: "reader-a"}), null);
  } finally {
    globalThis.fetch = previousFetch;
    restoreCache();
  }
});

test("persistent Moon JSON cache can clear one user without deleting another", async () => {
  const restore = installMemoryCacheStorage();
  try {
    await writePersistentMoonJsonCache({url: "/api/moon-v3/user/home", userKey: "reader-a", payload: {id: "a"}});
    await writePersistentMoonJsonCache({url: "/api/moon-v3/user/home", userKey: "reader-b", payload: {id: "b"}});

    assert.equal(await clearPersistentMoonJsonCache("reader-a"), 1);
    assert.equal(await readPersistentMoonJsonCache({url: "/api/moon-v3/user/home", userKey: "reader-a"}), null);
    assert.deepEqual(await readPersistentMoonJsonCache({url: "/api/moon-v3/user/home", userKey: "reader-b"}), {id: "b"});
  } finally {
    restore();
  }
});
