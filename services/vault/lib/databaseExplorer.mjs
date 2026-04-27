/**
 * @file Safe database explorer helpers for Vault-owned Scriptarr storage.
 */

const KNOWN_TABLES = Object.freeze([
  "users",
  "permission_groups",
  "user_permission_groups",
  "api_keys",
  "sessions",
  "settings",
  "requests",
  "request_work_locks",
  "media_progress",
  "media_title_state",
  "media_chapter_reads",
  "secrets",
  "raven_titles",
  "raven_chapters",
  "raven_download_tasks",
  "raven_metadata_matches",
  "vault_jobs",
  "vault_job_tasks",
  "vault_events"
]);

const TABLE_DESCRIPTIONS = Object.freeze({
  users: "Discord-linked users and derived access footprint.",
  permission_groups: "Reusable permission groups and admin grants.",
  user_permission_groups: "Assignments from users to permission groups.",
  api_keys: "System and personal API key records.",
  sessions: "Moon session tokens.",
  settings: "Brokered service and admin JSON settings.",
  requests: "Moderated Moon and Discord title requests.",
  request_work_locks: "Active duplicate-prevention request locks.",
  media_progress: "Reader chapter progress and bookmarks.",
  media_title_state: "Per-user title started/completed state.",
  media_chapter_reads: "Per-user chapter read acknowledgements.",
  secrets: "Vault-owned secret values.",
  raven_titles: "Brokered Raven library title catalog.",
  raven_chapters: "Brokered Raven chapter catalog.",
  raven_download_tasks: "Brokered Raven download task state.",
  raven_metadata_matches: "Brokered Raven metadata match snapshots.",
  vault_jobs: "Durable cross-service job records.",
  vault_job_tasks: "Durable cross-service job task records.",
  vault_events: "Durable admin and service event timeline."
});

const SENSITIVE_COLUMN_PATTERN = /(token|secret|secret_value|password|key_hash|api_key|hash)$/i;
const SENSITIVE_JSON_KEY_PATTERN = /^(token|secret|password|apiKey|keyHash|key_hash|dataBase64)$/i;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_SETTING_VALUE_BYTES = 1024 * 1024;

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeInteger = (value, fallback, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) => {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
};

const nowIso = () => new Date().toISOString();

const parseMaybeJson = (value) => {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0])) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const redactJsonValue = (value, key = "") => {
  if (SENSITIVE_JSON_KEY_PATTERN.test(key)) {
    return key === "dataBase64" ? "[image data omitted]" : "[redacted]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactJsonValue(entryValue, entryKey)
    ]));
  }
  return value;
};

const redactCellValue = (columnName, value) => {
  if (SENSITIVE_COLUMN_PATTERN.test(columnName)) {
    return "[redacted]";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return `[buffer:${value.length}]`;
  }
  return redactJsonValue(parseMaybeJson(value), columnName);
};

const sanitizeRows = (rows = []) => rows.map((row) =>
  Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, redactCellValue(key, value)]))
);

const summarizeTable = ({name, rowCount = 0, dataBytes = 0, indexBytes = 0}) => ({
  name,
  description: TABLE_DESCRIPTIONS[name] || "Scriptarr table.",
  rowCount: Number(rowCount) || 0,
  dataBytes: Number(dataBytes) || 0,
  indexBytes: Number(indexBytes) || 0,
  totalBytes: (Number(dataBytes) || 0) + (Number(indexBytes) || 0),
  editable: name === "settings"
});

const flattenMapValues = (map) => Array.from(map?.values?.() || []);

const memoryRowsForTable = (state, tableName) => {
  switch (tableName) {
    case "users":
      return flattenMapValues(state.users);
    case "permission_groups":
      return flattenMapValues(state.permissionGroups);
    case "user_permission_groups":
      return Array.from(state.userGroupAssignments.entries()).flatMap(([discordUserId, groupIds]) =>
        Array.from(groupIds || []).map((groupId) => ({discordUserId, groupId}))
      );
    case "api_keys":
      return flattenMapValues(state.apiKeys);
    case "sessions":
      return flattenMapValues(state.sessions);
    case "settings":
      return flattenMapValues(state.settings).map((entry) => ({
        setting_key: entry.key,
        setting_value: entry.value,
        updated_at: entry.updatedAt
      }));
    case "secrets":
      return flattenMapValues(state.secrets).map((entry) => ({
        secret_key: entry.key,
        secret_value: entry.value,
        updated_at: entry.updatedAt
      }));
    case "requests":
      return flattenMapValues(state.requests);
    case "request_work_locks":
      return flattenMapValues(state.requestWorkLocks);
    case "media_progress":
      return flattenMapValues(state.progress);
    case "media_title_state":
      return flattenMapValues(state.titleReadStates);
    case "media_chapter_reads":
      return flattenMapValues(state.chapterReadStates);
    case "raven_titles":
      return flattenMapValues(state.ravenTitles);
    case "raven_chapters":
      return Array.from(state.ravenChapters.values()).flatMap((chapters) => flattenMapValues(chapters));
    case "raven_download_tasks":
      return flattenMapValues(state.ravenDownloadTasks);
    case "raven_metadata_matches":
      return flattenMapValues(state.ravenMetadataMatches);
    case "vault_jobs":
      return flattenMapValues(state.jobs);
    case "vault_job_tasks":
      return flattenMapValues(state.jobTasks);
    case "vault_events":
      return flattenMapValues(state.events);
    default:
      return [];
  }
};

