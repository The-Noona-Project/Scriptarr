package com.scriptarr.raven.downloader.providers;

import com.scriptarr.raven.downloader.BulkBrowseResult;
import com.scriptarr.raven.downloader.ChapterDiscoveryResult;
import com.scriptarr.raven.downloader.TitleDetails;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;
import java.util.function.IntConsumer;

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
     * Browse with cooperative cancellation and a completed-page progress callback.
     *
     * @param type exact requested type
     * @param adultContent whether adult content is allowed
     * @param titlePrefix visible title prefix
     * @param cancelled cancellation predicate
     * @param progress completed-page callback
     * @return complete browse result
     */
    default BulkBrowseResult browseTitlesAlphabetically(String type, boolean adultContent, String titlePrefix,
        BooleanSupplier cancelled, IntConsumer progress) {
        if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new CancellationException("Bulk browse cancelled.");
        BulkBrowseResult result = browseTitlesAlphabetically(type, adultContent, titlePrefix);
        if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new CancellationException("Bulk browse cancelled.");
        progress.accept(result.pagesScanned());
        return result;
    }

    /**
     * Load normalized source details for a provider title URL.
     *
     * @param titleUrl source URL to inspect
     * @return rich title details or {@code null}
     */
    TitleDetails getTitleDetails(String titleUrl);

    /** @param titleUrl source series @param cancelled owner cancellation @return verified source metadata or null */
    default TitleDetails getTitleDetails(String titleUrl, BooleanSupplier cancelled) {
        if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new CancellationException("Metadata request cancelled.");
        TitleDetails result = getTitleDetails(titleUrl);
        if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new CancellationException("Metadata request cancelled.");
        return result;
    }

    /**
     * Load the chapter list for a provider title URL.
     *
     * @param titleUrl source URL to inspect
     * @return normalized chapter list
     */
    List<Map<String, String>> getChapters(String titleUrl);

    /** @param titleUrl exact source series @return explicit discovery outcome; empty legacy results remain unresolved */
    default ChapterDiscoveryResult discoverChapters(String titleUrl) {
        return ChapterDiscoveryResult.fromChapters(getChapters(titleUrl));
    }

    /** @param titleUrl exact source series @param cancelled owner cancellation @return explicit chapter discovery outcome */
    default ChapterDiscoveryResult discoverChapters(String titleUrl, BooleanSupplier cancelled) {
        if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new CancellationException("Chapter request cancelled.");
        ChapterDiscoveryResult result = discoverChapters(titleUrl);
        if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new CancellationException("Chapter request cancelled.");
        return result;
    }

    /**
     * Resolve page image URLs for a provider chapter URL.
     *
     * @param chapterUrl chapter URL to inspect
     * @return normalized image URLs
     */
    List<String> resolvePages(String chapterUrl);
}
