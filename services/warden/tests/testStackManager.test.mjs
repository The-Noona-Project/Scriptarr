import test from "node:test";
import assert from "node:assert/strict";

import {buildTestStackEnvironment, normalizeTestStackId} from "../core/testStackManager.mjs";

test("normalize test stack id produces a docker-safe identifier", () => {
  assert.equal(normalizeTestStackId("My Local Stack"), "my-local-stack");
  assert.equal(normalizeTestStackId(""), "local");
});

test("build test stack environment uses selfhost mysql and an isolated network by default", () => {
  const result = buildTestStackEnvironment({
    env: {},
    stackId: "demo",
    moonPort: 3400,
    wardenPort: 4200,
    dataRoot: "C:\\scriptarr-test"
  });

  assert.equal(result.stackId, "demo");
  assert.equal(result.env.SCRIPTARR_STACK_MODE, "test");
  assert.equal(result.env.SCRIPTARR_MYSQL_URL, "SELFHOST");
  assert.equal(result.env.SCRIPTARR_NETWORK_NAME, "scriptarr-network-test-demo");
  assert.equal(result.env.SCRIPTARR_WARDEN_BASE_URL, "http://host.docker.internal:4200");
  assert.equal(result.env.SCRIPTARR_PUBLIC_BASE_URL, "http://127.0.0.1:3400");
});
