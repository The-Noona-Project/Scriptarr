package com.scriptarr.raven.downloader;

import com.scriptarr.raven.library.LibraryChapter;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Preserve existing catalog chapters while applying explicit append or recovery results. */
final class AppendChapterMerger {
    private AppendChapterMerger() { }

    /**
     * Retain untouched chapter objects and replace only incoming normalized chapter numbers.
     * Existing chapter identities survive intentional repairs; incoming reader and quality state wins.
     * Chapters without a usable number remain separate rather than overwriting unrelated rows.
     *
     * @param existing current catalog chapters, including their reader-page state
     * @param incoming explicitly downloaded or recovered chapter results
     * @return immutable merged chapters in stable existing-then-new order
     */
    static List<LibraryChapter> merge(List<LibraryChapter> existing, List<LibraryChapter> incoming) {
        Map<String, LibraryChapter> chapters = new LinkedHashMap<>();
        int anonymous = 0;
        for (LibraryChapter chapter : existing == null ? List.<LibraryChapter>of() : existing) {
            if (chapter == null) continue;
            String number = DownloadCompletionVerifier.number(chapter.chapterNumber());
            chapters.put(number.isBlank() ? "anonymous:" + anonymous++ : "number:" + number, chapter);
        }
        for (LibraryChapter chapter : incoming == null ? List.<LibraryChapter>of() : incoming) {
            if (chapter == null) continue;
            String number = DownloadCompletionVerifier.number(chapter.chapterNumber());
            String key = number.isBlank() ? "anonymous:" + anonymous++ : "number:" + number;
            LibraryChapter previous = chapters.get(key);
            chapters.put(key, previous == null ? chapter : preserveIdentity(previous, chapter));
        }
        return List.copyOf(chapters.values());
    }

    private static LibraryChapter preserveIdentity(LibraryChapter previous, LibraryChapter incoming) {
        if (previous == incoming || previous.id() == null || previous.id().isBlank()) return incoming;
        if (previous.id().equals(incoming.id())) return incoming.preserveSegmentCheckpointFrom(previous);
        return new LibraryChapter(previous.id(), incoming.label(), incoming.chapterNumber(), incoming.pageCount(),
            incoming.releaseDate(), incoming.available(), incoming.archivePath(), incoming.sourceUrl(),
            incoming.qualityStatus(), incoming.expectedPageCount(), incoming.missingPageCount(), incoming.missingPages(),
            incoming.qualityNotes(), incoming.ingestStatus(), incoming.ingestRevision(), incoming.ingestedPageCount(),
            incoming.ingestedAt(), incoming.ingestError(), incoming.ingestManifestPath(), incoming.updatedAt(),
            incoming.sourcePageCount(), incoming.expectedSegmentCount(), incoming.ingestedSegmentCount(), incoming.segmentsReady())
            .preserveSegmentCheckpointFrom(previous);
    }
}
