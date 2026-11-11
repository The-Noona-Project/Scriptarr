package com.scriptarr.raven.downloader;

import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.ArchiveDownloadEvidence;
import com.scriptarr.raven.library.LibraryNaming;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.settings.RavenNamingSettings;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;

/** Reconstruct only verifiable canonical chapter rows without changing archive bytes or timestamps. */
final class CanonicalArchiveRecovery {
    private final LibraryService library;
    private final DownloadCompletionVerifier verifier;

    /** Assemble catalog-backed archive recovery. */
    CanonicalArchiveRecovery(LibraryService library, DownloadCompletionVerifier verifier) {
        this.library = library;
        this.verifier = verifier;
    }

    /** Resolve or reconstruct canonical catalog rows before any provider request. */
    LibraryTitle inspect(Map<String, Object> task, DownloadRequest request, List<Map<String, String>> expected,
        Path downloadsRoot, RavenNamingSettings naming, BooleanSupplier cancelled) throws Exception {
        if (library == null || downloadsRoot == null || expected.isEmpty() || !text(request.replacementTitleId()).isEmpty()) return null;
        check(cancelled);
        String id = text(task.get("titleId"));
        if (id.isEmpty() && request.selectedDownload() != null) id = text(request.selectedDownload().get("appendTitleId"));
        LibraryTitle title = id.isEmpty() ? null : library.findTitle(id);
        String rootValue = title != null && !text(title.downloadRoot()).isEmpty() ? title.downloadRoot() : text(task.get("downloadRoot"));
        Path root = rootValue.isEmpty()
            ? downloadsRoot.resolve("downloaded").resolve(LibraryNaming.normalizeTypeSlug(request.requestType())).resolve(LibraryNaming.sanitizeTitleFolder(request.titleName()))
            : Path.of(rootValue);
        root = root.toAbsolutePath().normalize();
        Path canonicalBase = downloadsRoot.resolve("downloaded").toAbsolutePath().normalize();
        if (!root.startsWith(canonicalBase) || root.equals(canonicalBase) || !Files.isDirectory(root)) return title;
        if (title == null) {
            for (LibraryTitle candidate : library.listTitles()) {
                if (candidate != null && !text(candidate.downloadRoot()).isEmpty()
                    && root.equals(Path.of(candidate.downloadRoot()).toAbsolutePath().normalize())) {title = candidate;break;}
            }
        }
        Map<String, LibraryChapter> chapters = new LinkedHashMap<>();
        if (title != null && title.chapters() != null) title.chapters().forEach(chapter -> chapters.put(DownloadCompletionVerifier.number(chapter.chapterNumber()), chapter));
        List<Path> archives;
        try (var paths = Files.list(root)) {
            archives = paths.filter(Files::isRegularFile).filter(path -> path.getFileName().toString().toLowerCase(java.util.Locale.ROOT).endsWith(".cbz")).sorted().toList();
        }
        // Prefer the persisted exact path when naming settings or duplicate filenames differ.
        archives = archives.stream().sorted(java.util.Comparator.<Path>comparingInt(path ->
            chapters.values().stream().anyMatch(chapter -> samePath(chapter.archivePath(), path)) ? 0 : 1).thenComparing(Path::toString)).toList();
        boolean changed = false;
        for (Path archive : archives) {
            check(cancelled);
            LibraryChapter byPath = chapters.values().stream().filter(chapter -> samePath(chapter.archivePath(), archive)).findFirst().orElse(null);
            String number = byPath == null
                ? DownloadCompletionVerifier.number(LibraryNaming.extractChapterNumber(archive.getFileName().toString(), naming, request.requestType()))
                : DownloadCompletionVerifier.number(byPath.chapterNumber());
            Map<String, String> source = expected.stream().filter(row -> number.equals(DownloadCompletionVerifier.number(row.get("chapter_number")))).findFirst().orElse(null);
            LibraryChapter previous = chapters.get(number);
            if (source == null || verifier.archiveHealthy(previous)) continue;
            int pages = DownloadCompletionVerifier.archiveImageCount(archive.toString());
            if (pages <= 0) continue;
            chapters.put(number, recoveredChapter(previous, source, archive, number, pages));
            changed = true;
        }
        check(cancelled);
        if (changed) {
            String working = text(task.get("workingRoot"));
            title = library.recordDownloadedTitle(request.titleName(), request.requestType(), request.titleUrl(), text(task.get("coverUrl")),
                null, List.copyOf(chapters.values()), working.isEmpty() ? null : Path.of(working), root);
            if (title == null || text(title.id()).isEmpty()) throw new IllegalStateException("Canonical archive recovery could not persist its catalog rows.");
        }
        return title;
    }

    private LibraryChapter recoveredChapter(LibraryChapter previous, Map<String, String> source, Path archive, String number, int pages) throws java.io.IOException {
        ArchiveDownloadEvidence.Quality quality = ArchiveDownloadEvidence.read(archive, text(source.get("href")), pages);
        if (quality != null) return new LibraryChapter(previous == null ? "" : previous.id(),
            previous == null ? text(source.get("chapter_title")) : previous.label(), number, pages,
            previous == null ? text(source.get("release_date")) : previous.releaseDate(), true, archive.toString(), text(source.get("href")),
            quality.status(), quality.pages(), quality.missing().size(), quality.missing(), quality.notes(), previous == null ? null : previous.updatedAt());
        if (previous == null) return new LibraryChapter("", text(source.get("chapter_title")).isEmpty() ? "Chapter " + number : source.get("chapter_title"),
            number, pages, text(source.get("release_date")), true, archive.toString(), text(source.get("href")), null);
        // Stale catalog rows may predate file promotion; retain identity and quality evidence while redoing ingest.
        return new LibraryChapter(previous.id(), previous.label(), number, pages, previous.releaseDate(), true,
            archive.toString(), text(previous.sourceUrl()).isEmpty() ? text(source.get("href")) : previous.sourceUrl(),
            previous.qualityStatus(), Math.max(pages, previous.expectedPageCount()), previous.missingPageCount(),
            previous.missingPages(), previous.qualityNotes(), previous.updatedAt());
    }

    /** Find the exact healthy catalog archive for one planned source chapter. */
    LibraryChapter reusable(LibraryTitle title, Map<String, String> source) {
        if (title == null || title.chapters() == null) return null;
        return title.chapters().stream().filter(chapter -> DownloadCompletionVerifier.matches(chapter, source) && verifier.archiveHealthy(chapter)).findFirst().orElse(null);
    }

    private static boolean samePath(String value, Path path) {
        try {return !text(value).isEmpty() && Path.of(value).toAbsolutePath().normalize().equals(path.toAbsolutePath().normalize());}
        catch (RuntimeException error) {return false;}
    }

    private static void check(BooleanSupplier cancelled) {if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new CancellationException("Canonical archive recovery cancelled.");}
    private static String text(Object value) {return value == null ? "" : String.valueOf(value).trim();}
}
