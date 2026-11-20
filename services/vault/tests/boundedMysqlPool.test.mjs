/** @file Regression coverage for stalled database operations and late pool acquisition. */
import test from "node:test";
import assert from "node:assert/strict";
import {boundedMysqlPool} from "../lib/boundedMysqlPool.mjs";

test("timed-out writes destroy the underlying connection without retrying", async () => {
  let destroyed = 0, released = 0, queries = 0;
  const pool = boundedMysqlPool({getConnection: async () => ({
    query: () => { queries++; return new Promise(() => {}); },
    destroy: () => destroyed++, release: () => released++
  })}, {queryMs: 10});
  await assert.rejects(pool.query("INSERT INTO jobs VALUES (?)", [1]), {code: "STORE_TIMEOUT", outcomeUnknown: true});
  assert.equal(destroyed, 1); assert.equal(released, 0); assert.equal(queries, 1);
});

test("late acquired connections are released after the acquisition deadline", async () => {
  let finish, released = 0;
  const pool = boundedMysqlPool({getConnection: () => new Promise(resolve => { finish = resolve; })}, {acquireMs: 10});
  await assert.rejects(pool.query("SELECT 1"), {code: "STORE_TIMEOUT", outcomeUnknown: false});
  finish({release: () => released++});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 1);
});

test("transaction timeout retires the connection and cannot commit or retry it", async () => {
  let destroyed = 0, committed = 0;
  const pool = boundedMysqlPool({getConnection: async () => ({beginTransaction: async () => {},
    query: () => new Promise(() => {}), commit: async () => committed++, destroy: () => destroyed++, release: () => {}})}, {queryMs: 10});
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  await assert.rejects(connection.query("UPDATE jobs SET state='done'"), {code: "STORE_TIMEOUT"});
  await connection.rollback();
  await assert.rejects(connection.commit(), {code: "STORE_TIMEOUT"});
  connection.release(); assert.equal(destroyed, 1); assert.equal(committed, 0);
});

test("health has its own short deadline and healthy operations release their connection", async () => {
  let releases = 0, destroys = 0;
  const pool = boundedMysqlPool({getConnection: async () => ({query: sql => sql === "SELECT 1" ? new Promise(() => {}) : Promise.resolve([[]]),
    destroy: () => destroys++, release: () => releases++})}, {healthMs: 10});
  await pool.query("SELECT name FROM jobs");
  await assert.rejects(pool.health(), {code: "STORE_TIMEOUT"});
  assert.equal(releases, 1); assert.equal(destroys, 1);
});
