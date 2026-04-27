import test from "node:test";
import assert from "node:assert/strict";
import {probeSafetyLabel, probeStatusLabel, probeStatusTone} from "../apps/admin-next/lib/statusDisplay.js";

test("status display helpers format protected and skipped probes", () => {
  assert.equal(probeStatusTone("online"), "good");
  assert.equal(probeStatusTone("protected"), "warning");
  assert.equal(probeStatusTone("degraded"), "bad");
  assert.equal(probeStatusTone("not_probed"), "queued");
  assert.equal(probeStatusLabel("not_probed"), "not probed");
  assert.equal(probeStatusLabel("protected"), "protected");
  assert.equal(probeSafetyLabel(true), "GET checked");
  assert.equal(probeSafetyLabel(false), "mutation skipped");
});
