package com.scriptarr.raven.downloader;

import java.util.List;
import java.util.Map;

/**
 * Result payload returned by a provider-level bulk browse operation.
 *
 * @param titles normalized provider title entries
 * @param pagesScanned number of upstream browse pages inspected
 */
public record BulkBrowseResult(List<Map<String, String>> titles, int pagesScanned) {
    /**
     * Create an immutable browse result with safe defaults.
     *
     * @param titles normalized provider title entries
     * @param pagesScanned number of upstream browse pages inspected
     */
    public BulkBrowseResult {
        titles = titles == null ? List.of() : List.copyOf(titles);
        pagesScanned = Math.max(0, pagesScanned);
    }
}
