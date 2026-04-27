import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSettingsDraft,
  clearVpnPasswordDraft,
  mergeSettingsDraft,
  normalizeToastDraft
} from "../apps/admin-next/lib/settingsDraft.js";

test("settings draft prefers public branding when full branding is absent", () => {
  const draft = buildSettingsDraft({
    publicBranding: {siteName: "Pax-Kun"},
    ravenVpn: {enabled: true, region: "us_california", piaUsername: "captain"},
    toastSettings: {effective: {liveEventToasts: false}}
  });

  assert.equal(draft.branding.siteName, "Pax-Kun");
  assert.deepEqual(draft.ravenVpn, {
    enabled: true,
    region: "us_california",
    piaUsername: "captain",
    piaPassword: ""
  });
  assert.equal(draft.personalToasts.liveEventToasts, false);
});

test("settings draft keeps explicit toast false values editable", () => {
  const draft = normalizeToastDraft({
    actionToasts: false,
    jobToasts: true,
    liveEventToasts: false,
    failuresOnly: true,
    severities: {
      info: false,
      success: true,
      warning: false,
      error: true
    }
  });

  assert.deepEqual(draft, {
    actionToasts: false,
    jobToasts: true,
    liveEventToasts: false,
    failuresOnly: true,
    severities: {
      info: false,
      success: true,
      warning: false,
      error: true
    }
  });
});

test("settings draft merge keeps dirty sections while rehydrating clean sections", () => {
  const current = buildSettingsDraft({
    branding: {siteName: "Unsaved"},
    ravenVpn: {enabled: false, region: "old"},
    toastSettings: {effective: {}}
  });
  const incoming = buildSettingsDraft({
    branding: {siteName: "Saved"},
    ravenVpn: {enabled: true, region: "new"},
    toastSettings: {effective: {}}
  });

  const merged = mergeSettingsDraft(current, incoming, new Set(["branding"]));

  assert.equal(merged.branding.siteName, "Unsaved");
  assert.equal(merged.ravenVpn.region, "new");
});

test("settings draft clears VPN password after successful save", () => {
  const draft = clearVpnPasswordDraft({
    ravenVpn: {
      enabled: true,
      region: "us_california",
      piaUsername: "captain",
      piaPassword: "secret"
    }
  });

  assert.equal(draft.ravenVpn.piaPassword, "");
  assert.equal(draft.ravenVpn.region, "us_california");
});
