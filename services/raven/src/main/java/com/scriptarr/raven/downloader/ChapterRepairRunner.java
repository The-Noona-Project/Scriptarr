package com.scriptarr.raven.downloader;

import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.library.IngestProgress;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** Execute only frozen selected chapters; incomplete candidates never replace a readable version. */
final class ChapterRepairRunner {
    private ChapterRepairRunner() { }

    /** One source operation whose private destination is already bound to the stable task and chapter. */
    @FunctionalInterface
    interface Source {
        /** @param scope frozen selected source chapter @param destination task-private root @return downloaded candidate and source-quality facts @throws Exception when discovery or transfer fails */
        DownloaderService.ChapterDownloadResult download(Map<String, Object> scope, Path destination) throws Exception;
    }

    /**
     * Commit selected chapters independently and retain unresolved evidence for explicit retry.
     * @param taskId durable repair task @param request frozen series request @param specification frozen selection
     * @param library canonical coordinator @param provider enabled provider @param downloads managed root
     * @param source bounded source download @param cancelled cancellation predicate @param diagnostics durable problems callback
     * @param progress real conversion progress @throws Exception when any selected chapter remains unresolved
     */
    static void run(String taskId, DownloadRequest request, Map<String, Object> specification, LibraryService library,
        DownloadProvider provider, Path downloads, Source source, BooleanSupplier cancelled,
        Consumer<List<Map<String, Object>>> diagnostics, Consumer<IngestProgress> progress) throws Exception {
        String titleId = String.valueOf(specification.get("titleId"));
        Object selected = specification.get("chapters");
        if (!(selected instanceof List<?> scopes) || scopes.isEmpty()) throw new IllegalStateException("The frozen repair selection is unavailable.");
        List<Map<String, Object>> failures = new ArrayList<>(); List<Map<String, String>> currentSource = null;
        int completed = 0;
        for (Object value : scopes) {
            check(cancelled);
            Map<String, Object> scope = map(value); String chapterId = String.valueOf(scope.get("id")), number = String.valueOf(scope.get("chapter_number"));
            try {
                LibraryTitle title = library.findTitle(titleId);
                if (title == null || !request.titleUrl().equals(title.sourceUrl())) throw new IllegalStateException("The saved repair source changed.");
                LibraryChapter old = title.chapters().stream().filter(c -> chapterId.equals(c.id())).findFirst().orElseThrow();
                if (!String.valueOf(scope.get("href")).equals(old.sourceUrl()) || !number.equals(old.chapterNumber())) throw new IllegalStateException("The frozen repair chapter identity changed.");
                if (library.chapterRepairCompleted(taskId, titleId, chapterId)
                    || ("clean".equals(old.qualityStatus()) && old.missingPageCount() == 0 && library.isReaderReadyChapter(old)
                        && new DownloadCompletionVerifier(library).archiveHealthy(old))) {
                    completed++; progress.accept(new IngestProgress("ingesting", old.pageCount(), old.pageCount(), completed, scopes.size(), true)); continue;
                }
                if (currentSource == null) {
                    ChapterDiscoveryResult discovery = provider.discoverChapters(request.titleUrl());
                    check(cancelled);
                    if (!discovery.error().isBlank() || discovery.unavailable() || discovery.chapters().isEmpty()) throw new IllegalStateException("The source chapter list is unavailable.");
                    currentSource = discovery.chapters();
                }
                if (currentSource.stream().noneMatch(row -> String.valueOf(scope.get("href")).equals(row.get("href"))
                    && DownloadCompletionVerifier.number(number).equals(DownloadCompletionVerifier.number(row.get("chapter_number"))))) throw new IllegalStateException("The selected source chapter changed; review its identity.");
                Path destination = downloads.resolve(".chapter-repairs").resolve(taskId).resolve(chapterId).resolve("source");
                DownloaderService.ChapterDownloadResult candidate = source.download(scope, destination);
                check(cancelled);
                if (candidate.archivePath() == null || candidate.missingPageCount() != 0 || !"clean".equals(candidate.qualityStatus())) {
                    library.recordChapterRepairGap(titleId, chapterId, String.valueOf(scope.get("href")), candidate.expectedPageCount(), candidate.missingPages(), candidate.qualityNotes());
                    failures.add(problem(titleId, chapterId, number, "source_unavailable", candidate.missingPageCount(), "source pages remain unavailable or damaged"));
                } else {
                    int before = completed;
                    library.publishChapterRepair(taskId, titleId, chapterId, candidate.archivePath(), String.valueOf(scope.get("href")), number, cancelled,
                        page -> progress.accept(new IngestProgress(page.stage(), page.completedPages(), page.totalPages(), before, scopes.size(), page.advanced(), page.completedSegments(), page.totalSegments())));
                    completed++; progress.accept(new IngestProgress("ingesting", candidate.expectedPageCount(), candidate.expectedPageCount(), completed, scopes.size(), true));
                }
            } catch (InterruptedException | CancellationException stop) { throw stop; }
            catch (Exception failure) {
                String reason = failure.getMessage() == null ? "" : failure.getMessage();
                boolean ownerConflict = reason.contains("repair_owner_conflict");
                failures.add(problem(titleId, chapterId, number, ownerConflict ? "repair_owner_conflict" : "repair_unresolved", 0,
                    ownerConflict ? "conversion belongs to another task; review its durable job before retrying"
                        : reason.contains("changed") ? "source or publication identity changed; review required" : "repair could not be verified; the prior chapter is preserved"));
            }
            diagnostics.accept(List.copyOf(failures));
        }
        diagnostics.accept(List.copyOf(failures));
        if (!failures.isEmpty()) throw new IllegalStateException(String.valueOf(failures.getFirst().get("message")));
    }

    private static Map<String, Object> problem(String title, String chapter, String number, String code, int missing, String reason) {
        return Map.of("titleId", title, "chapterId", chapter, "chapterNumber", number, "code", code, "missingPageCount", missing,
            "message", "Chapter " + number + ": " + reason + ".");
    }
    private static void check(BooleanSupplier cancelled) {
        if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new CancellationException("Chapter repair cancelled.");
    }
    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) { return value instanceof Map<?, ?> ? new LinkedHashMap<>((Map<String, Object>) value) : Map.of(); }
}
