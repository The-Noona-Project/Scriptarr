package com.scriptarr.raven.library;

import java.util.List;
import java.util.Map;

/**
 * Reader-facing library title summary and detail payload for Scriptarr Moon.
 */
public record LibraryTitle(
    String id,
    String title,
    String mediaType,
    String libraryTypeLabel,
    String libraryTypeSlug,
    String status,
    String latestChapter,
    String coverAccent,
    String summary,
    String releaseLabel,
    int chapterCount,
    int chaptersDownloaded,
    String author,
    List<String> tags,
    List<String> aliases,
    String metadataProvider,
    String metadataMatchedAt,
    List<Map<String, String>> relations,
    String sourceUrl,
    String coverUrl,
    String workingRoot,
    String downloadRoot,
    List<LibraryChapter> chapters,
    String qualityStatus,
    int cleanChapterCount,
    int partialChapterCount,
    int missingContentCount,
    String qualitySummary,
    String updatedAt
) {
    /**
     * Backward-compatible constructor for titles without explicit quality
     * metadata.
     */
    public LibraryTitle(
        String id,
        String title,
        String mediaType,
        String libraryTypeLabel,
        String libraryTypeSlug,
        String status,
        String latestChapter,
        String coverAccent,
        String summary,
        String releaseLabel,
        int chapterCount,
        int chaptersDownloaded,
        String author,
        List<String> tags,
        List<String> aliases,
        String metadataProvider,
        String metadataMatchedAt,
        List<Map<String, String>> relations,
        String sourceUrl,
        String coverUrl,
        String workingRoot,
        String downloadRoot,
        List<LibraryChapter> chapters,
        String updatedAt
    ) {
        this(
            id,
            title,
            mediaType,
            libraryTypeLabel,
            libraryTypeSlug,
            status,
            latestChapter,
            coverAccent,
            summary,
            releaseLabel,
            chapterCount,
            chaptersDownloaded,
            author,
            tags,
            aliases,
            metadataProvider,
            metadataMatchedAt,
            relations,
            sourceUrl,
            coverUrl,
            workingRoot,
            downloadRoot,
            chapters,
            "clean",
            Math.max(0, chaptersDownloaded),
            0,
            0,
            "",
            updatedAt
        );
    }

    /**
     * Create immutable title payloads with safe quality defaults.
     */
    public LibraryTitle {
        qualityStatus = qualityStatus == null || qualityStatus.isBlank() ? "clean" : qualityStatus;
        cleanChapterCount = Math.max(0, cleanChapterCount);
        partialChapterCount = Math.max(0, partialChapterCount);
        missingContentCount = Math.max(0, missingContentCount);
        qualitySummary = qualitySummary == null ? "" : qualitySummary;
    }
}
