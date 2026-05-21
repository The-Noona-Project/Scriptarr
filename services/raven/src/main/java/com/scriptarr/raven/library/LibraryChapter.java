package com.scriptarr.raven.library;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;

/**
 * Reader-facing chapter summary for a Scriptarr library title.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record LibraryChapter(
    String id,
    String label,
    String chapterNumber,
    int pageCount,
    String releaseDate,
    boolean available,
    String archivePath,
    String sourceUrl,
    String qualityStatus,
    int expectedPageCount,
    int missingPageCount,
    List<Integer> missingPages,
    List<String> qualityNotes,
    String ingestStatus,
    String ingestRevision,
    int ingestedPageCount,
    String ingestedAt,
    String ingestError,
    String ingestManifestPath,
    String updatedAt
) {
    /**
     * Backward-compatible constructor for clean, fully available chapters.
     *
     * @param id stable chapter id
     * @param label display label
     * @param chapterNumber provider chapter number
     * @param pageCount stored page count
     * @param releaseDate source release date
     * @param available whether the chapter can be read
     * @param archivePath archive file path
     * @param sourceUrl upstream chapter URL
     * @param updatedAt last update timestamp
     */
    public LibraryChapter(
        String id,
        String label,
        String chapterNumber,
        int pageCount,
        String releaseDate,
        boolean available,
        String archivePath,
        String sourceUrl,
        String updatedAt
    ) {
        this(id, label, chapterNumber, pageCount, releaseDate, available, archivePath, sourceUrl, "clean", pageCount, 0, List.of(), List.of(), updatedAt);
    }

    /**
     * Backward-compatible constructor for chapters with quality metadata but no
     * ingest metadata.
     */
    public LibraryChapter(
        String id,
        String label,
        String chapterNumber,
        int pageCount,
        String releaseDate,
        boolean available,
        String archivePath,
        String sourceUrl,
        String qualityStatus,
        int expectedPageCount,
        int missingPageCount,
        List<Integer> missingPages,
        List<String> qualityNotes,
        String updatedAt
    ) {
        this(
            id,
            label,
            chapterNumber,
            pageCount,
            releaseDate,
            available,
            archivePath,
            sourceUrl,
            qualityStatus,
            expectedPageCount,
            missingPageCount,
            missingPages,
            qualityNotes,
            "pending",
            "",
            0,
            null,
            "",
            "",
            updatedAt
        );
    }

    /**
     * Create immutable chapter payloads with safe quality defaults.
     */
    public LibraryChapter {
        qualityStatus = qualityStatus == null || qualityStatus.isBlank() ? "clean" : qualityStatus;
        expectedPageCount = Math.max(0, expectedPageCount);
        missingPageCount = Math.max(0, missingPageCount);
        missingPages = missingPages == null ? List.of() : List.copyOf(missingPages);
        qualityNotes = qualityNotes == null ? List.of() : List.copyOf(qualityNotes);
        ingestStatus = normalizeIngestStatus(ingestStatus, available ? "pending" : "missing");
        ingestRevision = ingestRevision == null ? "" : ingestRevision;
        ingestedPageCount = Math.max(0, ingestedPageCount);
        ingestedAt = ingestedAt == null || ingestedAt.isBlank() ? null : ingestedAt;
        ingestError = ingestError == null ? "" : ingestError;
        ingestManifestPath = ingestManifestPath == null ? "" : ingestManifestPath;
    }

    private static String normalizeIngestStatus(String value, String fallback) {
        String normalized = value == null ? "" : value.trim().toLowerCase().replace('-', '_');
        return switch (normalized) {
            case "ready", "running", "pending", "failed", "missing" -> normalized;
            default -> fallback;
        };
    }
}
