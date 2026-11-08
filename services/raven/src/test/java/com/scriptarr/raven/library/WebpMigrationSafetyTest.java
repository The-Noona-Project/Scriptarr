package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Migration opt-in, chapter fairness, old-reader preservation and startup fence regressions. */
class WebpMigrationSafetyTest {
    /** Durable explicit pause survives a process with an enabled environment default. */
    @Test void controlIsOffUntilExplicitStartAndPauseSurvivesRestart() {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient(); Map<String, String> env = Map.of("SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED", "true");
        WebpMigrationControl control = new WebpMigrationControl(broker, env); assertFalse(control.enabled());
        control.set(true, "owner"); assertTrue(new WebpMigrationControl(broker, env).enabled());
        control.set(false, "owner"); assertFalse(new WebpMigrationControl(broker, Map.of("SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED", "true", "SCRIPTARR_RAVEN_WEBP_MIGRATION_ENABLED", "true")).enabled());
    }

    /** Malformed durable control cannot turn a paused deployment into an automatic migration. */
    @Test void malformedMigrationIntentFailsClosed() {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient(); broker.putJob("raven_webp_migration_control", Map.of("jobId", "raven_webp_migration_control", "kind", "raven-webp-migration-control", "ownerService", "scriptarr-raven", "payload", Map.of("enabled", "true")));
        assertThrows(IllegalStateException.class, () -> new WebpMigrationControl(broker, Map.of("SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED", "true")).enabled());
    }

    /** Interrupted whole-library scheduling repairs an absent type without granting failed work another attempt. */
    @Test void recoveryCreatesMissingTypeButDoesNotRetryKnownFailure() throws Exception {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient(); LibraryService library = mock(LibraryService.class); ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(library.listCompactTitleRows(anyMap())).thenReturn(List.of(Map.of("id", "a", "title", "A", "libraryTypeSlug", "manga", "chapterCount", 1), Map.of("id", "b", "title", "B", "libraryTypeSlug", "manhwa", "chapterCount", 1)));
        broker.putJob("ingestrun_known_failed", Map.of("jobId", "ingestrun_known_failed", "ownerService", "scriptarr-raven", "kind", "raven-library-ingest", "status", "failed", "payload", Map.of("format", "avif", "mode", "avif-force-rebuild", "libraryTypeSlug", "manga"), "result", Map.of()));
        LibraryIngestRunService runs = new LibraryIngestRunService(library, broker, logger); ObjectMapper json = new ObjectMapper();
        try {
            runs.ensureMigrationTypes(json.convertValue(broker.listJobs("scriptarr-raven", "raven-library-ingest", ""), List.class));
            runs.ensureMigrationTypes(json.convertValue(broker.listJobs("scriptarr-raven", "raven-library-ingest", ""), List.class));
            var jobs = broker.listJobs("scriptarr-raven", "raven-library-ingest", ""); assertEquals(2, jobs.size());
            for (var job : jobs) if ("manga".equals(job.path("payload").path("libraryTypeSlug").asText())) assertEquals("failed", job.path("status").asText());
        } finally { runs.shutdown(); }
    }

