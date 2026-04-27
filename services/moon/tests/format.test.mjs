import test from "node:test";
import assert from "node:assert/strict";

import {formatDisplayValue} from "../apps/admin-next/lib/format.js";

test("formatDisplayValue returns trimmed scalar labels", () => {
  assert.equal(formatDisplayValue("  openai  ", "unknown"), "openai");
  assert.equal(formatDisplayValue(true, "unknown"), "true");
  assert.equal(formatDisplayValue(false, "unknown"), "false");
  assert.equal(formatDisplayValue(0, "unknown"), "0");
  assert.equal(formatDisplayValue(Number.NaN, "unknown"), "unknown");
  assert.equal(formatDisplayValue(null, "missing"), "missing");
});

test("formatDisplayValue summarizes arrays without returning raw objects", () => {
  assert.equal(formatDisplayValue(["openai", false, 2], "none"), "openai, false, 2");
  assert.equal(formatDisplayValue([], "none"), "none");
  assert.equal(formatDisplayValue([{nested: {status: "ok"}}, {details: {ready: true}}], "none"), "2 items");
});

test("formatDisplayValue prefers known object label fields and falls back cleanly", () => {
  assert.equal(formatDisplayValue({label: "CPU", key: "cpu"}, "unknown"), "CPU");
  assert.equal(formatDisplayValue({message: "LocalAI is optional.", phase: "idle"}, "unknown"), "LocalAI is optional.");
  assert.equal(formatDisplayValue({status: {ok: true}, details: {provider: "openai"}}, "unknown"), "unknown");
});

test("formatDisplayValue handles production-style Oracle health objects", () => {
  const oracleHealth = {
    ok: true,
    service: "scriptarr-oracle",
    enabled: false,
    provider: "openai",
    model: "gpt-4.1-mini",
    status: {
      ok: true,
      callbackUrl: "https://pax-kun.com/api/moon/auth/discord/callback",
      localAi: {
        configuredProfileKey: "cpu",
        configuredImage: "localai/localai:latest-aio-cpu",
        installed: false,
        running: false,
        ready: false,
        phase: "idle",
        message: "LocalAI is optional and not installed on first boot."
      },
      services: [
        {name: "scriptarr-vault"},
        {name: "scriptarr-sage"}
      ]
    }
  };

  assert.equal(formatDisplayValue(oracleHealth, "unknown"), "scriptarr-oracle");
  assert.equal(formatDisplayValue(oracleHealth.status, "offline"), "ok");
  assert.equal(formatDisplayValue(oracleHealth.status.localAi, "unknown"), "LocalAI is optional and not installed on first boot.");
});
