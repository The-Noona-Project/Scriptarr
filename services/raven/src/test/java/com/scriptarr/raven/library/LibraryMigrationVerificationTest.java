package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Real saved manifests exercise migration proof reuse without running an encoder or any external service. */
class LibraryMigrationVerificationTest {
    /** Each unchanged chapter is checked once on first visit and once in the mandatory final sweep. */
    @Test void verificationCostIsLinearAcrossYieldedPasses(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root, 6);
        for (int index = 0; index < 5; index++) pass(fixture.library, () -> false);
        assertTrue(fixture.library.findTitleById("title").chapters().stream().allMatch(chapter -> "ready".equals(chapter.ingestStatus())));
        assertEquals(12, fixture.verifications.values().stream().mapToInt(AtomicInteger::get).sum(), "Yielded migration must not hash an already verified prefix for every following chapter.");
        verify(fixture.ingest, times(5)).ingestChapter(any(), any(), any(), any());
        fixture.library.ingestTitle("title", "foreground");
        assertEquals(18, fixture.verifications.values().stream().mapToInt(AtomicInteger::get).sum(), "Foreground ingest keeps its independent strict validation.");
    }

    /** Appended chapters join the same ordered scope and cannot be skipped by a previous prefix cursor. */
    @Test void appendedChapterMustFinishBeforeCompletion(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root, 3); pass(fixture.library, () -> false);
        List<LibraryChapter> chapters = new ArrayList<>(fixture.library.findTitleById("title").chapters());
        LibraryChapter appended = saved(root, 3); fixture.ready.put(appended.id(), appended); chapters.add(pending(appended));
        fixture.broker.putLibraryChapters("title", Map.of("chapters", fixture.json.convertValue(chapters, List.class)));
        pass(fixture.library, () -> false);
        assertEquals("pending", fixture.library.findTitleById("title").chapters().getLast().ingestStatus());
        pass(fixture.library, () -> false);
        assertTrue(fixture.library.findTitleById("title").chapters().stream().allMatch(chapter -> "ready".equals(chapter.ingestStatus())));
        verify(fixture.ingest, times(3)).ingestChapter(any(), any(), any(), any());
    }

    /** Ready catalog rows after a one-chapter yield cannot bypass the pending fresh verification of an already-ready tail. */
    @Test void allReadyMetadataStillRequiresTheFinalSweep(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root, 3);
        List<LibraryChapter> chapters = new ArrayList<>(fixture.library.findTitleById("title").chapters()); chapters.set(2, fixture.ready.get("c2"));
        fixture.broker.putLibraryChapters("title", Map.of("chapters", fixture.json.convertValue(chapters, List.class)));
        Path tile = Path.of(fixture.ready.get("c2").ingestManifestPath()).getParent().resolve("p000001-s0001.webp");
        Files.write(tile, new byte[]{8, 9});
        try (var ignored = IngestExecutionContext.enter("migration", Map.of("runId", "run", "taskId", "task"))) {
            LibraryService.MigrationPass first = fixture.library.ingestMigrationTitle("title", "migration", () -> false, value -> { });
            assertTrue(first.pending(), "The scheduler must consume this explicit outcome instead of treating all-ready catalog rows as completion.");
            assertTrue(first.title().chapters().stream().allMatch(chapter -> "ready".equals(chapter.ingestStatus())));
            assertEquals("queued", fixture.broker.listDownloadTasks().get(0).path("status").asText());
            assertThrows(LibraryIngestException.class, () -> fixture.library.ingestMigrationTitle("title", "migration", () -> false, value -> { }));
            assertNotEquals("completed", fixture.broker.listDownloadTasks().get(0).path("status").asText());
        }
    }

    /** A new process-local service cannot trust a cursor or hash result from the previous service. */
    @Test void restartRebuildsStrictProofBeforeCompletion(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root, 3); pass(fixture.library, () -> false);
        int firstBefore = fixture.verifications.get("c0").get();
        LibraryService restarted = library(fixture.broker, fixture.logger, fixture.ingest);
        pass(restarted, () -> false);
        assertEquals(firstBefore + 2, fixture.verifications.get("c0").get(), "Restart must revalidate the earlier ready chapter and then include it in final verification.");
        assertTrue(restarted.findTitleById("title").chapters().stream().allMatch(chapter -> "ready".equals(chapter.ingestStatus())));
    }

    /** Changed physical evidence invalidates the prefix before migration advances to a later pending chapter. */
    @Test void missingPrefixTileInvalidatesEvidence(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root, 3); pass(fixture.library, () -> false);
        Files.delete(Path.of(fixture.ready.get("c0").ingestManifestPath()).getParent().resolve("p000001-s0001.webp"));
        pass(fixture.library, () -> false);
        verify(fixture.ingest).ingestChapter(any(), argThat(chapter -> "c0".equals(chapter.id())), any(), any());
        assertFalse("completed".equals(fixture.broker.listDownloadTasks().get(0).path("status").asText()));
    }

    /** A final fresh content sweep catches corruption even when cheap file evidence is deliberately unchanged. */
    @Test void finalSweepRejectsSameSizeRestoredTimeCorruption(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root, 3); pass(fixture.library, () -> false);
        Path tile = Path.of(fixture.ready.get("c0").ingestManifestPath()).getParent().resolve("p000001-s0001.webp");
        FileTime timestamp = Files.getLastModifiedTime(tile); Files.write(tile, new byte[]{8, 9}); Files.setLastModifiedTime(tile, timestamp);
        LibraryIngestException error = assertThrows(LibraryIngestException.class, () -> pass(fixture.library, () -> false));
        assertEquals("migration_verification_failed", error.failureCode());
        verify(fixture.ingest, never()).ingestChapter(any(), argThat(chapter -> "c0".equals(chapter.id())), any(), any());
        assertEquals("failed", fixture.library.findTitleById("title").chapters().getFirst().ingestStatus());
        assertFalse("completed".equals(fixture.broker.listDownloadTasks().get(0).path("status").asText()));
    }

    /** Cancellation discards the process-local optimization, preserving a strict next attempt. */
    @Test void cancellationDiscardsPriorProof(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root, 3); pass(fixture.library, () -> false);
        assertThrows(LibraryIngestException.class, () -> pass(fixture.library, () -> true));
        int firstBefore = fixture.verifications.get("c0").get(); pass(fixture.library, () -> false);
        assertEquals(firstBefore + 2, fixture.verifications.get("c0").get());
    }

    /** Metadata changes to a real content checkpoint invalidate that chapter without rereading an unchanged earlier prefix. */
    @Test void changedCheckpointInvalidatesAffectedPrefix(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root, 3); pass(fixture.library, () -> false);
        List<Map<String, Object>> rows = fixture.json.convertValue(fixture.library.findTitleById("title").chapters(), List.class);
        rows.get(1).put("pageCount", 2); fixture.broker.putLibraryChapters("title", Map.of("chapters", rows));
        int firstBefore = fixture.verifications.get("c0").get(), changedBefore = fixture.verifications.get("c1").get();
        pass(fixture.library, () -> false);
        assertEquals(firstBefore + 1, fixture.verifications.get("c0").get(), "Only the final sweep should rehash the unchanged earlier chapter.");
        assertEquals(changedBefore + 2, fixture.verifications.get("c1").get());
    }

    /** @param service migration library @param cancelled actual cancellation @throws Exception when migration fails */
    private static void pass(LibraryService service, java.util.function.BooleanSupplier cancelled) throws Exception {
        try (var ignored = IngestExecutionContext.enter("migration", Map.of("runId", "run", "taskId", "task"))) {
            service.ingestTitle("title", "migration", cancelled, value -> { }, true);
        }
    }

    /** @param root isolated files @param count chapter count @return real catalog with only encoding stubbed @throws Exception on fixture I/O */
    private static Fixture fixture(Path root, int count) throws Exception {
        FakeRavenBrokerClient broker = new OrderedBroker(); ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
        LibraryIngestService ingest = mock(LibraryIngestService.class); ObjectMapper json = new ObjectMapper();
        Map<String, LibraryChapter> ready = new ConcurrentHashMap<>(); Map<String, AtomicInteger> verifications = new ConcurrentHashMap<>(); List<LibraryChapter> chapters = new ArrayList<>();
        for (int index = 0; index < count; index++) { LibraryChapter chapter = saved(root, index); ready.put(chapter.id(), chapter); chapters.add(index == 0 ? chapter : pending(chapter)); }
        when(ingest.canReuseReadyChapter(any())).thenAnswer(call -> { LibraryChapter chapter = call.getArgument(0); verifications.computeIfAbsent(chapter.id(), key -> new AtomicInteger()).incrementAndGet(); return DerivedPageManifest.reusable(chapter); });
        when(ingest.ingestChapter(any(), any(), any(), any())).thenAnswer(call -> { LibraryChapter chapter = ready.get(((LibraryChapter) call.getArgument(1)).id()); return new LibraryIngestResult("ready", chapter.ingestRevision(), 1, chapter.ingestedAt(), chapter.ingestManifestPath(), List.of()); });
        LibraryTitle title = new LibraryTitle("title", "Migration", "Manga", "Manga", "manga", "active", "6", "", "", "", count, count, "", List.of(), List.of(), "", "", List.of(), "", "", "", root.toString(), chapters, "2026-11-08T00:00:00Z");
        broker.putLibraryTitle("title", json.convertValue(title, Map.class)); broker.putLibraryChapters("title", Map.of("chapters", json.convertValue(chapters, List.class)));
        return new Fixture(broker, logger, ingest, library(broker, logger, ingest), json, ready, verifications);
    }

    /** @param broker isolated catalog @param logger isolated root @param ingest controlled encoder @return new service without prior process evidence */
    private static LibraryService library(FakeRavenBrokerClient broker, ScriptarrLogger logger, LibraryIngestService ingest) {
        return new LibraryService(broker, new RavenSettingsService(broker, logger, List.of()), logger, ingest);
    }

    /** @param root isolated root @param index stable chapter ordinal @return complete real segmented WebP fixture @throws Exception on fixture I/O */
    private static LibraryChapter saved(Path root, int index) throws Exception {
        LibraryChapter chapter = DerivedPageManifestTest.chapter(root.resolve("chapter-" + index)); ObjectMapper json = new ObjectMapper();
        ObjectNode manifest = (ObjectNode) json.readTree(Path.of(chapter.ingestManifestPath()).toFile()); manifest.put("chapterId", "c" + index); json.writeValue(Path.of(chapter.ingestManifestPath()).toFile(), manifest);
        ObjectNode row = json.valueToTree(chapter); row.put("id", "c" + index).put("chapterNumber", Integer.toString(1000 - index));
        DerivedPageManifest.catalogFields(json.treeToValue(row, LibraryChapter.class)).forEach((key, value) -> row.set(key, json.valueToTree(value)));
        return json.treeToValue(row, LibraryChapter.class);
    }

    /** @param ready existing real output @return durable CBZ-only pending state without invented readiness */
    private static LibraryChapter pending(LibraryChapter ready) {
        return new LibraryChapter(ready.id(), ready.label(), ready.chapterNumber(), 1, "", true, ready.archivePath(), "", "2026-11-08T00:00:00Z");
    }

    /** Controlled codec over a real broker and real immutable source/output files. */
    private record Fixture(FakeRavenBrokerClient broker, ScriptarrLogger logger, LibraryIngestService ingest, LibraryService library,
                           ObjectMapper json, Map<String, LibraryChapter> ready, Map<String, AtomicInteger> verifications) { }

    /** Match the durable SQL chapter-number ordering rather than the generic fake's append-on-update order. */
    private static final class OrderedBroker extends FakeRavenBrokerClient {
        private final ObjectMapper json = new ObjectMapper();

        /** @param titleId exact title @return the same complete catalog with chapters in durable descending order */
        @Override public com.fasterxml.jackson.databind.JsonNode getLibraryTitle(String titleId) {
            ObjectNode title = (ObjectNode) super.getLibraryTitle(titleId);
            List<com.fasterxml.jackson.databind.JsonNode> chapters = new ArrayList<>(); title.path("chapters").forEach(chapters::add);
            chapters.sort(java.util.Comparator.comparingInt((com.fasterxml.jackson.databind.JsonNode chapter) -> chapter.path("chapterNumber").asInt()).reversed());
            title.set("chapters", json.valueToTree(chapters)); return title;
        }
    }
}
