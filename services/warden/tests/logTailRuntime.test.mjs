/**
 * @file Scriptarr Warden module: services/warden/tests/logTailRuntime.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {createLogTailRuntime} from "../core/logTailRuntime.mjs";

const createRuntime = (rawLogs, calls = []) => createLogTailRuntime({
  env: {
    SCRIPTARR_WARDEN_CONTAINER_NAME: "warden-local"
  },
  resolvePlan: () => ({
    services: [
      {name: "scriptarr-moon", image: "moon:latest", containerName: "moon-local"},
      {name: "scriptarr-raven", image: "raven:latest", containerName: "raven-local"}
    ]
  }),
  dockerOps: {
    async readDockerContainerLogs(containerName, options) {
      calls.push({containerName, options});
      return rawLogs;
    }
  }
});

test("log tail runtime allowlists managed service containers and clamps line counts", async () => {
  const calls = [];
  const runtime = createRuntime("2026-04-25T10:00:00.000Z info hello", calls);

  const result = await runtime.tailLogs({
    service: "scriptarr-moon",
    lines: 5000
  });

  assert.equal(result.selectedService, "scriptarr-moon");
  assert.equal(calls[0].containerName, "moon-local");
  assert.equal(calls[0].options.lines, 1000);
  assert.deepEqual(result.services.map((service) => service.name), [
    "scriptarr-moon",
    "scriptarr-raven",
    "scriptarr-warden"
  ]);
});

test("log tail runtime redacts secrets before returning entries", async () => {
  const runtime = createRuntime([
    "2026-04-25T10:00:00.000Z Authorization: Bearer super-secret-token-value",
    "2026-04-25T10:00:01.000Z discord token abcdefghijklmnopqrstuvwx.abcdef.abcdefghijklmnopqrstuv"
  ].join("\n"));

  const result = await runtime.tailLogs({
    service: "scriptarr-raven"
  });
  const messages = result.entries.map((entry) => entry.message).join("\n");

  assert.equal(result.redacted, true);
  assert.match(messages, /\[redacted\]/);
  assert.doesNotMatch(messages, /super-secret-token-value/);
  assert.doesNotMatch(messages, /abcdefghijklmnopqrstuv/);
});

test("log tail runtime filters by inferred level and query", async () => {
  const runtime = createRuntime([
    "2026-04-25T10:00:00.000Z info booted",
    "2026-04-25T10:00:01.000Z warn queue degraded",
    "2026-04-25T10:00:02.000Z error fetch failed for moon"
  ].join("\n"));

  const result = await runtime.tailLogs({
    level: "error",
    q: "moon"
  });

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].level, "error");
  assert.match(result.entries[0].message, /moon/);
});
