package com.scriptarr.raven.downloader;

import java.util.List;

/**
 * Summary payload returned when Raven bulk-queues titles for the Discord DM
 * downloadall flow.
 *
 * @param status normalized queue outcome
 * @param message human-readable queue summary
 * @param filters normalized request filters
 * @param pagesScanned number of browse pages inspected
 * @param matchedCount number of matched upstream titles
 * @param queuedCount number of titles queued
 * @param skippedActiveCount number of active titles skipped
 * @param skippedNoMetadataCount number of titles skipped because no confident metadata match was found
 * @param skippedAmbiguousMetadataCount number of titles skipped because metadata resolution was ambiguous
 * @param failedCount number of titles that failed to queue
 * @param queuedTitles queued title names
 * @param skippedActiveTitles skipped active title names
 * @param skippedNoMetadataTitles skipped title names without confident metadata
 * @param skippedAmbiguousMetadataTitles skipped title names with ambiguous metadata
 * @param failedTitles failed title names
 */
public record BulkQueueDownloadResult(
    String status,
    String message,
    Filters filters,
    int pagesScanned,
    int matchedCount,
    int queuedCount,
    int skippedActiveCount,
    int skippedNoMetadataCount,
    int skippedAmbiguousMetadataCount,
    int failedCount,
    List<String> queuedTitles,
    List<String> skippedActiveTitles,
    List<String> skippedNoMetadataTitles,
    List<String> skippedAmbiguousMetadataTitles,
    List<String> failedTitles
) {
    public static final String STATUS_INVALID_REQUEST = "invalid_request";
    public static final String STATUS_QUEUED = "queued";
    public static final String STATUS_PARTIAL = "partial";
    public static final String STATUS_ALREADY_ACTIVE = "already_active";
    public static final String STATUS_EMPTY_RESULTS = "empty_results";

    /**
     * Create an immutable bulk queue summary with safe list defaults.
     *
     * @param status normalized queue outcome
     * @param message human-readable queue summary
     * @param filters normalized request filters
     * @param pagesScanned number of browse pages inspected
     * @param matchedCount number of matched upstream titles
     * @param queuedCount number of titles queued
     * @param skippedActiveCount number of active titles skipped
     * @param skippedNoMetadataCount number of titles skipped because no confident metadata match was found
     * @param skippedAmbiguousMetadataCount number of titles skipped because metadata resolution was ambiguous
     * @param failedCount number of titles that failed to queue
     * @param queuedTitles queued title names
     * @param skippedActiveTitles skipped active title names
     * @param skippedNoMetadataTitles skipped title names without confident metadata
     * @param skippedAmbiguousMetadataTitles skipped title names with ambiguous metadata
     * @param failedTitles failed title names
     */
    public BulkQueueDownloadResult {
        status = status == null || status.isBlank() ? STATUS_INVALID_REQUEST : status;
        message = message == null ? "" : message;
        filters = filters == null ? new Filters("", false, "") : filters;
        pagesScanned = Math.max(0, pagesScanned);
        matchedCount = Math.max(0, matchedCount);
        queuedCount = Math.max(0, queuedCount);
        skippedActiveCount = Math.max(0, skippedActiveCount);
        skippedNoMetadataCount = Math.max(0, skippedNoMetadataCount);
        skippedAmbiguousMetadataCount = Math.max(0, skippedAmbiguousMetadataCount);
        failedCount = Math.max(0, failedCount);
        queuedTitles = queuedTitles == null ? List.of() : List.copyOf(queuedTitles);
        skippedActiveTitles = skippedActiveTitles == null ? List.of() : List.copyOf(skippedActiveTitles);
        skippedNoMetadataTitles = skippedNoMetadataTitles == null ? List.of() : List.copyOf(skippedNoMetadataTitles);
        skippedAmbiguousMetadataTitles = skippedAmbiguousMetadataTitles == null ? List.of() : List.copyOf(skippedAmbiguousMetadataTitles);
        failedTitles = failedTitles == null ? List.of() : List.copyOf(failedTitles);
    }

    /**
     * Normalized request filters used by the Discord DM bulk queue flow.
     *
     * @param type display label for the requested title type
     * @param nsfw whether adult titles should be included
     * @param titlePrefix title prefix filter
     */
    public record Filters(String type, boolean nsfw, String titlePrefix) {
        /**
         * Create immutable filters with string defaults.
         *
         * @param type display label for the requested title type
         * @param nsfw whether adult titles should be included
         * @param titlePrefix title prefix filter
         */
        public Filters {
            type = type == null ? "" : type;
            titlePrefix = titlePrefix == null ? "" : titlePrefix;
        }
    }
}
