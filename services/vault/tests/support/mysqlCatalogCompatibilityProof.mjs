import assert from "node:assert/strict";
import fs from "node:fs";
import {randomUUID} from "node:crypto";
import mysql from "mysql2/promise";
import {createStore} from "../../lib/createStore.mjs";

const mysqlUrl = process.env.SCRIPTARR_TEST_MYSQL_URL;
assert.ok(mysqlUrl, "An isolated MySQL test URL is required.");
const parsed = new URL(mysqlUrl);
const admin = mysql.createPool(mysqlUrl);
const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
const source = fs.readFileSync(new URL("../../lib/createStore.mjs", import.meta.url), "utf8");
const start = source.indexOf("CREATE TABLE IF NOT EXISTS raven_titles (");
assert.ok(start > 0);
const createTitles = source.slice(start, source.indexOf("`", start));
const fixtures = [
  {name: "fresh"},
  {name: "legacy0", precision: 0},
  {name: "legacy3", precision: 3},
  {name: "legacy6", precision: 6},
  {name: "custom_default", precision: 3, defaultValue: "2001-01-01 00:00:00"},
  {name: "nullable", precision: 3, nullable: true}
];
const proof = {startedAt: new Date().toISOString(), passed: false, cases: []};
const columnFacts = async (pool) => {
  const [rows] = await pool.query(`SELECT DATA_TYPE AS dataType, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
    COLUMN_DEFAULT AS columnDefault, DATETIME_PRECISION AS datetimePrecision, EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'raven_titles' AND COLUMN_NAME = 'cataloged_at'`);
  return rows[0] || null;
};

try {
  const [[server]] = await admin.query("SELECT VERSION() AS version, @@SESSION.sql_mode AS sqlMode");
  assert.match(server.version, /^8\.4\./, "The compatibility proof must use MySQL 8.4.");
  assert.match(server.sqlMode, /STRICT_(?:TRANS|ALL)_TABLES/, "The proof must retain strict SQL mode.");
  proof.mysqlVersion = server.version;
  proof.strictSqlMode = true;
  for (const fixture of fixtures) {
    const database = "vault_catalog_" + fixture.name + "_" + suffix;
    await admin.query("CREATE DATABASE ??", [database]);
    const connection = {host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password), database};
    const inspector = mysql.createPool(connection);
    let before, oldValue;
    if (fixture.precision !== undefined) {
      const precision = fixture.precision ? `(${fixture.precision})` : "";
      const definition = `cataloged_at DATETIME${precision} ${fixture.nullable ? "NULL" : "NOT NULL"}`
        + (fixture.defaultValue ? ` DEFAULT '${fixture.defaultValue}'` : "") + " COMMENT 'retained legacy timestamp'";
      const at = createTitles.lastIndexOf(")");
      const sql = createTitles.slice(0, at) + ",\n" + definition + ",\nlegacy_marker VARCHAR(32) NOT NULL DEFAULT 'keep',\nINDEX idx_compat_cataloged (cataloged_at)\n" + createTitles.slice(at);
      await inspector.query(sql);
      await inspector.query(`INSERT INTO raven_titles
        (title_id,title,media_type,status_name,tags_json,aliases_json,relations_json,cataloged_at,legacy_marker,updated_at)
        VALUES ('existing','Existing retained title','manga','ongoing','[]','[]','[]','2024-01-02 03:04:05.123456','retained-record',NOW())`);
      before = await columnFacts(inspector);
      const [[row]] = await inspector.query("SELECT CAST(cataloged_at AS CHAR) AS timestampValue FROM raven_titles WHERE title_id='existing'");
      oldValue = row.timestampValue;
    }
    const store = createStore({driver: "mysql", mysql: connection});
    await store.init();
    const inserted = await store.upsertRavenTitle({id: "inserted", title: "Inserted compatibility title", mediaType: "manga", libraryTypeLabel: "Manga",
      libraryTypeSlug: "manga", status: "ongoing", chapterCount: 1, chaptersDownloaded: 1, tags: [], aliases: [], relations: []});
    assert.equal(inserted.id, "inserted");
    await store.upsertRavenChapter(inserted.id, {id: "chapter-1", label: "Chapter 1", chapterNumber: "1", pageCount: 1, available: true,
      archivePath: "/downloads/downloaded/manga/fixture/c001.cbz", qualityStatus: "clean", expectedPageCount: 1});
    assert.equal((await store.getRavenTitle(inserted.id)).chapters.length, 1);
    const after = await columnFacts(inspector);
    if (before) {
      assert.equal(after.dataType, before.dataType);
      assert.equal(after.columnType, before.columnType);
      assert.equal(after.isNullable, before.isNullable);
      assert.equal(after.datetimePrecision, before.datetimePrecision);
      assert.equal(after.comment, before.comment);
      assert.equal(after.extra.replace(/DEFAULT_GENERATED\s*/g, "").trim(), before.extra.replace(/DEFAULT_GENERATED\s*/g, "").trim());
      const [[retained]] = await inspector.query("SELECT CAST(cataloged_at AS CHAR) AS timestampValue, legacy_marker FROM raven_titles WHERE title_id='existing'");
      assert.equal(retained.timestampValue, oldValue);
      assert.equal(retained.legacy_marker, "retained-record");
      const [indexes] = await inspector.query("SHOW INDEX FROM raven_titles WHERE Key_name='idx_compat_cataloged'");
      assert.equal(indexes.length, 1);
      assert.equal(indexes[0].Column_name, "cataloged_at");
      if (fixture.defaultValue || fixture.nullable) assert.equal(after.columnDefault, before.columnDefault);
      else assert.match(String(after.columnDefault), /(?:current_timestamp|now)\s*\(/i);
      const [[newRow]] = await inspector.query("SELECT cataloged_at IS NULL AS missing, ABS(TIMESTAMPDIFF(SECOND,cataloged_at,NOW())) AS age FROM raven_titles WHERE title_id='inserted'");
      if (fixture.nullable) assert.equal(newRow.missing, 1);
      else if (!fixture.defaultValue) {assert.equal(newRow.missing, 0); assert.ok(newRow.age < 30);}
    } else assert.equal(after, null, "Fresh schemas must not gain cataloged_at.");
    await store.init();
    assert.deepEqual(await columnFacts(inspector), after, "Repeated Vault initialization must not change the compatibility metadata.");
    await store.upsertRavenTitle({...inserted, latestChapter: "2"});
    if (before) {
      const [[row]] = await inspector.query("SELECT CAST(cataloged_at AS CHAR) AS timestampValue FROM raven_titles WHERE title_id='existing'");
      assert.equal(row.timestampValue, oldValue);
    }
    proof.cases.push({name: fixture.name, passed: true, precision: fixture.precision ?? null, freshColumnAbsent: !before,
      titleAndChapterUpsertPassed: true, repeatedInitializationPassed: true, priorValuesAndConstraintsPreserved: true});
    await inspector.end();
  }
  proof.passed = true;
  proof.completedAt = new Date().toISOString();
  if (process.env.SCRIPTARR_TEST_PROOF_PATH) fs.writeFileSync(process.env.SCRIPTARR_TEST_PROOF_PATH, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
  await admin.end();
  // createStore intentionally retains long-lived service pools; this isolated proof process has completed all writes.
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
