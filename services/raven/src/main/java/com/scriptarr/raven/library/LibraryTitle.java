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
    String ingestStatus,
    int ingestedChapterCount,
    String ingestError,
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
            summarizeIngestStatus(chapters),
            countReadyChapters(chapters),
            firstIngestError(chapters),
            updatedAt
        );
    }

    /**
     * Backward-compatible constructor for titles with quality metadata but no
     * aggregate ingest metadata.
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
        String qualityStatus,
        int cleanChapterCount,
        int partialChapterCount,
        int missingContentCount,
        String qualitySummary,
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
            qualityStatus,
            cleanChapterCount,
            partialChapterCount,
            missingContentCount,
            qualitySummary,
            summarizeIngestStatus(chapters),
            countReadyChapters(chapters),
            firstIngestError(chapters),
            updatedAt
        );
    }

    /**
     * Create immutable title payloads with safe quality defaults.
     */
    public LibraryTitle {
        chapters = chapters == null ? List.of() : List.copyOf(chapters);
        tags = tags == null ? List.of() : List.copyOf(tags);
        aliases = aliases == null ? List.of() : List.copyOf(aliases);
        relations = relations == null ? List.of() : List.copyOf(relations);
        qualityStatus = qualityStatus == null || qualityStatus.isBlank() ? "clean" : qualityStatus;
        cleanChapterCount = Math.max(0, cleanChapterCount);
        partialChapterCount = Math.max(0, partialChapterCount);
        missingContentCount = Math.max(0, missingContentCount);
        qualitySummary = qualitySummary == null ? "" : qualitySummary;
        ingestStatus = normalizeIngestStatus(ingestStatus, summarizeIngestStatus(chapters));
        ingestedChapterCount = Math.max(0, ingestedChapterCount);
        ingestError = ingestError == null ? "" : ingestError;
    }

    private static int countReadyChapters(List<LibraryChapter> chapters) {
        int count = 0;
        for (LibraryChapter chapter : chapters == null ? List.<LibraryChapter>of() : chapters) {
            if (chapter != null && "ready".equals(normalizeIngestStatus(chapter.ingestStatus(), ""))) {
                count++;
            }
        }
        return count;
    }

    private static String firstIngestError(List<LibraryChapter> chapters) {
        for (LibraryChapter chapter : chapters == null ? List.<LibraryChapter>of() : chapters) {
            if (chapter != null && chapter.ingestError() != null && !chapter.ingestError().isBlank()) {
                return chapter.ingestError();
            }
        }
        return "";
    }

    private static String summarizeIngestStatus(List<LibraryChapter> chapters) {
        List<LibraryChapter> safeChapters = chapters == null ? List.of() : chapters;
        if (safeChapters.isEmpty()) {
            return "pending";
        }
        int ready = 0;
        int running = 0;
        int failed = 0;
        int missing = 0;
        for (LibraryChapter chapter : safeChapters) {
            String status = normalizeIngestStatus(chapter == null ? "" : chapter.ingestStatus(), "pending");
            if ("ready".equals(status)) {
                ready++;
            } else if ("running".equals(status)) {
                running++;
            } else if ("failed".equals(status)) {
                failed++;
            } else if ("missing".equals(status)) {
                missing++;
            }
        }
        if (failed > 0) {
            return "failed";
        }
        if (running > 0) {
            return "running";
        }
        if (ready == safeChapters.size()) {
            return "ready";
        }
        if (missing == safeChapters.size()) {
            return "missing";
        }
        return "pending";
    }

    private static String normalizeIngestStatus(String value, String fallback) {
        String normalized = value == null ? "" : value.trim().toLowerCase().replace('-', '_');
        return switch (normalized) {
            case "ready", "running", "pending", "failed", "missing" -> normalized;
            default -> fallback == null || fallback.isBlank() ? "pending" : fallback;
        };
    }
}