const normalizeTableName = (value) => {
  const tableName = normalizeString(value).toLowerCase();
  return KNOWN_TABLES.includes(tableName) ? tableName : "";
};

const estimateJsonBytes = (value) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");

const filterRowsByQuery = (rows, query) => {
  const normalizedQuery = normalizeString(query).toLowerCase();
  if (!normalizedQuery) {
    return rows;
  }
  return rows.filter((row) => JSON.stringify(row || {}).toLowerCase().includes(normalizedQuery));
};

const columnsFromRows = (rows = []) => Array.from(new Set(rows.flatMap((row) => Object.keys(row || {}))))
  .map((name) => ({
    name,
    type: "json",
    nullable: true,
    redacted: SENSITIVE_COLUMN_PATTERN.test(name)
  }));

/**
 * Build a safe table/size overview for the in-memory Vault store.
 *
 * @param {Record<string, any>} state
 * @returns {any}
 */
export const buildMemoryDatabaseOverview = (state) => {
  const tables = KNOWN_TABLES.map((name) => {
    const rows = memoryRowsForTable(state, name);
    return summarizeTable({
      name,
      rowCount: rows.length,
      dataBytes: rows.reduce((sum, row) => sum + estimateJsonBytes(row), 0),
      indexBytes: 0
    });
  });
  return {
    driver: "memory",
    database: "memory",
    generatedAt: nowIso(),
    tableCount: tables.length,
    rowCount: tables.reduce((sum, table) => sum + table.rowCount, 0),
    totalBytes: tables.reduce((sum, table) => sum + table.totalBytes, 0),
    tables
  };
};

/**
 * Read one safe table page from the in-memory Vault store.
 *
 * @param {Record<string, any>} state
 * @param {string} tableName
 * @param {{limit?: number, offset?: number, query?: string}} [options]
 * @returns {any}
 */
export const readMemoryDatabaseTable = (state, tableName, options = {}) => {
  const normalizedTableName = normalizeTableName(tableName);
  if (!normalizedTableName) {
    return null;
  }
  const limit = normalizeInteger(options.limit, DEFAULT_LIMIT, {min: 1, max: MAX_LIMIT});
  const offset = normalizeInteger(options.offset, 0, {min: 0});
  const allRows = filterRowsByQuery(memoryRowsForTable(state, normalizedTableName), options.query);
  const rows = sanitizeRows(allRows.slice(offset, offset + limit));
  return {
    table: summarizeTable({
      name: normalizedTableName,
      rowCount: allRows.length,
      dataBytes: allRows.reduce((sum, row) => sum + estimateJsonBytes(row), 0),
      indexBytes: 0
    }),
    columns: columnsFromRows(allRows),
    rows,
    limit,
    offset,
    query: normalizeString(options.query),
    totalRows: allRows.length
  };
};

const quoteIdentifier = (value) => `\`${String(value).replaceAll("`", "``")}\``;

const readMysqlColumns = async (pool, database, tableName) => {
  const [rows] = await pool.query(`
    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY
    FROM information_schema.columns
    WHERE table_schema = ? AND table_name = ?
    ORDER BY ORDINAL_POSITION ASC
  `, [database, tableName]);
  return rows.map((row) => ({
    name: row.COLUMN_NAME,
    type: row.DATA_TYPE,
    nullable: row.IS_NULLABLE === "YES",
    key: row.COLUMN_KEY || "",
    redacted: SENSITIVE_COLUMN_PATTERN.test(row.COLUMN_NAME)
  }));
};

