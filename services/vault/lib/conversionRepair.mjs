import {createHash} from "node:crypto";

const conflict = message => { throw Object.assign(new Error(message), {status: 409, code: "CONVERSION_CATALOG_CONFLICT"}); };
const canonical = value => value == null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const IDENTITY = ["id", "archivePath", "sourceUrl", "ingestRevision", "ingestManifestPath", "pageCount", "sourcePageCount",
  "ingestedPageCount", "expectedSegmentCount", "ingestedSegmentCount"];
const READINESS = ["ingestStatus", "ingestRevision", "ingestedPageCount", "ingestedAt", "ingestError", "ingestManifestPath",
  "sourcePageCount", "expectedSegmentCount", "ingestedSegmentCount", "segmentsReady"];

/** Fingerprint exactly the JSON-visible public chapter, including nulls and omitting undefined fields. */
export const conversionChapterFingerprint = chapter => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(chapter)))).digest("hex");

/** Validate an original accepted artifact against the locked current public chapter without replacing metadata. */
export const repairedConversionChapter = (job, desired, current, expectedFingerprint, normalize, now, {replay = false} = {}) => {
  const original = normalize(job.result.chapter || {});
  if (!current || original.id !== job.spec.input.chapterId || original.ingestStatus !== "ready" || original.segmentsReady !== true
    || original.sourcePageCount !== job.spec.input.sourcePageCount
    || IDENTITY.some(key => current[key] !== original[key] || desired[key] !== original[key]) || current.available !== true) {
    conflict("The completed artifact no longer matches the current chapter identity.");
  }
  if (replay) {
    if (current.ingestStatus !== "ready" || current.segmentsReady !== true) conflict("The repaired chapter is no longer reader-ready.");
    return current;
  }
  if (!["failed", "pending"].includes(current.ingestStatus) || conversionChapterFingerprint(current) !== expectedFingerprint) {
    conflict("The chapter changed after the repair snapshot was read.");
  }
  // DATETIME catalogues have second precision. Advance the checkpoint even for a same-second repair.
  const repairedAt = new Date(Math.max(Math.floor(now / 1000) * 1000, (Date.parse(current.updatedAt) || 0) + 1000)).toISOString();
  return {...current, ...Object.fromEntries(READINESS.map(key => [key, original[key]])), updatedAt: repairedAt};
};

/** Update only reader readiness inside the conversion transaction; retain current source and quality evidence. */
export const writeMysqlConversionRepair = async (connection, titleId, chapter) => {
  const mysqlDate = value => value ? new Date(value).toISOString().replace("T", " ").slice(0, 23) : null;
  await connection.query(`UPDATE raven_chapters SET ingest_status=?, ingest_revision=?, ingested_page_count=?, ingested_at=?,
    ingest_error=?, ingest_manifest_path=?, ingest_segments_json=?, updated_at=? WHERE title_id=? AND chapter_id=?`, [
    chapter.ingestStatus, chapter.ingestRevision, chapter.ingestedPageCount, mysqlDate(chapter.ingestedAt), chapter.ingestError || null,
    chapter.ingestManifestPath, JSON.stringify({sourcePageCount: chapter.sourcePageCount, expectedSegmentCount: chapter.expectedSegmentCount,
      ingestedSegmentCount: chapter.ingestedSegmentCount, segmentsReady: chapter.segmentsReady}), mysqlDate(chapter.updatedAt), titleId, chapter.id]);
  const [states] = await connection.query("SELECT ingest_status FROM raven_chapters WHERE title_id=?", [titleId]);
  const ready = states.filter(row => row.ingest_status === "ready").length;
  const status = ready === states.length ? "ready" : states.some(row => row.ingest_status === "failed") ? "failed" : "running";
  await connection.query("UPDATE raven_titles SET ingested_chapter_count=?, ingest_status=?, updated_at=? WHERE title_id=?",
    [ready, status, mysqlDate(chapter.updatedAt), titleId]);
};
