package com.scriptarr.raven.library;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Recompute title-card counters from acknowledged chapter rows without rewriting siblings. */
final class LibraryInventorySummary {
    private LibraryInventorySummary() { }

    /** @param chapters current durable inventory @return summary-only fields for the existing title checkpoint */
    static Map<String, Object> fields(List<LibraryChapter> chapters) {
        int clean = 0, partial = 0, missing = 0, available = 0, ready = 0, failed = 0, running = 0, absent = 0;
        String error = "";
        for (LibraryChapter chapter : chapters) {
            if (chapter.available()) available++;
            String quality = chapter.qualityStatus();
            if (!chapter.available() || List.of("missing_content", "bad_source").contains(quality)) missing++;
            else if (List.of("partial", "possible_missing_page").contains(quality)) partial++;
            else clean++;
            switch (chapter.ingestStatus()) {
                case "ready" -> ready++;
                case "failed" -> failed++;
                case "running" -> running++;
                case "missing" -> absent++;
                default -> { }
            }
            if (error.isBlank() && !chapter.ingestError().isBlank()) error = chapter.ingestError();
        }
        int total = chapters.size();
        String quality = total > 0 && clean / (double) total < 0.8 ? "bad_source" : missing > 0 ? "missing_content" : partial > 0 ? "possible_missing_page" : "clean";
        String ingest = failed > 0 ? "failed" : running > 0 ? "running" : total > 0 && ready == total ? "ready" : total > 0 && absent == total ? "missing" : "pending";
        Map<String, Object> result = new LinkedHashMap<>(Map.of("chapterCount", total, "chaptersDownloaded", available,
            "qualityStatus", quality, "cleanChapterCount", clean, "partialChapterCount", partial, "missingContentCount", missing,
            "qualitySummary", total == 0 ? "" : clean + "/" + total + " clean downloads", "ingestStatus", ingest,
            "ingestedChapterCount", ready, "ingestError", error));
        return Map.copyOf(result);
    }
}
