package com.scriptarr.raven.library;

import java.math.BigDecimal;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;
import java.util.function.UnaryOperator;

/** Reconcile archive observations without erasing durable source gaps or newer reader checkpoints. */
final class ScanChapterReconciler {
    private ScanChapterReconciler() { }

    /**
     * Retain chapter identities and explicit gaps while accepting verified filesystem observations.
     * @param existing latest title loaded under its operation lock
     * @param scanned exact observed archives
     * @param ready reader checkpoint verifier
     * @param reconcileReady logical-page checkpoint reconciliation
     * @return complete chapter inventory including unavailable source chapters
     */
    static List<LibraryChapter> merge(LibraryTitle existing, List<LibraryChapter> scanned,
                                      Predicate<LibraryChapter> ready, UnaryOperator<LibraryChapter> reconcileReady) {
        if (existing == null || existing.chapters() == null) return scanned;
        Map<String, LibraryChapter> previous = new LinkedHashMap<>();
        existing.chapters().forEach(chapter -> previous.put(key(chapter), chapter));
        List<LibraryChapter> result = new ArrayList<>();
        for (LibraryChapter chapter : scanned) {
            LibraryChapter saved = previous.remove(key(chapter));
            if (saved == null) { result.add(chapter); continue; }
            boolean samePath;
            try { samePath = Path.of(saved.archivePath()).toAbsolutePath().normalize().equals(Path.of(chapter.archivePath()).toAbsolutePath().normalize()); }
            catch (RuntimeException invalid) { samePath = false; }
            if (samePath && saved.ingestedPageCount() == chapter.pageCount() && ready.test(saved)) {
                result.add(ArchiveDownloadEvidence.withQualityFrom(reconcileReady.apply(saved), chapter));
            } else result.add(withIdentity(saved.id(), chapter));
        }
        for (LibraryChapter absent : previous.values()) result.add(unavailable(absent));
        return List.copyOf(result);
    }

    /** @param chapter previous durable row @return gap with no positive archive or reader readiness claims */
    static LibraryChapter unavailable(LibraryChapter chapter) {
        if (!chapter.available() && "missing".equals(chapter.ingestStatus()) && !Boolean.TRUE.equals(chapter.segmentsReady())) return chapter;
        List<String> notes = new ArrayList<>(chapter.qualityNotes());
        String note = "The canonical archive was not found during the library scan; the source chapter remains unresolved.";
        if (!notes.contains(note)) notes.add(note);
        return new LibraryChapter(chapter.id(), chapter.label(), chapter.chapterNumber(), chapter.pageCount(), chapter.releaseDate(),
            false, chapter.archivePath(), chapter.sourceUrl(), "missing_content", chapter.expectedPageCount(),
            chapter.missingPageCount(), chapter.missingPages(), List.copyOf(notes), "missing", "", 0, null, "", "", chapter.updatedAt(),
            chapter.sourcePageCount(), null, null, false);
    }

    private static String key(LibraryChapter chapter) {
        try { return "number:" + new BigDecimal(chapter.chapterNumber()).stripTrailingZeros().toPlainString(); }
        catch (RuntimeException invalid) { return "id:" + chapter.id(); }
    }

    /** @param id retained durable chapter identity @param chapter new archive observation @return identity-preserving copy */
    static LibraryChapter withIdentity(String id, LibraryChapter chapter) {
        return new LibraryChapter(id, chapter.label(), chapter.chapterNumber(), chapter.pageCount(), chapter.releaseDate(), chapter.available(),
            chapter.archivePath(), chapter.sourceUrl(), chapter.qualityStatus(), chapter.expectedPageCount(), chapter.missingPageCount(),
            chapter.missingPages(), chapter.qualityNotes(), chapter.ingestStatus(), chapter.ingestRevision(), chapter.ingestedPageCount(),
            chapter.ingestedAt(), chapter.ingestError(), chapter.ingestManifestPath(), chapter.updatedAt(), chapter.sourcePageCount(),
            chapter.expectedSegmentCount(), chapter.ingestedSegmentCount(), chapter.segmentsReady());
    }
}
