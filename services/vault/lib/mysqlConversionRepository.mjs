const parse = value => typeof value === "string" ? JSON.parse(value) : value;
const date = value => new Date(value).toISOString().slice(0, 23).replace("T", " ");
const FILTERS = new Map([["titleId", "title_id"], ["status", "status_name"]]);

/** MySQL-owned conversion transactions serialize through one durable pool row. */
export const createMysqlConversionRepository = pool => {
  const read = async (connection, id) => {
    const [rows] = await connection.query("SELECT record_json FROM raven_conversion_jobs WHERE job_id = ?", [id]);
    return rows[0] ? parse(rows[0].record_json) : null;
  };
  const list = async (connection, filters = {}, {runnable = false} = {}) => {
    const clauses = [], values = [];
    for (const [key, column] of FILTERS) if (filters[key]) { clauses.push(`${column} = ?`); values.push(filters[key]); }
    if (runnable) clauses.push("status_name IN ('queued', 'running')");
    const limit = runnable ? "" : ` LIMIT ${Math.min(10000, Math.max(1, Number.parseInt(filters.limit, 10) || 1000))}`;
    const [rows] = await connection.query(`SELECT record_json FROM raven_conversion_jobs${clauses.length ? " WHERE " + clauses.join(" AND ") : ""} ORDER BY created_at, job_id${limit}`, values);
    return rows.map(row => parse(row.record_json));
  };
  return {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS raven_conversion_pool (
        pool_id VARCHAR(64) PRIMARY KEY
      ) ENGINE=InnoDB`);
      await pool.query("INSERT IGNORE INTO raven_conversion_pool (pool_id) VALUES ('raven-webp-encode')");
      await pool.query(`CREATE TABLE IF NOT EXISTS raven_conversion_jobs (
        job_id VARCHAR(96) PRIMARY KEY, title_id VARCHAR(160) NOT NULL, chapter_id VARCHAR(160) NOT NULL,
        status_name VARCHAR(24) NOT NULL, record_json JSON NOT NULL,
        created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
        INDEX idx_conversion_runnable (status_name, created_at), INDEX idx_conversion_title (title_id)
      ) ENGINE=InnoDB`);
      await pool.query(`CREATE TABLE IF NOT EXISTS raven_conversion_claims (
        worker_id VARCHAR(160) NOT NULL, claim_id VARCHAR(160) NOT NULL, job_id VARCHAR(96) NOT NULL,
        epoch_value BIGINT UNSIGNED NOT NULL, token_hash CHAR(64) NOT NULL,
        PRIMARY KEY (worker_id, claim_id)
      ) ENGINE=InnoDB`);
      await pool.query(`CREATE TABLE IF NOT EXISTS raven_content_resets (
        operation_id VARCHAR(160) PRIMARY KEY, status_name VARCHAR(24) NOT NULL,
        scope_digest CHAR(64) NOT NULL, record_json JSON NOT NULL
      ) ENGINE=InnoDB`);
      await pool.query(`CREATE TABLE IF NOT EXISTS raven_conversion_workers (worker_id VARCHAR(160) PRIMARY KEY, record_json JSON NOT NULL) ENGINE=InnoDB`);
    },
    async get(id) { return read(pool, id); },
    async list(filters = {}) { return list(pool, filters); },
    async pool() {
      const [clock] = await pool.query("SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS now_ms");
      const [jobs] = await pool.query("SELECT status_name, JSON_UNQUOTE(JSON_EXTRACT(record_json, '$.lease.expiresAt')) AS expires_at FROM raven_conversion_jobs WHERE status_name IN ('queued','running','result-ready','publishing')");
      const [workers] = await pool.query("SELECT record_json FROM raven_conversion_workers ORDER BY worker_id");
      return {now: Number(clock[0].now_ms), jobs: jobs.map(j => ({status: j.status_name, expiresAt: j.expires_at})), workers: workers.map(w => parse(w.record_json))};
    },
    async transaction(action) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query("SELECT pool_id FROM raven_conversion_pool WHERE pool_id = 'raven-webp-encode' FOR UPDATE");
        const [clock] = await connection.query("SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS now_ms");
        const tx = {
          raw: connection, now: Number(clock[0].now_ms), afterCommit: () => { throw new Error("MySQL publication must use the current transaction."); },
          get: id => read(connection, id), list: () => list(connection, {}, {runnable: true}),
          async put(job) {
            await connection.query(`INSERT INTO raven_conversion_jobs (job_id, title_id, chapter_id, status_name, record_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status_name = VALUES(status_name), record_json = VALUES(record_json), updated_at = VALUES(updated_at)`,
            [job.jobId, job.spec.input.titleId, job.spec.input.chapterId, job.status, JSON.stringify(job), date(job.createdAt), date(job.updatedAt)]);
          },
          async getClaim(workerId, claimId) {
            const [rows] = await connection.query("SELECT job_id, epoch_value, token_hash FROM raven_conversion_claims WHERE worker_id = ? AND claim_id = ?", [workerId, claimId]);
            return rows[0] ? {jobId: rows[0].job_id, epoch: Number(rows[0].epoch_value), tokenHash: rows[0].token_hash} : null;
          },
          async putClaim(workerId, claimId, receipt) {
            await connection.query("INSERT INTO raven_conversion_claims (worker_id, claim_id, job_id, epoch_value, token_hash) VALUES (?, ?, ?, ?, ?)", [workerId, claimId, receipt.jobId, receipt.epoch, receipt.tokenHash]);
          },
          async getWorker(id) { const [rows] = await connection.query("SELECT record_json FROM raven_conversion_workers WHERE worker_id = ?", [id]); return rows[0] ? parse(rows[0].record_json) : null; },
          async putWorker(worker) { await connection.query("INSERT INTO raven_conversion_workers (worker_id,record_json) VALUES (?,?) ON DUPLICATE KEY UPDATE record_json=VALUES(record_json)", [worker.workerId, JSON.stringify(worker)]); },
          async isTitleFenced(titleId, owner = {}) {
            const [rows] = await connection.query("SELECT record_json FROM raven_content_resets WHERE status_name IN ('maintenance', 'catalog-cleared')");
            return rows.some(row => { const reset = parse(row.record_json); return (reset.fencedTitleIds || reset.titleIds).includes(titleId) || (owner.logicalKey && reset.logicalKeys.includes(owner.logicalKey)); });
          },
          async getReset(id) {
            const [rows] = await connection.query("SELECT record_json FROM raven_content_resets WHERE operation_id = ?", [id]);
            return rows[0] ? parse(rows[0].record_json) : null;
          },
          async putReset(reset) {
            await connection.query(`INSERT INTO raven_content_resets (operation_id, status_name, scope_digest, record_json) VALUES (?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE status_name = VALUES(status_name), record_json = VALUES(record_json)`, [reset.operationId, reset.status, reset.scopeDigest, JSON.stringify(reset)]);
          },
          async jobsForTitles(ids) {
            if (!ids.length) return [];
            const [rows] = await connection.query(`SELECT record_json FROM raven_conversion_jobs WHERE title_id IN (${ids.map(() => "?").join(",")})`, ids);
            return rows.map(row => parse(row.record_json));
          }
        };
        const result = await action(tx);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally { connection.release(); }
    }
  };
};
