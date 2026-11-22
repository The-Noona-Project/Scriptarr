/** @file Additional modern content state owned by the full, account-preserving library reset. */
export const CONTENT_NOTIFICATION_KINDS = Object.freeze(["portal-downloadall-delivery", "portal-downloadall-prompt", "portal-downloadall-action"]);

/** Select content jobs without clearing AI, trivia, update, or other service jobs. */
export const isContentResetJob = job => job?.ownerService === "scriptarr-raven"
  || (job?.ownerService === "scriptarr-sage" && CONTENT_NOTIFICATION_KINDS.includes(job.kind));

/** Fixed SQL scope; never assembled from a caller's input. */
export const CONTENT_RESET_JOB_SQL = "(owner_service = 'scriptarr-raven' OR (owner_service = 'scriptarr-sage' AND job_kind IN ('portal-downloadall-delivery','portal-downloadall-prompt','portal-downloadall-action')))";

const TABLES = Object.freeze({ravenTitleAliases: "raven_title_aliases", conversionClaims: "raven_conversion_claims", conversionJobs: "raven_conversion_jobs", contentResetOperations: "raven_content_resets"});

/** Count the additional tables while preserving worker registrations and the encoding-pool identity. */
export async function previewFullResetExtras(connection) {
  const counts = {};
  for (const [key, table] of Object.entries(TABLES)) {
    const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM ${table}`);
    counts[key] = Number(rows[0]?.count || 0);
  }
  return counts;
}

/** Clear additional content tables inside the caller's encoding-pool-locked transaction. */
export async function clearFullResetExtras(connection) {
  for (const table of Object.values(TABLES)) await connection.query(`DELETE FROM ${table}`);
}
