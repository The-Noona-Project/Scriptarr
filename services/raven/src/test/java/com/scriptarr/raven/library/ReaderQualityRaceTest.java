package com.scriptarr.raven.library;

import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** A late reader failure must not resurrect reset content or overwrite a newer ready checkpoint. */
class ReaderQualityRaceTest {
    /** A completed reset between a read's catalog load and IO failure stays empty. */
    @Test void lateFailureCannotRestoreResetChapters(@TempDir Path root) throws Exception { reproduce(root, "reset"); }

    /** A maintenance fence rejects a reader quality writer before any catalog change. */
    @Test void fencedFailureCannotCheckpoint(@TempDir Path root) throws Exception { reproduce(root, "fence"); }

    /** A newer checkpoint for the same immutable revision wins over an older failed read. */
    @Test void lateFailureCannotOverwriteRepairedCheckpoint(@TempDir Path root) throws Exception { reproduce(root, "repaired"); }

    /** A restored file wins even when catalog timestamps have only whole-second precision. */
    @Test void sameTimestampRestoredVariantIsRechecked(@TempDir Path root) throws Exception { reproduce(root, "restored"); }

    /** Inject a state change after the actual reader payload load but before its missing-file exception. */
    private void reproduce(Path root, String action) throws Exception {
        String operation = "reader-race-" + root.getFileName();
        LibraryChapter chapter = chapter(root, "old");
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient(); broker.setLibraryTitle(title(root, chapter));
        LibraryIngestService ingest = mock(LibraryIngestService.class);
        var reads = new java.util.concurrent.atomic.AtomicInteger();
        when(ingest.readerPageMediaType(any(LibraryChapter.class))).thenReturn("image/webp");
        when(ingest.readIngestedPage(any(LibraryChapter.class), eq(0), eq(0), eq(false))).thenAnswer(call -> {
            if (action.equals("restored") && reads.incrementAndGet() > 1) return new byte[]{1, 2, 3};
            if (action.equals("reset")) broker.putLibraryChapters("title", Map.of("chapters", List.of()));
            else if (action.equals("fence")) ContentMaintenance.block(root, operation, List.of("title:title"));
            else if (action.equals("repaired")) broker.setLibraryTitle(title(root, chapter(root, "repaired")));
            throw new IOException("Injected delayed reader-file failure");
        });
        ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
        LibraryService service = new LibraryService(broker, new RavenSettingsService(broker, logger, List.of()), logger, ingest);
        try {
            assertNull(service.renderReaderPage("title", "chapter", 0, 0, false));
            var current = broker.getLibraryTitle("title").path("chapters");
            assertEquals(action.equals("reset") ? 0 : 1, current.size());
            if (!action.equals("reset")) {
                assertEquals("clean", current.get(0).path("qualityStatus").asText());
                assertEquals("ready", current.get(0).path("ingestStatus").asText());
                assertEquals(action.equals("repaired") ? "repaired" : "old", current.get(0).path("updatedAt").asText());
            }
            assertEquals(0, ContentMaintenance.active(List.of("title:title")));
        } finally { ContentMaintenance.release(root, operation); service.shutdownCatalogScanExecutor(); }
    }

    /** @param root isolated filesystem @param updatedAt checkpoint version @return ready saved chapter */
    private LibraryChapter chapter(Path root, String updatedAt) {
        return new LibraryChapter("chapter", "Chapter 1", "1", 1, "", true, root.resolve("source.cbz").toString(), "", "clean", 1, 0, List.of(), List.of(),
            "ready", "webp-" + "a".repeat(16), 1, "", "", root.resolve("manifest.json").toString(), updatedAt);
    }

    /** @param root isolated filesystem @param chapter retained chapter @return minimal single-title catalog */
    private LibraryTitle title(Path root, LibraryChapter chapter) {
        return new LibraryTitle("title", "Race Fixture", "manhua", "Manhua", "manhua", "active", "1", "#123456", "", "", 1, 1,
            "", List.of(), List.of(), "", null, List.of(), "", "https://example.invalid/cover.png", "", root.toString(), List.of(chapter), "");
    }
}
