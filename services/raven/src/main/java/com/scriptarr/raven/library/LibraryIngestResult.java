package com.scriptarr.raven.library;

import java.util.List;

/**
 * Result of converting one CBZ chapter into reader-ready derived pages.
 */
public record LibraryIngestResult(
    String status,
    String revision,
    int pageCount,
    String ingestedAt,
    String manifestPath,
    List<String> pageSlugs,
    String conversionJobId,
    long conversionEpoch,
    String artifactSha256
) {
    /**
     * Preserve the local-ingest result constructor for existing integrations.
     * @param status ingest state
     * @param revision output revision
     * @param pageCount logical page count
     * @param ingestedAt completion timestamp
     * @param manifestPath saved manifest
     * @param pageSlugs legacy page filenames
     */
    public LibraryIngestResult(String status, String revision, int pageCount, String ingestedAt, String manifestPath, List<String> pageSlugs) {
        this(status, revision, pageCount, ingestedAt, manifestPath, pageSlugs, "", 0L, "");
    }
    /**
     * Create an immutable ingest result.
     */
    public LibraryIngestResult {
        status = status == null || status.isBlank() ? "ready" : status;
        revision = revision == null ? "" : revision;
        pageCount = Math.max(0, pageCount);
        manifestPath = manifestPath == null ? "" : manifestPath;
        pageSlugs = pageSlugs == null ? List.of() : List.copyOf(pageSlugs);
        conversionJobId = conversionJobId == null ? "" : conversionJobId;
        artifactSha256 = artifactSha256 == null ? "" : artifactSha256;
    }
}
