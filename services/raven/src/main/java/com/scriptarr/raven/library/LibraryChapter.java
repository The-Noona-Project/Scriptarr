package com.scriptarr.raven.library;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Objects;

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
    String updatedAt,
    @JsonInclude(JsonInclude.Include.NON_NULL) Integer sourcePageCount,
    @JsonInclude(JsonInclude.Include.NON_NULL) Integer expectedSegmentCount,
    @JsonInclude(JsonInclude.Include.NON_NULL) Integer ingestedSegmentCount,
    @JsonInclude(JsonInclude.Include.NON_NULL) Boolean segmentsReady
) {
    /**
     * Preserve the original chapter constructor without inventing segment evidence for legacy AVIF.
     *
     * @param id stable chapter id
     * @param label display label
     * @param chapterNumber provider chapter number
     * @param pageCount logical page count
     * @param releaseDate source release date
     * @param available archive availability
     * @param archivePath canonical archive path
     * @param sourceUrl upstream chapter URL
     * @param qualityStatus durable quality state
     * @param expectedPageCount expected logical page count
     * @param missingPageCount missing logical page count
     * @param missingPages missing logical page numbers
     * @param qualityNotes durable quality evidence
     * @param ingestStatus durable reader processing state
     * @param ingestRevision immutable saved output revision
     * @param ingestedPageCount completed logical page count
     * @param ingestedAt completion timestamp
     * @param ingestError bounded processing error
     * @param ingestManifestPath saved manifest path
     * @param updatedAt last update timestamp
     */
    public LibraryChapter(String id, String label, String chapterNumber, int pageCount, String releaseDate,
        boolean available, String archivePath, String sourceUrl, String qualityStatus, int expectedPageCount,
        int missingPageCount, List<Integer> missingPages, List<String> qualityNotes, String ingestStatus,
        String ingestRevision, int ingestedPageCount, String ingestedAt, String ingestError,
        String ingestManifestPath, String updatedAt) {
        this(id, label, chapterNumber, pageCount, releaseDate, available, archivePath, sourceUrl, qualityStatus,
            expectedPageCount, missingPageCount, missingPages, qualityNotes, ingestStatus, ingestRevision,
            ingestedPageCount, ingestedAt, ingestError, ingestManifestPath, updatedAt, null, null, null, null);
    }

    /**
     * Carry a saved checkpoint through metadata-only copies of the same chapter and output identity.
     * Missing evidence stays missing; this method never derives positive readiness from counts or a revision.
     * A non-ready target retains counter evidence while explicitly invalidating segment readiness.
     *
     * @param previous durable chapter being copied
     * @return this chapter with only matching, otherwise omitted checkpoint fields preserved
     */
    public LibraryChapter preserveSegmentCheckpointFrom(LibraryChapter previous) {
        if (previous == null || !Objects.equals(id, previous.id())
            || !Objects.equals(ingestRevision, previous.ingestRevision())
            || !Objects.equals(ingestManifestPath, previous.ingestManifestPath())) return this;
        Integer source = sourcePageCount == null ? previous.sourcePageCount() : sourcePageCount;
        Integer expected = expectedSegmentCount == null ? previous.expectedSegmentCount() : expectedSegmentCount;
        Integer completed = ingestedSegmentCount == null ? previous.ingestedSegmentCount() : ingestedSegmentCount;
        Boolean ready = segmentsReady == null ? previous.segmentsReady() : segmentsReady;
        if (!"ready".equals(ingestStatus) && (source != null || expected != null || completed != null || ready != null)) ready = false;
        return new LibraryChapter(id, label, chapterNumber, pageCount, releaseDate, available, archivePath, sourceUrl,
            qualityStatus, expectedPageCount, missingPageCount, missingPages, qualityNotes, ingestStatus,
            ingestRevision, ingestedPageCount, ingestedAt, ingestError, ingestManifestPath, updatedAt,
            source, expected, completed, ready);
    }
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
        sourcePageCount = sourcePageCount == null ? null : Math.max(0, sourcePageCount);
        expectedSegmentCount = expectedSegmentCount == null ? null : Math.max(0, expectedSegmentCount);
        ingestedSegmentCount = ingestedSegmentCount == null ? null : Math.max(0, ingestedSegmentCount);
    }

    private static String normalizeIngestStatus(String value, String fallback) {
        String normalized = value == null ? "" : value.trim().toLowerCase().replace('-', '_');
        return switch (normalized) {
            case "ready", "running", "pending", "failed", "missing" -> normalized;
            default -> fallback;
        };
    }
}
