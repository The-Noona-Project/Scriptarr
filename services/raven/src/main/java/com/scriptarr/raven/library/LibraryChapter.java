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
     * Create immutable chapter payloads with safe quality defaults.
     */
    public LibraryChapter {
        qualityStatus = qualityStatus == null || qualityStatus.isBlank() ? "clean" : qualityStatus;
        expectedPageCount = Math.max(0, expectedPageCount);
        missingPageCount = Math.max(0, missingPageCount);
        missingPages = missingPages == null ? List.of() : List.copyOf(missingPages);
        qualityNotes = qualityNotes == null ? List.of() : List.copyOf(qualityNotes);
    }
}
