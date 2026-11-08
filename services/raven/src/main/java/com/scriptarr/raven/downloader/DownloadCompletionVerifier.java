package com.scriptarr.raven.downloader;

import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;

import java.io.OutputStream;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

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

    /** Verify the archive and reusable reader-page manifest together. */
    boolean healthy(LibraryChapter chapter) {
        return chapter != null && chapter.available() && chapter.pageCount() > 0
            && archiveImageCount(chapter.archivePath()) == chapter.pageCount()
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
        try {
            Path archive = Path.of(filename);
            if (!Files.isRegularFile(archive) || Files.size(archive) == 0) return -1;
            int count = 0;
            try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(archive))) {
                ZipEntry entry;
                while ((entry = zip.getNextEntry()) != null) {
                    String name = entry.getName().toLowerCase(Locale.ROOT);
                    boolean image = !entry.isDirectory() && name.matches(".*\\.(?:jpe?g|png|webp|avif|gif|bmp)$");
                    long bytes = zip.transferTo(OutputStream.nullOutputStream());
                    zip.closeEntry();
                    if (image) {if (bytes == 0) return -1;count++;}
                }
            }
            return count > 0 ? count : -1;
        } catch (Exception error) {return -1;}
    }

    private static String text(Object value) {return value == null ? "" : String.valueOf(value).trim();}
}
