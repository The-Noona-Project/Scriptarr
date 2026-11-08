package com.scriptarr.raven.library;

import java.io.IOException;
import java.util.Map;
import java.util.Objects;

/** Separate retention of an existing durable checkpoint from validation of newly published reader output. */
final class LibraryChapterCatalogCheckpoint {
    /** Prevent construction of this checkpoint utility. */
    private LibraryChapterCatalogCheckpoint() { }

    /** @param chapter ordinary catalog write @return whether durable state can authorize retaining this ready WebP checkpoint */
    static boolean needsSnapshot(LibraryChapter chapter) {
        return chapter != null && "ready".equals(chapter.ingestStatus()) && chapter.ingestRevision().startsWith("webp-");
    }

    /**
     * Preserve only an already durable matching checkpoint; ingest separately validates and repairs missing files.
     * New or changed ready output must still prove its complete manifest and every physical segment.
     *
     * @param chapter requested chapter write
     * @param previous current durable chapter, never an unpersisted caller snapshot
     * @return explicit checkpoint fields for the ordinary write
     * @throws IOException when newly claimed reader output cannot be verified
     */
    static Map<String, Object> fields(LibraryChapter chapter, LibraryChapter previous) throws IOException {
        if (!needsSnapshot(chapter)) {
            return chapter != null && chapter.ingestRevision().startsWith("webp-")
                ? Map.of("segmentsReady", false) : Map.of();
        }
        if (retained(chapter, previous)) {
            return Map.of("sourcePageCount", previous.sourcePageCount(), "expectedSegmentCount", previous.expectedSegmentCount(),
                "ingestedSegmentCount", previous.ingestedSegmentCount(), "segmentsReady", true);
        }
        return DerivedPageManifest.catalogFields(chapter);
    }

    /** @param chapter requested write @param previous durable checkpoint @return whether the exact existing evidence can be retained */
    private static boolean retained(LibraryChapter chapter, LibraryChapter previous) {
        return previous != null && previous.available() && chapter.available() && needsSnapshot(previous)
            && DerivedPageManifest.supported(previous.ingestRevision())
            && previous.id() != null && !previous.id().isBlank() && previous.archivePath() != null && !previous.archivePath().isBlank()
            && previous.ingestManifestPath() != null && !previous.ingestManifestPath().isBlank()
            && Objects.equals(chapter.id(), previous.id()) && Objects.equals(chapter.archivePath(), previous.archivePath())
            && Objects.equals(chapter.ingestRevision(), previous.ingestRevision()) && Objects.equals(chapter.ingestManifestPath(), previous.ingestManifestPath())
            && chapter.pageCount() == previous.pageCount() && chapter.ingestedPageCount() == previous.ingestedPageCount()
            && previous.pageCount() > 0 && previous.ingestedPageCount() == previous.pageCount()
            && Objects.equals(previous.sourcePageCount(), previous.pageCount()) && previous.expectedSegmentCount() != null
            && previous.expectedSegmentCount() >= previous.pageCount() && Objects.equals(previous.ingestedSegmentCount(), previous.expectedSegmentCount())
            && Boolean.TRUE.equals(previous.segmentsReady())
            && (chapter.sourcePageCount() == null || Objects.equals(chapter.sourcePageCount(), previous.sourcePageCount()))
            && (chapter.expectedSegmentCount() == null || Objects.equals(chapter.expectedSegmentCount(), previous.expectedSegmentCount()))
            && (chapter.ingestedSegmentCount() == null || Objects.equals(chapter.ingestedSegmentCount(), previous.ingestedSegmentCount()))
            && (chapter.segmentsReady() == null || Boolean.TRUE.equals(chapter.segmentsReady()));
    }
}
