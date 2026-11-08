const invalid = message => { throw Object.assign(new Error(message), {status: 409, code: "CONVERSION_CATALOG_CONFLICT"}); };

/** Validate the root publisher's whole-logical-page, all-segment checkpoint. */
export const validateConversionChapter = (job, chapter, normalize) => {
  const input = job.spec.input;
  if (chapter.id !== input.chapterId || chapter.sourcePageCount !== input.sourcePageCount || chapter.pageCount !== input.sourcePageCount
    || chapter.ingestedPageCount !== input.sourcePageCount || chapter.ingestStatus !== "ready"
    || chapter.available === false || !/^webp-[a-f0-9]{16}$/.test(chapter.ingestRevision || "")
    || !Number.isSafeInteger(chapter.expectedSegmentCount) || chapter.expectedSegmentCount < input.sourcePageCount
    || chapter.ingestedSegmentCount !== chapter.expectedSegmentCount || chapter.segmentsReady !== true
    || (job.result.artifact.segmentCount != null && chapter.expectedSegmentCount !== job.result.artifact.segmentCount)
    || typeof chapter.ingestManifestPath !== "string" || !chapter.ingestManifestPath.startsWith("/downloads/ingested/")
    || chapter.ingestManifestPath.split("/").includes("..") || !chapter.ingestManifestPath.endsWith("/manifest.json")) invalid("The published chapter does not match its complete conversion result.");
  const normalized = normalize(chapter);
  if (normalized.ingestStatus !== "ready") invalid("The published chapter is not reader-ready.");
  return normalized;
};

/** Persist a chapter inside the same MySQL transaction as conversion completion. */
export const writeMysqlConversionChapter = async (connection, titleId, chapter) => {
  const columns = ["title_id", "chapter_id", "label_name", "chapter_number", "page_count", "release_date", "is_available", "archive_path", "source_url",
    "quality_status", "expected_page_count", "missing_page_count", "missing_pages_json", "quality_notes_json", "ingest_status", "ingest_revision",
    "ingested_page_count", "ingested_at", "ingest_error", "ingest_manifest_path", "ingest_segments_json"];
  const mysqlDate = value => value ? new Date(value).toISOString().replace("T", " ").slice(0, 23) : null;
  const values = [titleId, chapter.id, chapter.label || chapter.id, chapter.chapterNumber || null, chapter.pageCount, chapter.releaseDate || null, 1,
    chapter.archivePath || null, chapter.sourceUrl || null, chapter.qualityStatus, chapter.expectedPageCount, chapter.missingPageCount,
    JSON.stringify(chapter.missingPages || []), JSON.stringify(chapter.qualityNotes || []), chapter.ingestStatus, chapter.ingestRevision,
    chapter.ingestedPageCount, mysqlDate(chapter.ingestedAt), chapter.ingestError || null, chapter.ingestManifestPath,
    JSON.stringify({sourcePageCount: chapter.sourcePageCount, expectedSegmentCount: chapter.expectedSegmentCount, ingestedSegmentCount: chapter.ingestedSegmentCount, segmentsReady: chapter.segmentsReady})];
  await connection.query(`INSERT INTO raven_chapters (${columns.join(",")}, updated_at) VALUES (${columns.map(() => "?").join(",")}, NOW())
    ON DUPLICATE KEY UPDATE ${columns.slice(2).map(column => `${column}=VALUES(${column})`).join(",")}, updated_at=NOW()`, values);
  const [states] = await connection.query("SELECT ingest_status FROM raven_chapters WHERE title_id = ?", [titleId]);
  const ready = states.filter(row => row.ingest_status === "ready").length;
  const status = ready === states.length ? "ready" : states.some(row => row.ingest_status === "failed") ? "failed" : "running";
  await connection.query("UPDATE raven_titles SET ingested_chapter_count=?, ingest_status=?, updated_at=NOW() WHERE title_id=?", [ready, status, titleId]);
  return chapter;
};
