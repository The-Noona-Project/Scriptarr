package com.scriptarr.raven.library;

/**
 * Real reader-ingest progress, separate from a parent download's capped percentage.
 *
 * @param stage current work or encoder-wait stage
 * @param completedPages completed pages in the current chapter
 * @param totalPages pages in the current chapter
 * @param completedChapters completed chapters in the title
 * @param totalChapters chapters in the title
 * @param advanced whether a page or chapter actually completed
 */
public record IngestProgress(String stage, int completedPages, int totalPages,
    int completedChapters, int totalChapters, boolean advanced, int completedSegments, int totalSegments) {
    /** @param stage work stage @param completedPages logical completed pages @param totalPages logical page count @param completedChapters completed chapters @param totalChapters title chapter count @param advanced actual content progress */
    public IngestProgress(String stage, int completedPages, int totalPages, int completedChapters, int totalChapters, boolean advanced) {
        this(stage, completedPages, totalPages, completedChapters, totalChapters, advanced, 0, 0);
    }
}
