import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

test("MySQL 8.4 fresh and retained catalogs accept real Vault upserts after idempotent initialization", {
  skip: !process.env.SCRIPTARR_TEST_MYSQL_URL,
  timeout: 300000
}, async () => {
  const {stdout} = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./support/mysqlCatalogCompatibilityProof.mjs", import.meta.url))], {
    env: process.env, timeout: 290000, maxBuffer: 2 * 1024 * 1024
  });
  const proof = JSON.parse(stdout.trim());
  assert.equal(proof.passed, true);
  assert.equal(proof.cases.length, 6);
  assert.ok(proof.cases.every(entry => entry.passed));
});
