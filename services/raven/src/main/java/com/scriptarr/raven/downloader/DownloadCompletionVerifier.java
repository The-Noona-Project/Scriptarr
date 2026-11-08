package com.scriptarr.raven.downloader;

import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.ArchiveImageEntries;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;

import java.math.BigDecimal;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Require expected chapters, canonical archives and reader-ready pages before completion. */
final class DownloadCompletionVerifier {
    private final LibraryService library;

    /** Create the reader and archive verifier. */
    DownloadCompletionVerifier(LibraryService library) { this.library = library; }

    /** Verify every expected source chapter against the persisted catalog. */
    boolean complete(LibraryTitle title, List<Map<String, String>> expected) {
        if (title == null || expected == null || expected.isEmpty() || title.chapters() == null) return false;
        return expected.stream().allMatch(row -> title.chapters().stream().anyMatch(chapter -> matches(chapter, row) && healthy(chapter)));
    }

    /** Verify the planned canonical archives separately from reader-page readiness. */
    boolean archivesComplete(LibraryTitle title, List<Map<String, String>> expected) {
        return title != null && expected != null && !expected.isEmpty() && title.chapters() != null
            && expected.stream().allMatch(row -> title.chapters().stream().anyMatch(chapter -> matches(chapter, row) && archiveHealthy(chapter)));
    }

    /** Verify an available catalog chapter still has its complete readable canonical CBZ. */
    boolean archiveHealthy(LibraryChapter chapter) {
        if (chapter == null || !chapter.available()) return false;
        int images = archiveImageCount(chapter.archivePath());
        return images > 0 && (images == chapter.pageCount() || (images == chapter.ingestedPageCount()
            && library != null && library.isReaderReadyChapter(chapter)));
    }

    /** Verify the archive and reusable reader-page manifest together. */
    boolean healthy(LibraryChapter chapter) {
        return archiveHealthy(chapter)
            && library != null && library.isReaderReadyChapter(chapter);
    }

    /** Match source chapter identity by normalized number or URL. */
    static boolean matches(LibraryChapter chapter, Map<String, String> expected) {
        String number = number(expected.get("chapter_number"));
        String url = text(expected.get("href"));
        return (!number.isBlank() && number.equals(number(chapter.chapterNumber())))
            || (!url.isBlank() && url.equals(text(chapter.sourceUrl())));
    }

    /** Normalize a stable chapter number without losing fractional chapters. */
    static String number(Object value) {
        String normalized = text(value).replaceFirst("(?i)^chapter\\s*", "");
        try {return new BigDecimal(normalized).stripTrailingZeros().toPlainString();}
        catch (NumberFormatException error) {return normalized.toLowerCase(Locale.ROOT);}
    }

    /** Count readable nonempty archive images, checking ZIP integrity while reading. */
    static int archiveImageCount(String filename) {
        if (filename == null || filename.isBlank()) return -1;
        try { return ArchiveImageEntries.verifiedCount(Path.of(filename)); }
        catch (RuntimeException error) { return -1; }
    }

    private static String text(Object value) {return value == null ? "" : String.valueOf(value).trim();}
}
