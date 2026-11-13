package com.scriptarr.raven.downloader;

import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryTitle;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Durable owner diagnostics identify exact planned gaps without exposing filesystem details. */
class CompletionProblemsTest {
    /** Missing catalog and unavailable chapters stay distinct; output is bounded and fractional numbers survive. */
    @Test void exactProblemsAreBoundedAndDoNotLeakPaths() {
        LibraryTitle title = mock(LibraryTitle.class); when(title.id()).thenReturn("title");
        when(title.chapters()).thenReturn(List.of(new LibraryChapter("chapter", "Chapter 197", "197", 0, "", false, "/private/secret.cbz", "https://weebcentral.com/chapters/ABC", "missing_content", 9, 9, List.of(1,2,3,4,5,6,7,8,9), List.of(), null)));
        var verifier = new DownloadCompletionVerifier(null);
        var problems = verifier.problems(title, List.of(Map.of("chapter_number", "197"), Map.of("chapter_number", "198.50")), false);
        assertEquals("source_unavailable", problems.getFirst().get("code")); assertEquals(9, problems.getFirst().get("missingPageCount"));
        assertEquals("chapter_missing", problems.getLast().get("code")); assertEquals("198.5", problems.getLast().get("chapterNumber"));
        assertFalse(problems.toString().contains("/private")); assertFalse(verifier.complete(title, List.of(Map.of("chapter_number", "197"))));
        assertEquals(50, verifier.problems(title, java.util.stream.IntStream.range(0,100).mapToObj(i -> Map.of("chapter_number", String.valueOf(i))).toList(), false).size());
    }
}
