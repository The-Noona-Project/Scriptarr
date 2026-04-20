package com.scriptarr.raven.library;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

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
    String sourceUrl
) {
}
