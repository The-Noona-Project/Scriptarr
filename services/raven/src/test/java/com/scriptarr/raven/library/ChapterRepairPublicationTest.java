package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Fault injection for isolated, chapter-scoped publication and crash recovery. */
class ChapterRepairPublicationTest {
    private static final String TASK = "task_repair_" + "a".repeat(64);

    /** Catalog outage preserves old bytes and reader files; restart completes the same durable intent. */
    @Test void restartAfterPublicationIntentPreservesOriginalUntilAcknowledgement(@TempDir Path root) throws Exception {
        Fixture f = new Fixture(root); String hash = WebpChapterEncoder.sha256(f.original); var modified = Files.getLastModifiedTime(f.sibling);
        ChapterRepairPublication failed = f.publisher(true, false);
        assertThrows(IllegalStateException.class, () -> failed.publish(TASK, "title", "chapter", f.candidate, f.old.sourceUrl(), f.old.chapterNumber(), () -> false, p -> {}));
        assertEquals(f.old, f.current.get()); assertEquals(hash, WebpChapterEncoder.sha256(f.original));
        assertEquals("publishing", new ObjectMapper().readTree(f.journal.toFile()).path("phase").asText());
        assertTrue(Files.exists(f.oldReader));
        ChapterRepairPublication recovered = f.publisher(false, false);
        assertTrue(recovered.completed(TASK, "title", "chapter"));
        assertTrue(f.current.get().segmentsReady()); assertEquals("clean", f.current.get().qualityStatus());
        assertTrue(DerivedPageManifest.reusable(f.current.get())); assertFalse(Files.exists(f.original));
        assertEquals(hash, WebpChapterEncoder.sha256(f.journal.getParent().resolve("original.cbz")));
        assertTrue(Files.exists(f.oldReader)); assertEquals("healthy sibling", Files.readString(f.sibling));
        assertEquals(modified, Files.getLastModifiedTime(f.sibling));
        assertTrue(recovered.completed(TASK, "title", "chapter"));
        verify(f.ingest, times(1)).ingestChapter(any(), any(), any(), any());
    }

    /** A lost successful broker response re-reads the exact saved chapter instead of republishing or failing it. */
    @Test void lostSuccessfulAcknowledgementReconcilesCommittedIdentity(@TempDir Path root) throws Exception {
        Fixture f = new Fixture(root);
        LibraryChapter result = f.publisher(false, true).publish(TASK, "title", "chapter", f.candidate, f.old.sourceUrl(), f.old.chapterNumber(), () -> false, p -> {});
        assertEquals(result, f.current.get()); assertTrue(DerivedPageManifest.reusable(result));
        assertEquals("completed", new ObjectMapper().readTree(f.journal.toFile()).path("phase").asText());
    }

    /** Cancellation and failed conversion cannot replace the current chapter or healthy siblings. */
    @Test void cancellationAndConversionFailureKeepPublishedChapter(@TempDir Path root) throws Exception {
        Fixture f = new Fixture(root);
        assertThrows(InterruptedException.class, () -> f.publisher(false, false).publish(TASK, "title", "chapter", f.candidate, f.old.sourceUrl(), f.old.chapterNumber(), () -> true, p -> {}));
        when(f.ingest.ingestChapter(any(), any(), any(), any())).thenThrow(new LibraryIngestException("unavailable", null));
        assertThrows(LibraryIngestException.class, () -> f.publisher(false, false).publish(TASK, "title", "chapter", f.candidate, f.old.sourceUrl(), f.old.chapterNumber(), () -> false, p -> {}));
        assertEquals(f.old, f.current.get()); assertTrue(Files.exists(f.original)); assertTrue(Files.exists(f.oldReader));
    }

    /** A title maintenance fence also blocks completed-intent recovery and its canonical writes. */
    @Test void completedRecoveryRespectsTitleMaintenance(@TempDir Path root) throws Exception {
        Fixture f = new Fixture(root);
        assertThrows(IllegalStateException.class, () -> f.publisher(true, false).publish(TASK, "title", "chapter", f.candidate, f.old.sourceUrl(), "1", () -> false, p -> {}));
        ContentMaintenance.block(root, "qa_repair_fence", List.of("title:title"));
        try {
            assertThrows(IllegalStateException.class, () -> f.publisher(false, false).completed(TASK, "title", "chapter"));
            assertEquals(f.old, f.current.get()); assertTrue(Files.exists(f.original));
        } finally { ContentMaintenance.release(root, "qa_repair_fence"); }
        assertTrue(f.publisher(false, false).completed(TASK, "title", "chapter"));
    }

    /** A changed frozen source or number fails before conversion, even when a candidate is complete. */
    @Test void changedFrozenSelectionCannotPublish(@TempDir Path root) throws Exception {
        Fixture f = new Fixture(root);
        assertThrows(IOException.class, () -> f.publisher(false, false).publish(TASK, "title", "chapter", f.candidate, "https://weebcentral.com/chapters/OTHER", "1", () -> false, p -> {}));
        assertThrows(IOException.class, () -> f.publisher(false, false).publish(TASK, "title", "chapter", f.candidate, f.old.sourceUrl(), "2", () -> false, p -> {}));
        verifyNoInteractions(f.ingest); assertEquals(f.old, f.current.get()); assertTrue(Files.exists(f.original));
    }

