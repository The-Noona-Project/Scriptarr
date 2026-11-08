import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

test("MySQL completed-artifact repair atomically fences public snapshots, lost replies and rollback", {
  skip: !process.env.SCRIPTARR_TEST_MYSQL_URL, timeout: 180000
}, async () => {
  const {stdout} = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./support/mysqlConversionRepairProof.mjs", import.meta.url))], {
    env: process.env, timeout: 170000, maxBuffer: 1024 * 1024
  });
  const proof = JSON.parse(stdout.trim());
  assert.equal(proof.passed, true); assert.equal(proof.concurrentRepairs, 12); assert.equal(proof.publicSnapshotCas, true);
  assert.equal(proof.rollbackProved, true); assert.equal(proof.sameSecondMonotonicWrites, true);
  assert.equal(proof.repeatedFailureRepair, true); assert.equal(proof.supersededReplayRejected, true);
});
