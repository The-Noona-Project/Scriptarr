package com.scriptarr.raven.downloader;

import java.util.List;
import java.util.Map;

/** Explicit separation of available chapters, verified unavailable source rows, and retrieval failures. */
public record ChapterDiscoveryResult(List<Map<String, String>> chapters, boolean unavailable, String error) {
    /** @param chapters source rows @param unavailable explicit source unavailability @param error bounded retrieval failure */
    public ChapterDiscoveryResult {
        chapters = chapters == null ? List.of() : List.copyOf(chapters);
        error = error == null ? "" : error;
        if (unavailable && (!chapters.isEmpty() || !error.isBlank())) throw new IllegalArgumentException("Conflicting chapter discovery evidence.");
    }

    /** @param chapters legacy provider rows @return complete nonempty result or an unresolved discovery failure */
    public static ChapterDiscoveryResult fromChapters(List<Map<String, String>> chapters) {
        return new ChapterDiscoveryResult(chapters, false, chapters == null || chapters.isEmpty() ? "The provider did not return a verifiable chapter list." : "");
    }
}
