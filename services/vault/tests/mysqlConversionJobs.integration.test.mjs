import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

test("MySQL 8.4 serializes conversion claims and atomically publishes chapters with scoped reset preservation", {
  skip: !process.env.SCRIPTARR_TEST_MYSQL_URL, timeout: 180000
}, async () => {
  const {stdout} = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./support/mysqlConversionProof.mjs", import.meta.url))], {
    env: process.env, timeout: 170000, maxBuffer: 1024 * 1024
  });
  const proof = JSON.parse(stdout.trim());
  assert.equal(proof.passed, true);
  assert.equal(proof.concurrentClaims, 12);
  assert.equal(proof.encodingCapacity, 1);
  assert.equal(proof.rollbackProved, true);
  assert.equal(proof.scopedResetPreservationProved, true);
  assert.equal(proof.coordinatorCancellationRaceProved, true);
});
