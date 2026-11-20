/** @file Real database fault injection proves timed-out operations retire connections and roll back open transactions. */
import test from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import {boundedMysqlPool} from "../lib/boundedMysqlPool.mjs";

test("MySQL duplicate-key rejection preserves the transaction for conflict lookup and rollback", {skip: !process.env.SCRIPTARR_TEST_MYSQL_URL}, async () => {
  const pool = boundedMysqlPool(mysql.createPool({uri: process.env.SCRIPTARR_TEST_MYSQL_URL, connectionLimit: 1}));
  const connection = await pool.getConnection();
  try {
    await connection.query("CREATE TEMPORARY TABLE conflict_fixture (id INT PRIMARY KEY, request_id VARCHAR(20))");
    await connection.query("INSERT INTO conflict_fixture VALUES (1, 'accepted-request')");
    await connection.beginTransaction();
    await assert.rejects(connection.query("INSERT INTO conflict_fixture VALUES (1, 'duplicate-request')"), {code: "ER_DUP_ENTRY"});
    const [[row]] = await connection.query("SELECT request_id FROM conflict_fixture WHERE id=1");
    assert.equal(row.request_id, "accepted-request");
    await connection.rollback();
  } finally { connection.release(); await pool.end(); }
});

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
