package com.scriptarr.raven.settings;

/**
 * Runtime tuning for Raven title-level download workers.
 *
 * @param activeTitleDownloads number of title downloads Raven may run at once
 */
public record RavenDownloadRuntimeSettings(int activeTitleDownloads) {
    public static final int MIN_ACTIVE_TITLE_DOWNLOADS = 1;
    public static final int MAX_ACTIVE_TITLE_DOWNLOADS = 6;
    public static final int DEFAULT_ACTIVE_TITLE_DOWNLOADS = 2;

    /**
     * Clamp a requested title-download worker count into the supported range.
     *
     * @param value requested active title downloads
     * @return safe active title download count
     */
    public static int normalizeActiveTitleDownloads(int value) {
        return Math.max(MIN_ACTIVE_TITLE_DOWNLOADS, Math.min(MAX_ACTIVE_TITLE_DOWNLOADS, value));
    }

    /**
     * Return a normalized copy of these runtime settings.
     *
     * @return safe runtime settings
     */
    public RavenDownloadRuntimeSettings normalized() {
        return new RavenDownloadRuntimeSettings(normalizeActiveTitleDownloads(activeTitleDownloads));
    }

    /**
     * Build the default runtime settings.
     *
     * @return default runtime settings
     */
    public static RavenDownloadRuntimeSettings defaults() {
        return new RavenDownloadRuntimeSettings(DEFAULT_ACTIVE_TITLE_DOWNLOADS);
    }
}
