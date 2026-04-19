package com.scriptarr.raven.library;

/**
 * Reader-facing chapter summary for a Scriptarr library title.
 */
public record LibraryChapter(
    String id,
    String label,
    String chapterNumber,
    int pageCount,
    String releaseDate,
    boolean available
) {
}
