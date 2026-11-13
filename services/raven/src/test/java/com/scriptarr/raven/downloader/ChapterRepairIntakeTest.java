package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.metadata.MetadataService;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Executors;
import java.util.concurrent.Callable;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Durable repair creation survives lost responses, partial checkpoint creation and concurrent retries. */
class ChapterRepairIntakeTest {
    /** Concurrent replays create exactly one durable task; changed title or selection conflicts. */
    @Test void concurrentIntakeAndLostResponseReuseOneTask(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            assertThrows(IllegalStateException.class, () -> f.service.queueChapterRepair("title", f.body));
            f.service.restorePersistedTasks();
            try (var executor = Executors.newFixedThreadPool(4)) {
                List<Callable<Map<String, Object>>> requests = java.util.stream.IntStream.range(0, 12)
                    .mapToObj(i -> (Callable<Map<String, Object>>) () -> f.service.queueChapterRepair("title", f.body)).toList();
                var receipts = executor.invokeAll(requests);
                String id = String.valueOf(receipts.getFirst().get().get("taskId"));
                for (var receipt : receipts) assertEquals(id, receipt.get().get("taskId"));
                assertEquals(id, f.service.queueChapterRepair("title", f.body).get("taskId"));
            }
            assertEquals(1, f.broker.listDownloadTasks().size());
            assertThrows(IllegalStateException.class, () -> f.service.queueChapterRepair("other-title", f.body));
            assertThrows(IllegalStateException.class, () -> f.service.queueChapterRepair("title", Map.of("chapterIds", List.of("other"), "requestId", "repair:1", "requestedBy", "owner")));
        }
    }
    /** Interrupted generic-job creation repairs the existing accepted download record without resetting its scope. */
    @Test void interruptedCreationRepairsMissingRecords(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            f.service.restorePersistedTasks(); f.broker.failJob = true;
            assertThrows(IllegalStateException.class, () -> f.service.queueChapterRepair("title", f.body));
            assertEquals(1, f.broker.listDownloadTasks().size());
            String id = f.broker.listDownloadTasks().get(0).path("taskId").asText();
            f.broker.failJob = false;
            Map<String, Object> repaired = f.service.queueChapterRepair("title", f.body);
            assertEquals(id, repaired.get("taskId")); assertEquals(true, repaired.get("replayed"));
            assertEquals(1, f.broker.listDownloadTasks().size()); assertTrue(java.util.stream.StreamSupport.stream(f.broker.listJobs("", "", "").spliterator(), false).anyMatch(job -> id.equals(job.path("jobId").asText())));
            assertEquals(1, f.broker.listJobTasks(id, "").size());
        }
    }
    /** A broker that can fail exactly after the accepted task record is saved. */
    private static final class Broker extends FakeRavenBrokerClient {
        private boolean failJob;
        @Override public JsonNode putJob(String id, Map<String, Object> payload) {
            if (failJob) throw new IllegalStateException("interrupted creation"); return super.putJob(id, payload);
        }
    }
    /** Only provider network discovery is stubbed; real restore, persistence and dispatch paths execute. */
    private static final class Fixture implements AutoCloseable {
        private final Broker broker = new Broker();
        private final DownloaderService service;
        private final Map<String, Object> body = Map.of("chapterIds", List.of("chapter"), "requestId", "repair:1", "requestedBy", "owner");
        /** @param root isolated downloads root */
        private Fixture(Path root) {
            ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
            RavenSettingsService settings = new RavenSettingsService(broker, logger, List.of());
            LibraryService library = mock(LibraryService.class); LibraryTitle title = mock(LibraryTitle.class);
            when(title.id()).thenReturn("title"); when(title.title()).thenReturn("Title"); when(title.sourceUrl()).thenReturn("https://weebcentral.com/series/ABC/Title");
            when(title.libraryTypeLabel()).thenReturn("Manhua"); when(title.chapters()).thenReturn(List.of(new LibraryChapter("chapter", "Chapter 197", "197", 0, "", false, "", "https://weebcentral.com/chapters/ABC", null)));
            when(library.findTitle("title")).thenReturn(title);
            DownloadProviderRegistry providers = mock(DownloadProviderRegistry.class); DownloadProvider provider = mock(DownloadProvider.class);
            when(provider.id()).thenReturn("weebcentral"); when(providers.resolve(any(), any())).thenReturn(Optional.of(provider));
            when(provider.discoverChapters(any())).thenReturn(new ChapterDiscoveryResult(List.of(), true, ""));
            service = new DownloaderService(providers, null, library, mock(DownloadIntakeService.class), mock(MetadataService.class), broker, settings, logger);
        }
        /** Stop isolated workers. */
        @Override public void close() {service.shutdown();}
    }
}
