/**
 * Supply the missing insertion default on the one retained legacy catalog timestamp.
 * Fresh schemas deliberately do not gain this legacy column. ALTER COLUMN SET DEFAULT
 * preserves stored timestamps, column type/precision/nullability, indexes and ON UPDATE clauses.
 *
 * @param {{query: Function}} pool Vault's current MySQL pool
 * @returns {Promise<{changed: boolean, precision?: number}>} whether legacy metadata was repaired
 */
export const ensureLegacyRavenCatalogDefaults = async (pool) => {
  const [rows] = await pool.query(`
    SELECT DATA_TYPE AS dataType, IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS columnDefault,
      DATETIME_PRECISION AS datetimePrecision, EXTRA AS extra
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
  `, ["raven_titles", "cataloged_at"]);
  const column = rows[0];
  if (!column || column.columnDefault !== null || column.isNullable !== "NO"
    || /\b(?:VIRTUAL|STORED)\s+GENERATED\b/i.test(String(column.extra || ""))) return {changed: false};
  const precision = Number(column.datetimePrecision);
  if (!["datetime", "timestamp"].includes(String(column.dataType).toLowerCase())
    || column.datetimePrecision === null || !Number.isInteger(precision) || precision < 0 || precision > 6) {
    throw new Error("Unsupported legacy raven_titles.cataloged_at definition; refusing to change its type or constraints.");
  }
  await pool.query(`ALTER TABLE \`raven_titles\` ALTER COLUMN \`cataloged_at\` SET DEFAULT (CURRENT_TIMESTAMP(${precision}))`);
  return {changed: true, precision};
};
