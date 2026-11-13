package com.scriptarr.raven.library;

import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Preserve explicit gaps and stable identities without inventing source pages. */
class ChapterGapPreservationTest {
    /** Repeated scans retain an unavailable planned row and fractional chapter identity. */
    @Test void repeatedScansKeepGapsAndStableIds() {
        LibraryChapter gap = chapter("gap", "197", false), old = chapter("stable", "198.50", true);
        LibraryTitle title = mock(LibraryTitle.class); when(title.chapters()).thenReturn(List.of(gap, old));
        List<LibraryChapter> once = ScanChapterReconciler.merge(title, List.of(chapter("new", "198.5", true)), c -> false, c -> c);
        assertEquals("stable", once.getFirst().id()); assertEquals(ScanChapterReconciler.unavailable(gap), once.getLast());
        when(title.chapters()).thenReturn(once);
        assertEquals(once, ScanChapterReconciler.merge(title, List.of(chapter("new", "198.5", true)), c -> false, c -> c));
        List<LibraryChapter> missing = ScanChapterReconciler.merge(title, List.of(), c -> true, c -> c);
        assertEquals(2, missing.size());
        LibraryChapter removed = missing.stream().filter(c -> c.id().equals("stable")).findFirst().orElseThrow();
        assertFalse(removed.available()); assertEquals("missing", removed.ingestStatus());
        assertEquals(once.getFirst().sourceUrl(), removed.sourceUrl()); assertEquals(old.expectedPageCount(), removed.expectedPageCount());
    }

    /** Restore only explicitly accepted source chapters; a changed origin or canonical source cannot be adopted. */
    @Test void restoredPlanGapsAreSourceBoundAndDoNotInventCounts() {
        LibraryTitle title = mock(LibraryTitle.class);
        when(title.sourceUrl()).thenReturn("https://weebcentral.com/series/ABC/Title");
        when(title.chapters()).thenReturn(List.of(chapter("stable", "198.5", true)));
        var expected = List.of(Map.of("chapter_number", "197", "href", "https://weebcentral.com/chapters/DEF"),
            Map.of("chapter_number", "198.50", "href", "https://weebcentral.com/chapters/GHI"));
        var gaps = PlannedChapterGaps.absent(title, title.sourceUrl(), expected, n -> "chapter-" + n);
        assertEquals(1, gaps.size()); assertEquals("197", gaps.getFirst().chapterNumber());
        assertFalse(gaps.getFirst().available()); assertEquals(0, gaps.getFirst().expectedPageCount());
        assertEquals(0, gaps.getFirst().pageCount()); assertEquals("", gaps.getFirst().archivePath());
        assertThrows(IllegalStateException.class, () -> PlannedChapterGaps.absent(title, "https://weebcentral.com/series/OTHER", expected, n -> n));
        assertThrows(IllegalStateException.class, () -> PlannedChapterGaps.absent(title, title.sourceUrl(), List.of(Map.of("chapter_number", "2", "href", "https://foreign.example/chapters/ABC")), n -> n));
    }

    /** @param id stable chapter @param number numeric source identity @param available archive state @return small catalog row */
    private static LibraryChapter chapter(String id, String number, boolean available) {
        return new LibraryChapter(id, "Chapter " + number, number, available ? 9 : 0, "", available,
            available ? "/managed/chapter.cbz" : "", "https://weebcentral.com/chapters/" + id, "missing_content", 9, 1, List.of(1), List.of("source gap"), null);
    }
}
