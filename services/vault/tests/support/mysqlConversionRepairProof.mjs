import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import mysql from "mysql2/promise";
import {createStore} from "../../lib/createStore.mjs";
import {proveConversionRepair} from "./conversionRepairProof.mjs";

try {
  const parsed = new URL(process.env.SCRIPTARR_TEST_MYSQL_URL), database = "vault_conversion_" + randomUUID().replaceAll("-", "");
  const admin = mysql.createPool(process.env.SCRIPTARR_TEST_MYSQL_URL);
  const config = {driver: "mysql", mysql: {host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database}};
  const first = createStore(config), second = createStore(config);
  let inspector;
  try {
    const [[server]] = await admin.query("SELECT VERSION() AS version, @@SESSION.sql_mode AS sqlMode");
    assert.match(server.version, /^8\.4\./); assert.match(server.sqlMode, /STRICT_(?:TRANS|ALL)_TABLES/);
    await admin.query("CREATE DATABASE ??", [database]); inspector = mysql.createPool(config.mysql);
    await first.init(); await second.init();
    const proof = await proveConversionRepair(first, second, {
      async rollback({jobId, body, failed, get}) {
        await inspector.query("CREATE TRIGGER repair_fixture_reject BEFORE UPDATE ON raven_conversion_jobs FOR EACH ROW BEGIN IF JSON_CONTAINS_PATH(NEW.record_json,'one','$._repairReceipts') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated repair rollback'; END IF; END");
        await assert.rejects(first.completeConversionJob(jobId, body), /isolated repair rollback/);
        assert.deepEqual(await get(), failed, "Post-catalog receipt failure must roll back readiness, quality and fresh timestamp together.");
        const [[row]] = await inspector.query("SELECT record_json FROM raven_conversion_jobs WHERE job_id=?", [jobId]);
        const record = typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json;
        assert.equal(record._repairReceipts, undefined);
        await inspector.query("DROP TRIGGER repair_fixture_reject");
      },
      async inspect({jobId, original}) {
        const [[row]] = await inspector.query("SELECT record_json FROM raven_conversion_jobs WHERE job_id=?", [jobId]);
        const record = typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json;
        assert.equal(Object.keys(record._repairReceipts).length, 2);
        assert.equal(record._completionHash.length, 64);
        assert.deepEqual(record.result, original.job.result); assert.equal(record.finishedAt, original.job.finishedAt);
        // Two real brokers writing one row must observe distinct locked checkpoints even in the same DB second.
        const current = (await first.getRavenTitle("completed-repair-title")).chapters[0];
        const writes = await Promise.all([first.upsertRavenChapter("completed-repair-title", {...current, label: "Concurrent A"}),
          second.upsertRavenChapter("completed-repair-title", {...current, label: "Concurrent B"})]);
        assert.notEqual(writes[0].updatedAt, writes[1].updatedAt);
        second.clearCache();
        const title = await second.getRavenTitle("completed-repair-title");
        const before = title.chapters[0].updatedAt;
        await first.replaceRavenChapters(title.id, title.chapters);
        second.clearCache();
        assert.equal((await second.getRavenTitle(title.id)).chapters[0].updatedAt, before, "Unchanged replacement must retain the checkpoint timestamp.");
      }
    });
    console.log(JSON.stringify({passed: true, ...proof, rollbackProved: true, sameSecondMonotonicWrites: true, mysqlVersion: server.version}));
  } finally {
    await first.close?.(); await second.close?.(); await inspector?.end();
    if (/^vault_conversion_[a-f0-9]{32}$/.test(database)) await admin.query("DROP DATABASE IF EXISTS ??", [database]);
    await admin.end();
  }
  process.exit(0);
} catch (error) { console.error(error.stack); process.exit(1); }
