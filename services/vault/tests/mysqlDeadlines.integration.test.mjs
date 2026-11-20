/** @file Real database fault injection proves timed-out operations retire connections and roll back open transactions. */
import test from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import {boundedMysqlPool} from "../lib/boundedMysqlPool.mjs";

test("MySQL stalled statements retire their connection and a subsequent health check recovers", {skip: !process.env.SCRIPTARR_TEST_MYSQL_URL}, async () => {
  const raw = mysql.createPool({uri: process.env.SCRIPTARR_TEST_MYSQL_URL, connectionLimit: 1});
  const pool = boundedMysqlPool(raw, {queryMs: 100, acquireMs: 2000, healthMs: 2000});
  try {
    await pool.query("SELECT 1");
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    await assert.rejects(connection.query("SELECT SLEEP(5)"), {code: "STORE_TIMEOUT", outcomeUnknown: true});
    await connection.rollback();
    await assert.rejects(connection.commit(), {code: "STORE_TIMEOUT"});
    connection.release();
    assert.equal((await pool.health())[0][0]["1"], 1);
  } finally { await pool.end(); }
});