    /** Summary acknowledgement is part of publication; recovery retries it without encoding or rewriting siblings. */
    @Test void summaryFailureRecoversSameChapterWithoutAnotherConversion(@TempDir Path root) throws Exception {
        Fixture f = new Fixture(root); java.util.concurrent.atomic.AtomicBoolean fail = new java.util.concurrent.atomic.AtomicBoolean(true);
        ChapterRepairPublication publisher = new ChapterRepairPublication(root, f.ingest, new LibraryTitleLocks(), id -> f.title,
            (id, ready) -> { f.current.set(ready); return ready; }, id -> {if (fail.get()) throw new IllegalStateException("summary unavailable");});
        assertThrows(IllegalStateException.class, () -> publisher.publish(TASK, "title", "chapter", f.candidate, f.old.sourceUrl(), "1", () -> false, p -> {}));
        assertTrue(Files.exists(f.original)); fail.set(false);
        assertTrue(publisher.completed(TASK, "title", "chapter")); assertFalse(Files.exists(f.original));
        verify(f.ingest, times(1)).ingestChapter(any(), any(), any(), any());
    }

    /** Embedded missing-page evidence rejects a superficially complete image-count candidate before conversion. */
    @Test void placeholderCandidateCannotPublish(@TempDir Path root) throws Exception {
        Fixture f = new Fixture(root);
        try (var zip = new java.util.zip.ZipOutputStream(Files.newOutputStream(f.candidate))) {
            zip.putNextEntry(new java.util.zip.ZipEntry("001.png")); zip.write(new byte[]{1, 2}); zip.closeEntry();
            ArchiveDownloadEvidence.write(zip, f.old.sourceUrl(), 1, List.of(1), List.of("unavailable"), "partial");
        }
        assertThrows(IOException.class, () -> f.publisher(false, false).publish(TASK, "title", "chapter", f.candidate, f.old.sourceUrl(), f.old.chapterNumber(), () -> false, p -> {}));
        assertEquals(f.old, f.current.get()); assertTrue(Files.exists(f.original)); verifyNoInteractions(f.ingest);
    }

    /** The worker may resolve only the candidate bound to the journal, task, title, chapter, digest and size. */
    @Test void rejectsForeignCandidateAndBindings(@TempDir Path root) throws Exception {
        Fixture f = new Fixture(root);
        assertThrows(IOException.class, () -> f.publisher(false, false).publish(TASK, "title", "chapter", f.original, f.old.sourceUrl(), f.old.chapterNumber(), () -> false, p -> {}));
        f.publisher(false, false).publish(TASK, "title", "chapter", f.candidate, f.old.sourceUrl(), f.old.chapterNumber(), () -> false, p -> {});
        String hash = WebpChapterEncoder.sha256(f.candidate); long size = Files.size(f.candidate);
        assertEquals(f.candidate, ChapterRepairPublication.input(root, TASK, "title", "chapter", hash, size));
        assertThrows(IOException.class, () -> ChapterRepairPublication.input(root, TASK, "other", "chapter", hash, size));
        assertThrows(IOException.class, () -> ChapterRepairPublication.input(root, TASK, "title", "chapter", "b".repeat(64), size));
        assertThrows(IOException.class, () -> ChapterRepairPublication.input(root, TASK, "title", "chapter", hash, size + 1));
        assertThrows(IOException.class, () -> ChapterRepairPublication.journal(root, TASK, ".."));
    }

    /** Real private CBZ, real manifest validation, and a controllable catalog acknowledgement boundary. */
    private static final class Fixture {
        private final LibraryTitle title = mock(LibraryTitle.class);
        private final LibraryIngestService ingest = mock(LibraryIngestService.class);
        private final AtomicReference<LibraryChapter> current = new AtomicReference<>();
        private final Path root, candidate, original, sibling, oldReader, journal;
        private final LibraryChapter old;
        /** @param root isolated root @throws Exception when fixture writes fail */
        private Fixture(Path root) throws Exception {
            this.root = root;
            Path folder = root.resolve("downloaded/manhua/Title"); Files.createDirectories(folder);
            original = folder.resolve("Title c001 [Scriptarr].cbz"); Files.writeString(original, "original retained archive");
            sibling = folder.resolve("Title c002 [Scriptarr].cbz"); Files.writeString(sibling, "healthy sibling");
            oldReader = root.resolve("ingested/old/page.webp"); Files.createDirectories(oldReader.getParent()); Files.writeString(oldReader, "old reader");
            journal = ChapterRepairPublication.journal(root, TASK, "chapter"); Files.createDirectories(journal.getParent());
            LibraryChapter derived = DerivedPageManifestTest.chapter(journal.getParent().resolve("source")); candidate = Path.of(derived.archivePath());
            old = new LibraryChapter("chapter", "Chapter 1", "1", 1, "", true, original.toString(), "https://weebcentral.com/chapters/ABC", "partial", 1, 1, List.of(1), List.of("source gap"), null);
            current.set(old); when(title.id()).thenReturn("title"); when(title.downloadRoot()).thenReturn(folder.toString());
            when(title.sourceUrl()).thenReturn("https://weebcentral.com/series/ABC/Title"); when(title.chapters()).thenAnswer(i -> List.of(current.get()));
            when(ingest.ingestChapter(any(), any(), any(), any())).thenReturn(new LibraryIngestResult("ready", derived.ingestRevision(), 1,
                derived.ingestedAt(), derived.ingestManifestPath(), List.of()));
        }
        /** @param fail refuse catalog commit @param lost lose successful response @return independent coordinator over the same durable journal */
        private ChapterRepairPublication publisher(boolean fail, boolean lost) {
            return new ChapterRepairPublication(root, ingest, new LibraryTitleLocks(), id -> title, (id, ready) -> {
                if (fail) throw new IllegalStateException("catalog unavailable");
                current.set(ready); if (lost) throw new IllegalStateException("response lost"); return ready;
            });
        }
    }
}
