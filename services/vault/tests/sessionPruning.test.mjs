import test from "node:test";
import assert from "node:assert/strict";

import {createStore} from "../lib/createStore.mjs";

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

test("vault session lookup TTL-checks without deleting until explicit pruning runs", async () => {
  const store = createStore({
    driver: "memory",
    sessionTtlMs: 20
  });
  await store.init();
  await store.upsertDiscordUser({
    discordUserId: "reader-ttl",
    username: "Reader TTL"
  });

  const session = await store.createSession({discordUserId: "reader-ttl"});
  assert.equal((await store.getSession(session.token)).discordUserId, "reader-ttl");
  assert.equal((await store.getUserForSession(session.token)).discordUserId, "reader-ttl");

  await wait(35);

  assert.equal(await store.getSession(session.token), null);
  assert.equal(await store.getUserForSession(session.token), null);
  assert.deepEqual(await store.pruneExpiredSessions(), {removed: 1});
  assert.deepEqual(await store.pruneExpiredSessions(), {removed: 0});
});
