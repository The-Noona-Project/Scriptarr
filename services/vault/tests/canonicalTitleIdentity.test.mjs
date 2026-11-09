import test from "node:test";
import {createStore} from "../lib/createStore.mjs";
import {createCachedStore} from "../lib/createCachedStore.mjs";
import {proveCanonicalTitleIdentity} from "./support/canonicalTitleIdentityProof.mjs";

test("raw canonical IDs survive stale aliases, catalog-key updates and exact-source scoped reset", async () => {
  const store = createCachedStore(createStore({driver: "memory"}));
  await store.init();
  await proveCanonicalTitleIdentity(store);
});
