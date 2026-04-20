package com.scriptarr.raven.downloader.providers;

import com.scriptarr.raven.downloader.BulkBrowseResult;
import com.scriptarr.raven.downloader.TitleDetails;

import java.util.List;
import java.util.Map;

/**
 * Site-specific Raven download provider contract.
 * Each upstream source owns its own search, title, chapter, and page scraping.
 */
public interface DownloadProvider {
    /**
     * Stable provider id used in settings and request snapshots.
     *
     * @return provider id
     */
    String id();

    /**
     * Human-readable provider name.
     *
     * @return display name
     */
    String name();

    /**
     * Determine whether the provider can handle a specific title URL.
     *
     * @param titleUrl source URL to inspect
     * @return {@code true} when the provider owns the URL
     */
    boolean supportsUrl(String titleUrl);

    /**
     * Search the provider for candidate titles.
     *
     * @param query user or metadata query
     * @return normalized provider results
     */
    List<Map<String, String>> searchTitles(String query);

    /**
     * Browse titles alphabetically for bulk queue operations such as the
     * Discord DM downloadall command.
     *
     * @param type normalized display type label
     * @param adultContent whether adult-only titles should be included
     * @param titlePrefix visible title prefix filter
     * @return normalized bulk browse result
     */
    default BulkBrowseResult browseTitlesAlphabetically(String type, boolean adultContent, String titlePrefix) {
        return new BulkBrowseResult(List.of(), 0);
    }

    /**
     * Load normalized source details for a provider title URL.
     *
     * @param titleUrl source URL to inspect
     * @return rich title details or {@code null}
     */
    TitleDetails getTitleDetails(String titleUrl);

    /**
     * Load the chapter list for a provider title URL.
     *
     * @param titleUrl source URL to inspect
     * @return normalized chapter list
     */
    List<Map<String, String>> getChapters(String titleUrl);

    /**
     * Resolve page image URLs for a provider chapter URL.
     *
     * @param chapterUrl chapter URL to inspect
     * @return normalized image URLs
     */
    List<String> resolvePages(String chapterUrl);
}