    /** A background pass checkpoints one chapter and releases the lock for a foreground append. */
    @Test void migrationYieldsBetweenChaptersForForegroundWork(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root, false); LibraryChapter first = fixture.title.chapters().getFirst();
        when(fixture.ingest.canReuseReadyChapter(any())).thenAnswer(call -> "ready".equals(((LibraryChapter) call.getArgument(0)).ingestStatus()));
        when(fixture.ingest.ingestChapter(any(), any(), any(), any())).thenAnswer(call -> new LibraryIngestResult("ready", "avif-1111111111111111", 1, "2026-11-08T00:00:00Z", root.resolve("manifest.json").toString(), List.of("p000001.avif")));
        fixture.library.ingestTitle("title", "migration", () -> false, value -> { }, true);
        verify(fixture.ingest, times(1)).ingestChapter(any(), any(), any(), any());
        assertEquals(1, fixture.library.findTitleById("title").chapters().stream().filter(chapter -> "ready".equals(chapter.ingestStatus())).count());
        assertEquals(1, fixture.library.findTitleById("title").chapters().stream().filter(chapter -> "pending".equals(chapter.ingestStatus())).count());
        fixture.library.ingestTitle("title", "foreground");
        verify(fixture.ingest, times(2)).ingestChapter(any(), any(), any(), any());
        assertTrue(fixture.library.findTitleById("title").chapters().stream().allMatch(chapter -> first.archivePath().equals(chapter.archivePath())));
    }

    /** Failure of the replacement codec never changes a still-valid AVIF chapter into a failed reader state. */
    @Test void failedMigrationPreservesExistingReadyChapter(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root, true); LibraryChapter before = fixture.title.chapters().getFirst();
        when(fixture.ingest.canReuseReadyChapter(any())).thenAnswer(call -> "ready".equals(((LibraryChapter) call.getArgument(0)).ingestStatus()));
        when(fixture.ingest.ingestChapter(any(), any(), any(), any())).thenThrow(new LibraryIngestException("worker_unavailable", "Remote worker failed."));
        assertThrows(LibraryIngestException.class, () -> fixture.library.ingestTitle("title", "migration", () -> false, value -> { }, true));
        assertEquals(before, fixture.library.findTitleById("title").chapters().getFirst());
        assertEquals("failed", fixture.broker.listDownloadTasks().get(0).path("status").asText());
    }

    /** A constructor restores a persisted fence before even a direct queued ingest can enter its writer lease. */
    @Test void startupRestoresFenceBeforeAnyWriter(@TempDir Path root) throws Exception {
        Path journal = root.resolve(".content-maintenance"); Files.createDirectories(journal);
        new ObjectMapper().writeValue(journal.resolve("startup-fence.json").toFile(), Map.of("operationId", "startup-fence", "keys", List.of("title:title")));
        Fixture fixture = fixture(root, false);
        try { assertThrows(IllegalStateException.class, () -> fixture.library.ingestTitle("title", "recovery")); verifyNoInteractions(fixture.ingest); }
        finally { ContentMaintenance.release(root, "startup-fence"); }
    }

    /** @param root isolated catalog root @param ready whether the first chapter already has readable AVIF @return real library with a controlled codec @throws Exception when fixture writes fail */
    private static Fixture fixture(Path root, boolean ready) throws Exception {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient(); ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
        LibraryIngestService ingest = mock(LibraryIngestService.class); LibraryService library = new LibraryService(broker, new RavenSettingsService(broker, logger, List.of()), logger, ingest);
        Path source = DerivedPageManifestTest.source(root);
        LibraryChapter first = new LibraryChapter("first", "Chapter 1", "1", 1, "", true, source.toString(), "", "clean", 1, 0, List.of(), List.of(), ready ? "ready" : "pending", ready ? "avif-1111111111111111" : "", ready ? 1 : 0, ready ? "2026-11-08T00:00:00Z" : null, "", ready ? root.resolve("old.json").toString() : "", "2026-11-08T00:00:00Z");
        LibraryChapter last = new LibraryChapter("last", "Chapter 2", "2", 1, "", true, source.toString(), "", "2026-11-08T00:00:00Z");
        LibraryTitle title = new LibraryTitle("title", "Fixture", "Manga", "Manga", "manga", "active", "2", "", "", "", 2, 2, "", List.of(), List.of(), "", "", List.of(), "", "https://example.invalid/cover.jpg", "", root.toString(), List.of(first, last), "2026-11-08T00:00:00Z");
        ObjectMapper json = new ObjectMapper(); broker.putLibraryTitle("title", json.convertValue(title, Map.class));
        broker.putLibraryChapters("title", Map.of("chapters", json.convertValue(title.chapters(), List.class))); return new Fixture(broker, library, ingest, title);
    }

    /** Real catalog and library combined with only the encoder boundary stubbed. */
    private record Fixture(FakeRavenBrokerClient broker, LibraryService library, LibraryIngestService ingest, LibraryTitle title) { }
}
