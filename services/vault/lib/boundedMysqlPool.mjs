/** @file Bounded MySQL operations which retire uncertain connections instead of leaking pool slots. */

/**
 * Wrap a mysql2 promise pool without retrying writes whose outcome is unknown.
 * @param {object} pool Raw mysql2 pool.
 * @param {object} [options] Deadline settings.
 * @returns {object} Query/transaction-compatible bounded pool.
 */
export function boundedMysqlPool(pool, {acquireMs = 5000, queryMs = 30000, healthMs = 2000} = {}) {
  const timeoutError = (outcomeUnknown = true) => Object.assign(new Error("Database operation exceeded its deadline; the connection was retired."),
    {code: "STORE_TIMEOUT", status: 503, outcomeUnknown});
  const acquire = (ms) => new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(timeoutError(false)); }, ms);
    Promise.resolve().then(() => pool.getConnection()).then(connection => {
      clearTimeout(timer);
      if (expired) connection.release(); else resolve(connection);
    }, error => { clearTimeout(timer); if (!expired) reject(error); });
  });
  const wrap = connection => {
    let retired = false;
    const destroy = () => { if (!retired) { retired = true; connection.destroy(); } };
    const operation = (name, args, ms = queryMs) => new Promise((resolve, reject) => {
      if (retired) { reject(timeoutError()); return; }
      const timer = setTimeout(() => { destroy(); reject(timeoutError()); }, ms);
      Promise.resolve().then(() => connection[name](...args)).then(value => {
        clearTimeout(timer); resolve(value);
      }, error => {
        clearTimeout(timer);
        if (error?.fatal === true || ["PROTOCOL_CONNECTION_LOST", "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(error?.code)) destroy();
        reject(error);
      });
    });
    return {
      query: (...args) => operation("query", args),
      execute: (...args) => operation("execute", args),
      beginTransaction: () => operation("beginTransaction", []),
      commit: () => operation("commit", []),
      rollback: () => retired ? Promise.resolve() : operation("rollback", []),
      release: () => { if (!retired) { retired = true; connection.release(); } },
      destroy,
      health: () => operation("query", ["SELECT 1"], healthMs)
    };
  };
  const run = async (method, args, ms = acquireMs) => {
    const connection = wrap(await acquire(ms));
    try { return await connection[method](...args); } finally { connection.release(); }
  };
  return {
    query: (...args) => run("query", args),
    execute: (...args) => run("execute", args),
    getConnection: async () => wrap(await acquire(acquireMs)),
    health: () => run("health", [], healthMs),
    end: () => pool.end()
  };
}
