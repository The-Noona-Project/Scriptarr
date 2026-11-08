import test from "node:test";
import assert from "node:assert/strict";
import {ensureLegacyRavenCatalogDefaults} from "../lib/legacyRavenCatalogCompatibility.mjs";

const fixture = (column) => {
  const queries = [];
  const pool = {query: async (sql, params) => {
    queries.push({sql, params});
    if (sql.includes("information_schema.COLUMNS")) return [column ? [column] : []];
    column.columnDefault = "CURRENT_TIMESTAMP";
    return [{affectedRows: 0}];
  }};
  return {pool, queries};
};

test("fresh modern schemas do not gain a redundant legacy timestamp column", async () => {
  const state = fixture(null);
  assert.deepEqual(await ensureLegacyRavenCatalogDefaults(state.pool), {changed: false});
  assert.equal(state.queries.length, 1);
  assert.deepEqual(state.queries[0].params, ["raven_titles", "cataloged_at"]);
});

test("the exact legacy required timestamp gains a precision-matched default only once", async () => {
  for (let precision = 0; precision <= 6; precision++) {
    const state = fixture({dataType: "datetime", isNullable: "NO", columnDefault: null, datetimePrecision: precision, extra: ""});
    assert.deepEqual(await ensureLegacyRavenCatalogDefaults(state.pool), {changed: true, precision});
    assert.equal(state.queries[1].sql, `ALTER TABLE \`raven_titles\` ALTER COLUMN \`cataloged_at\` SET DEFAULT (CURRENT_TIMESTAMP(${precision}))`);
    assert.deepEqual(await ensureLegacyRavenCatalogDefaults(state.pool), {changed: false});
    assert.equal(state.queries.filter(query => query.sql.startsWith("ALTER")).length, 1);
  }
});

test("existing defaults, nullable columns and generated columns remain untouched", async () => {
  for (const update of [{columnDefault: "2001-01-01 00:00:00"}, {columnDefault: "CURRENT_TIMESTAMP"},
    {isNullable: "YES"}, {extra: "STORED GENERATED"}, {extra: "VIRTUAL GENERATED"}]) {
    const state = fixture({dataType: "datetime", isNullable: "NO", columnDefault: null, datetimePrecision: 0, extra: "", ...update});
    assert.deepEqual(await ensureLegacyRavenCatalogDefaults(state.pool), {changed: false});
    assert.equal(state.queries.length, 1);
  }
});

test("the default-only statement never replaces type, constraints or existing ON UPDATE behavior", async () => {
  const state = fixture({dataType: "timestamp", isNullable: "NO", columnDefault: null, datetimePrecision: 6, extra: "on update CURRENT_TIMESTAMP(6)"});
  assert.deepEqual(await ensureLegacyRavenCatalogDefaults(state.pool), {changed: true, precision: 6});
  assert.equal(state.queries[1].sql, "ALTER TABLE `raven_titles` ALTER COLUMN `cataloged_at` SET DEFAULT (CURRENT_TIMESTAMP(6))");
  assert.doesNotMatch(state.queries[1].sql, /MODIFY|DROP|UPDATE\s+`?raven_titles|sql_mode/i);
});

test("unknown legacy types or invalid precision fail closed without schema mutation", async () => {
  for (const update of [{dataType: "varchar"}, {datetimePrecision: null}, {datetimePrecision: 7}, {datetimePrecision: -1}, {datetimePrecision: "bad"}]) {
    const state = fixture({dataType: "datetime", isNullable: "NO", columnDefault: null, datetimePrecision: 0, extra: "", ...update});
    await assert.rejects(ensureLegacyRavenCatalogDefaults(state.pool), /refusing to change its type or constraints/);
    assert.equal(state.queries.length, 1);
  }
});

test("metadata and ALTER failures are surfaced rather than silently leaving broken catalog writes", async () => {
  await assert.rejects(ensureLegacyRavenCatalogDefaults({query: async () => { throw new Error("metadata denied"); }}), /metadata denied/);
  const column = {dataType: "datetime", isNullable: "NO", columnDefault: null, datetimePrecision: 0, extra: ""};
  await assert.rejects(ensureLegacyRavenCatalogDefaults({query: async sql => {
    if (sql.includes("information_schema.COLUMNS")) return [[column]];
    throw new Error("DDL denied");
  }}), /DDL denied/);
});
