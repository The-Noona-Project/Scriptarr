/** @file Public monitoring cannot mistake a login page or live database process for download readiness. */
import test from "node:test";
import assert from "node:assert/strict";
import {downloadReadiness} from "../lib/downloadReadiness.mjs";

test("download readiness requires catalog, capacity, worker and VPN proof without leaking source details", () => {
  const healthy = {ok: true, dependencies: {vault: {ok: true, ready: true}, warden: {storage: {ready: true}, ingestDegraded: false, dependenciesReady: true},
    raven: {storage: {ready: true}, vpn: {enabled: true, protected: true}, privateField: "must not escape"}}};
  assert.deepEqual(downloadReadiness(healthy), {ready: true, catalogReady: true, storageReady: true, workerReady: true, vpnReady: true});
  assert.equal(downloadReadiness().ready, false);
  for (const [target, field] of [[healthy.dependencies.vault, "ready"], [healthy.dependencies.warden.storage, "ready"], [healthy.dependencies.raven.storage, "ready"], [healthy.dependencies.raven.vpn, "protected"]]) {
    target[field] = false; assert.equal(downloadReadiness(healthy).ready, false); target[field] = true;
  }
});
