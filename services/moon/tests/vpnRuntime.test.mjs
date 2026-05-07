/**
 * @file Tests for Raven VPN runtime display helpers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {normalizeVpnRuntimeState, vpnRuntimeLabel, vpnRuntimeTone} from "../apps/admin-next/lib/vpnRuntime.js";

test("VPN runtime helpers show armed idle for enabled lazy VPN", () => {
  const settings = {enabled: true};
  const runtime = {state: "armed", enabled: true, runtimeCapable: true, settingsFresh: true, connected: false, protected: false};

  assert.equal(normalizeVpnRuntimeState(runtime), "armed");
  assert.equal(vpnRuntimeLabel(settings, runtime), "armed / idle");
  assert.equal(vpnRuntimeTone(settings, runtime), "warning");
});

test("VPN runtime helpers label protected and failure states", () => {
  const settings = {enabled: true};

  assert.equal(vpnRuntimeLabel(settings, {state: "protected", protected: true}), "protected");
  assert.equal(vpnRuntimeTone(settings, {state: "protected", protected: true}), "good");
  assert.equal(vpnRuntimeLabel(settings, {state: "failed", lastError: "auth failed"}), "failed");
  assert.equal(vpnRuntimeTone(settings, {state: "failed", lastError: "auth failed"}), "bad");
  assert.equal(vpnRuntimeLabel(settings, {state: "runtime_unsupported"}), "runtime unsupported");
  assert.equal(vpnRuntimeLabel(settings, {state: "settings_stale"}), "settings stale");
});

test("VPN runtime helpers keep legacy payloads display-safe", () => {
  assert.equal(vpnRuntimeLabel({enabled: false}, {runtimeCapable: true}), "disabled");
  assert.equal(vpnRuntimeLabel({enabled: true}, {protected: true}), "protected");
  assert.equal(vpnRuntimeLabel({enabled: true}, {enabled: true, connected: false, runtimeCapable: true, settingsFresh: true}), "armed / idle");
});
