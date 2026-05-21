package com.scriptarr.raven.library;

import java.util.List;

/**
 * Result of converting one CBZ chapter into reader-ready WebP pages.
 */
public record LibraryIngestResult(
    String status,
    String revision,
    int pageCount,
    String ingestedAt,
    String manifestPath,
    List<String> pageSlugs
) {
    /**
     * Create an immutable ingest result.
     */
    public LibraryIngestResult {
        status = status == null || status.isBlank() ? "ready" : status;
        revision = revision == null ? "" : revision;
        pageCount = Math.max(0, pageCount);
        manifestPath = manifestPath == null ? "" : manifestPath;
        pageSlugs = pageSlugs == null ? List.of() : List.copyOf(pageSlugs);
    }
}
