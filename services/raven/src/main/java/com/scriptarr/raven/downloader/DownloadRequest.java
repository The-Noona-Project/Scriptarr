package com.scriptarr.raven.downloader;

public record DownloadRequest(
    String titleName,
    String titleUrl,
    String requestType,
    String requestedBy
) {
}
