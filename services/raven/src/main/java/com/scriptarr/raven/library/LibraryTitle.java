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
    String downloadRoot,
    List<LibraryChapter> chapters
) {
}
