package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.metadata.MetadataService;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.Map;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Exercise real durable preparation and cancellation publication under injected broker races. */
class BoundedDownloadStateTest {
    /** A request rejected after its primary write cannot be dispatched by a subsequent startup. */
    @Test void rejectedPartialIntakeCannotRunAfterRestart(@TempDir Path root) throws Exception {
        AtomicBoolean unavailable = new AtomicBoolean(true);
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient() {
            @Override public JsonNode putJob(String id, Map<String, Object> value) {
                if (unavailable.get()) throw new IllegalStateException("Job write failed after task write.");
                return super.putJob(id, value);
            }
        };
        DownloadProvider provider = mock(DownloadProvider.class);
        DownloaderService first = service(broker, provider, root);
        try {
            assertThrows(IllegalStateException.class, () -> first.queueDownload(new DownloadRequest("Bounded", "https://example.invalid/series/bounded",
                "Manga", "owner", "weebcentral", "", Map.of(), Map.of("chapterNumbers", List.of("1")), "", "normal")));
            assertTrue(broker.listDownloadTasks().get(0).path("details").path("intakePending").asBoolean());
        } finally { first.shutdown(); }
        unavailable.set(false);
        DownloaderService restored = service(broker, provider, root);
        try {
            restored.restorePersistedTasks();
            assertEquals("failed", restored.snapshot().getFirst().get("status"));
            assertTrue(restored.bulkRunGateway().restoreCompletion().isDone());
            verify(provider, never()).getChapters(anyString());
        } finally { restored.shutdown(); }
    }

    /** Completion may win before cancellation is accepted; a cancellation that wins cannot later be overwritten. */
    @Test void completionAndAcceptedCancellationPublishConsistently(@TempDir Path root) throws Exception {
        CountDownLatch writing = new CountDownLatch(1), release = new CountDownLatch(1);
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient() {
            @Override public JsonNode putDownloadTask(String id, Map<String, Object> value) {
                if ("complete-first".equals(id) && "completed".equals(value.get("status"))) {
                    writing.countDown();
                    try { if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test checkpoint timeout."); }
                    catch (InterruptedException error) { throw new IllegalStateException(error); }
                }
                return super.putDownloadTask(id, value);
            }
        };
        DownloaderService service = service(broker, mock(DownloadProvider.class), root);
        try {
            var field = DownloaderService.class.getDeclaredField("tasks"); field.setAccessible(true);
            Map<String, Map<String, Object>> tasks = (Map<String, Map<String, Object>>) field.get(service);
            var update = DownloaderService.class.getDeclaredMethod("update", String.class, String.class, String.class, int.class); update.setAccessible(true);
            tasks.put("complete-first", task("complete-first"));
            CompletableFuture<Void> completing = CompletableFuture.runAsync(() -> {
                try { update.invoke(service, "complete-first", "completed", "Verified.", 100); }
                catch (Exception error) { throw new IllegalStateException(error); }
            });
            assertTrue(writing.await(5, TimeUnit.SECONDS));
            CountDownLatch cancelling = new CountDownLatch(1);
            var cancelled = CompletableFuture.supplyAsync(() -> { cancelling.countDown(); return service.cancelTask("complete-first"); });
            assertTrue(cancelling.await(5, TimeUnit.SECONDS));
            assertThrows(TimeoutException.class, () -> cancelled.get(100, TimeUnit.MILLISECONDS));
            release.countDown(); completing.get(5, TimeUnit.SECONDS);
            assertInstanceOf(IllegalStateException.class, assertThrows(ExecutionException.class, () -> cancelled.get(5, TimeUnit.SECONDS)).getCause());
            tasks.put("cancel-first", task("cancel-first"));
            assertEquals("failed", service.cancelTask("cancel-first").get("status"));
            update.invoke(service, "cancel-first", "completed", "Too late.", 100);
            assertEquals("failed", tasks.get("cancel-first").get("status"));
            for (JsonNode row : broker.listDownloadTasks()) assertEquals(row.path("taskId").asText().equals("complete-first") ? "completed" : "failed", row.path("status").asText());
        } finally { release.countDown(); service.shutdown(); }
    }

    private Map<String, Object> task(String id) {
        return new HashMap<>(Map.of("taskId", id, "jobId", id, "status", "running", "titleName", "Bounded", "selectedDownload", Map.of("chapterNumbers", List.of("1"))));
    }

    private DownloaderService service(FakeRavenBrokerClient broker, DownloadProvider provider, Path root) {
        ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
        when(provider.id()).thenReturn("weebcentral"); when(provider.name()).thenReturn("WeebCentral");
        RavenSettingsService settings = new RavenSettingsService(broker, logger, List.of());
        return new DownloaderService(new DownloadProviderRegistry(List.of(provider), settings), null, mock(LibraryService.class),
            mock(DownloadIntakeService.class), mock(MetadataService.class), broker, settings, logger);
    }
}
