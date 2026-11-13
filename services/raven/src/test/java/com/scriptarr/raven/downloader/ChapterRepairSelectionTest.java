package com.scriptarr.raven.downloader;

import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryTitle;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Frozen selection and owner-scoped retry identities cannot silently change repair scope. */
class ChapterRepairSelectionTest {
    /** Selection order does not allocate a new identity, but ownership and changed scope remain distinct. */
    @Test void stableIdsAndConflictsHaveDistinctFingerprints() {
        List<String> sorted = ChapterRepairSelection.ids(Map.of("chapterIds", List.of("b", "a")));
        assertEquals(List.of("a", "b"), sorted);
        assertEquals(ChapterRepairSelection.taskId("owner", "key"), ChapterRepairSelection.taskId("owner", "key"));
        assertNotEquals(ChapterRepairSelection.taskId("owner", "key"), ChapterRepairSelection.taskId("other", "key"));
        assertNotEquals(ChapterRepairSelection.fingerprint("title", "owner", sorted), ChapterRepairSelection.fingerprint("other", "owner", sorted));
        for (List<String> ids : List.of(List.of("a", "a"), List.of(".."), List.of("../escape"))) assertThrows(IllegalArgumentException.class, () -> ChapterRepairSelection.ids(Map.of("chapterIds", ids)));
        assertThrows(IllegalArgumentException.class, () -> ChapterRepairSelection.requestId("bad key"));
    }
    /** A chapter outside this title or source origin cannot be selected. */
    @Test void selectionRequiresExactCatalogAndSourceOwnership() {
        LibraryTitle title = mock(LibraryTitle.class); when(title.sourceUrl()).thenReturn("https://weebcentral.com/series/ABC/Title");
        LibraryChapter bad = new LibraryChapter("chapter", "Chapter 1", "1", 1, "", false, "", "https://foreign.example/chapters/ABC", null);
        when(title.chapters()).thenReturn(List.of(bad));
        assertThrows(IllegalArgumentException.class, () -> ChapterRepairSelection.freeze(title, List.of("chapter")));
        assertThrows(IllegalArgumentException.class, () -> ChapterRepairSelection.freeze(title, List.of("other")));
    }
}
