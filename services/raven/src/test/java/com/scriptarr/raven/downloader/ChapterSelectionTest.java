package com.scriptarr.raven.downloader;

import org.junit.jupiter.api.Test;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

/** Initial downloads and append recovery must share one explicit, fail-closed chapter scope. */
class ChapterSelectionTest {
    /** Omitted selection preserves full initial downloads and never expands an unscoped append. */
    @Test void absentSelectionPreservesLegacyBehavior() {
        var source = List.of(chapter("1"), chapter("2"));
        assertEquals(source, ChapterSelection.select(source, Map.of(), false));
        assertTrue(ChapterSelection.select(source, Map.of(), true).isEmpty());
    }

    /** Both modes honor normalized fractional numbers, deduplicate requested numbers and retain source order. */
    @Test void explicitSelectionBoundsInitialAndAppendDownloads() {
        var source = List.of(chapter("6"), chapter("2.50"), chapter("1"), chapter("7"));
        var selection = Map.<String, Object>of("chapterNumbers", List.of("1.0", "2.5", 1));
        for (boolean append : List.of(false, true)) {
            assertEquals(List.of(chapter("2.50"), chapter("1")), ChapterSelection.select(source, selection, append));
        }
        assertEquals(List.of(Map.of("chapter_number", "1"), Map.of("chapter_number", "2.5")), ChapterSelection.expected(selection));
    }

    /** Invalid explicit input cannot silently become a full-series download. */
    @Test void malformedSelectionsFailClosed() {
        for (Object raw : Arrays.asList(null, "1", List.of(), List.of(" "), List.of(true), Arrays.asList("1", null), List.of(Double.NaN))) {
            var selected = new java.util.HashMap<String, Object>(); selected.put("chapterNumbers", raw);
            assertThrows(IllegalArgumentException.class, () -> ChapterSelection.select(List.of(chapter("1")), selected, false));
        }
    }

    private static Map<String, String> chapter(String number) { return Map.of("chapter_number", number, "href", "chapter/" + number); }
}
