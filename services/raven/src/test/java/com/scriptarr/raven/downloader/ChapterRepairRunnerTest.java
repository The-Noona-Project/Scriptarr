package com.scriptarr.raven.downloader;

import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.ArrayList;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Exercise exact selection, partial preservation, explicit retry and discovery cancellation. */
class ChapterRepairRunnerTest {
    private static final String URL = "https://weebcentral.com/series/ABC/Title";
    /** One partial candidate cannot publish; another selected repair commits and is skipped on retry. */
    @Test void onlyUnresolvedSelectedChaptersAreRetried(@TempDir Path root) throws Exception {
        LibraryService library = mock(LibraryService.class); LibraryTitle title = mock(LibraryTitle.class); DownloadProvider provider = mock(DownloadProvider.class);
        LibraryChapter one = chapter("one", "1"), two = chapter("two", "2"), healthy = chapter("healthy", "3");
        when(library.findTitle("title")).thenReturn(title); when(title.sourceUrl()).thenReturn(URL); when(title.chapters()).thenReturn(List.of(one, two, healthy));
        List<Map<String, Object>> selected = List.of(scope(one), scope(two));
        when(provider.discoverChapters(URL)).thenReturn(new ChapterDiscoveryResult(List.of(source(one), source(two)), false, ""));
        List<String> attempted = new ArrayList<>(); List<List<Map<String, Object>>> diagnostics = new ArrayList<>();
        ChapterRepairRunner.Source source = (row, destination) -> {
            String id = String.valueOf(row.get("id")); attempted.add(id); assertTrue(destination.startsWith(root.resolve(".chapter-repairs/task")));
            return new DownloaderService.ChapterDownloadResult(String.valueOf(row.get("chapter_number")), Map.of(), destination.resolve("candidate.cbz"), 2,
                id.equals("one") ? 1 : 0, id.equals("one") ? List.of(2) : List.of(), List.of(), id.equals("one") ? "partial" : "clean", "");
        };
        DownloadRequest request = new DownloadRequest("Title", URL, "Manhua", "owner", "weebcentral", "", Map.of(), Map.of(), "", "normal");
        assertThrows(IllegalStateException.class, () -> ChapterRepairRunner.run("task", request, Map.of("titleId", "title", "chapters", selected), library, provider, root, source, () -> false, diagnostics::add, p -> {}));
        verify(library, never()).publishChapterRepair(any(), any(), eq("one"), any(), any(), any(), any(), any());
        verify(library).publishChapterRepair(eq("task"), eq("title"), eq("two"), any(), any(), any(), any(), any());
        assertEquals(List.of("one", "two"), attempted); assertEquals("1", diagnostics.getLast().getFirst().get("chapterNumber"));
        when(library.chapterRepairCompleted("task", "title", "two")).thenReturn(true); attempted.clear();
        assertThrows(IllegalStateException.class, () -> ChapterRepairRunner.run("task", request, Map.of("titleId", "title", "chapters", selected), library, provider, root, source, () -> false, diagnostics::add, p -> {}));
        assertEquals(List.of("one"), attempted); verify(library, never()).publishChapterRepair(any(), any(), eq("healthy"), any(), any(), any(), any(), any());
    }
    /** Cancellation after source browsing prevents all source downloads and publications. */
    @Test void cancellationDuringDiscoveryStopsBeforeCandidateDownload(@TempDir Path root) throws Exception {
        LibraryService library = mock(LibraryService.class); LibraryTitle title = mock(LibraryTitle.class); DownloadProvider provider = mock(DownloadProvider.class);
        LibraryChapter chapter = chapter("one", "1"); when(library.findTitle("title")).thenReturn(title); when(title.sourceUrl()).thenReturn(URL); when(title.chapters()).thenReturn(List.of(chapter));
        AtomicBoolean cancelled = new AtomicBoolean();
        when(provider.discoverChapters(URL)).thenAnswer(i -> {cancelled.set(true); return new ChapterDiscoveryResult(List.of(source(chapter)), false, "");});
        DownloadRequest request = new DownloadRequest("Title", URL, "Manhua", "owner", "weebcentral", "", Map.of(), Map.of(), "", "normal");
        assertThrows(CancellationException.class, () -> ChapterRepairRunner.run("task", request, Map.of("titleId", "title", "chapters", List.of(scope(chapter))), library, provider, root,
            (row, path) -> {fail("Cancelled work escaped browsing"); return null;}, cancelled::get, p -> {}, p -> {}));
        verify(library, never()).publishChapterRepair(any(), any(), any(), any(), any(), any(), any(), any());
    }
    /** @param id stable id @param number source number @return unresolved row */
    private static LibraryChapter chapter(String id, String number) {return new LibraryChapter(id, "Chapter " + number, number, 2, "", true, "/private/" + id + ".cbz", "https://weebcentral.com/chapters/" + id, "partial", 2, 1, List.of(2), List.of(), null);}
    /** @param chapter catalog row @return frozen scope */
    private static Map<String, Object> scope(LibraryChapter chapter) {return Map.of("id", chapter.id(), "chapter_number", chapter.chapterNumber(), "href", chapter.sourceUrl());}
    /** @param chapter catalog row @return provider row */
    private static Map<String, String> source(LibraryChapter chapter) {return Map.of("chapter_number", chapter.chapterNumber(), "href", chapter.sourceUrl());}
}
