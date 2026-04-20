package com.scriptarr.raven.downloader;

import java.util.Map;

/**
 * Immutable request payload for a queued Raven download job.
 *
 * @param titleName human-readable series name
 * @param titleUrl source URL Raven should scrape
 * @param requestType media category requested by the caller
 * @param requestedBy user or system actor that queued the download
 * @param providerId download provider id selected during intake
 * @param requestId linked moderated request id when the queue came from intake
 * @param selectedMetadata saved metadata snapshot from intake
 * @param selectedDownload saved download snapshot from intake
 * @param priority relative Raven queue priority
 */
public record DownloadRequest(
    String titleName,
    String titleUrl,
    String requestType,
    String requestedBy,
    String providerId,
    String requestId,
    Map<String, Object> selectedMetadata,
    Map<String, Object> selectedDownload,
    String priority
) {
}
