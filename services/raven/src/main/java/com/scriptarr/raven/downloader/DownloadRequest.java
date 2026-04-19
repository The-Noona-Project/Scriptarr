package com.scriptarr.raven.downloader;

/**
 * Immutable request payload for a queued Raven download job.
 *
 * @param titleName human-readable series name
 * @param titleUrl source URL Raven should scrape
 * @param requestType media category requested by the caller
 * @param requestedBy user or system actor that queued the download
 */
public record DownloadRequest(
    String titleName,
    String titleUrl,
    String requestType,
    String requestedBy
) {
}