const searchableColumns = (columns) => columns
  .filter((column) => ["char", "varchar", "text", "longtext", "mediumtext", "json"].includes(String(column.type || "").toLowerCase()))
  .map((column) => column.name);

const buildMysqlSearchClause = (columns, query) => {
  const normalizedQuery = normalizeString(query);
  const searchColumns = searchableColumns(columns);
  if (!normalizedQuery || !searchColumns.length) {
    return {whereSql: "", params: []};
  }
  return {
    whereSql: `WHERE ${searchColumns.map((columnName) => `CAST(${quoteIdentifier(columnName)} AS CHAR) LIKE ?`).join(" OR ")}`,
    params: searchColumns.map(() => `%${normalizedQuery}%`)
  };
};

/**
 * Build a safe table/size overview for the MySQL Vault store.
 *
 * @param {import("mysql2/promise").Pool} pool
 * @param {string} database
 * @returns {Promise<any>}
 */
export const buildMysqlDatabaseOverview = async (pool, database) => {
  const [infoRows] = await pool.query(`
    SELECT table_name, data_length, index_length
    FROM information_schema.tables
    WHERE table_schema = ?
  `, [database]);
  const infoByName = new Map(infoRows.map((row) => [String(row.table_name || row.TABLE_NAME), row]));
  const tables = await Promise.all(KNOWN_TABLES.map(async (name) => {
    if (!infoByName.has(name)) {
      return summarizeTable({name});
    }
    const [countRows] = await pool.query(`SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(name)}`);
    const info = infoByName.get(name) || {};
    return summarizeTable({
      name,
      rowCount: countRows[0]?.row_count || 0,
      dataBytes: info.data_length || info.DATA_LENGTH || 0,
      indexBytes: info.index_length || info.INDEX_LENGTH || 0
    });
  }));
  return {
    driver: "mysql",
    database,
    generatedAt: nowIso(),
    tableCount: tables.length,
    rowCount: tables.reduce((sum, table) => sum + table.rowCount, 0),
    totalBytes: tables.reduce((sum, table) => sum + table.totalBytes, 0),
    tables
  };
};

/**
 * Read one safe table page from the MySQL Vault store.
 *
 * @param {import("mysql2/promise").Pool} pool
 * @param {string} database
 * @param {string} tableName
 * @param {{limit?: number, offset?: number, query?: string}} [options]
 * @returns {Promise<any | null>}
 */
export const readMysqlDatabaseTable = async (pool, database, tableName, options = {}) => {
  const normalizedTableName = normalizeTableName(tableName);
  if (!normalizedTableName) {
    return null;
  }
  const columns = await readMysqlColumns(pool, database, normalizedTableName);
  if (!columns.length) {
    return null;
  }
  const limit = normalizeInteger(options.limit, DEFAULT_LIMIT, {min: 1, max: MAX_LIMIT});
  const offset = normalizeInteger(options.offset, 0, {min: 0});
  const {whereSql, params} = buildMysqlSearchClause(columns, options.query);
  const orderColumn = columns.find((column) => column.key === "PRI")?.name || columns[0].name;
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(normalizedTableName)} ${whereSql}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT * FROM ${quoteIdentifier(normalizedTableName)} ${whereSql} ORDER BY ${quoteIdentifier(orderColumn)} ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const overview = await buildMysqlDatabaseOverview(pool, database);
  return {
    table: overview.tables.find((table) => table.name === normalizedTableName) || summarizeTable({name: normalizedTableName}),
    columns,
    rows: sanitizeRows(rows),
    limit,
    offset,
    query: normalizeString(options.query),
    totalRows: Number(countRows[0]?.row_count || 0)
  };
};

/**
 * Validate a settings-table update from the database explorer.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {{key: string, value: unknown}}
 */
export const normalizeDatabaseSettingUpdate = (key, value) => {
  const normalizedKey = normalizeString(key);
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(normalizedKey)) {
    const error = new Error("Invalid settings key.");
    error.code = "DATABASE_SETTING_INVALID";
    throw error;
  }
  const encoded = JSON.stringify(value);
  if (encoded == null || Buffer.byteLength(encoded, "utf8") > MAX_SETTING_VALUE_BYTES) {
    const error = new Error("Settings value is too large or not JSON serializable.");
    error.code = "DATABASE_SETTING_INVALID";
    throw error;
  }
  return {key: normalizedKey, value};
};

export default {
  buildMemoryDatabaseOverview,
  buildMysqlDatabaseOverview,
  normalizeDatabaseSettingUpdate,
  readMemoryDatabaseTable,
  readMysqlDatabaseTable
};
