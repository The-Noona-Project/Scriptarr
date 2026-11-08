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
    int completedChapters, int totalChapters, boolean advanced) { }
