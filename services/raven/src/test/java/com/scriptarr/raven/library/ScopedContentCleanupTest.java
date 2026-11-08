package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.downloader.DownloaderService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Exact filesystem/broker flow with real journals, quiescence and restart-safe idempotent cleanup. */
class ScopedContentCleanupTest {
    /** Duplicate selected plans deduplicate canonical content; crash replay removes only remaining reviewed files. */
    @Test void partialDeletionResumesOriginalInventoryAndPreservesLaterContent(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            Map<String, Object> preview = f.service().preview(Map.of("runId", "run", "planIds", List.of("plan-a", "plan-b"), "operationId", "cleanup-test"));
            assertEquals(2, preview.get("planCount")); assertEquals(List.of("title"), preview.get("titleIds")); assertFalse(preview.containsKey("inventory"));
            Map<String, Object> apply = Map.of("operationId", "cleanup-test", "scopeDigest", preview.get("scopeDigest"), "filesystemScopeDigest", preview.get("filesystemScopeDigest"));
            f.active.set(1); assertThrows(Exception.class, () -> f.service().apply(apply)); assertTrue(Files.exists(f.file));
            Files.delete(f.file); f.active.set(0);
            Map<String, Object> replayPreview = f.service().preview(Map.of("operationId", "cleanup-test")); assertEquals(preview.get("filesystemScopeDigest"), replayPreview.get("filesystemScopeDigest"));
            assertEquals(true, f.service().apply(apply).get("historyPreserved")); assertFalse(Files.exists(f.selected)); assertTrue(Files.exists(f.unrelated));
            Files.createDirectories(f.selected); Files.writeString(f.file, "new-after-finish"); f.service().apply(apply);
            assertEquals("new-after-finish", Files.readString(f.file)); assertEquals(1, f.applies.get());
        }
    }

    /** Queued unrelated tasks with blank saved roots still protect their derived logical folder. */
    @Test void unrelatedQueuedLogicalOwnershipBlocksPreview(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            f.catalog.putDownloadTask("foreign", Map.of("taskId", "foreign", "status", "queued", "titleName", "Fixture", "requestType", "Manhua", "details", Map.of()));
            assertThrows(Exception.class, () -> f.service().preview(Map.of("operationId", "cleanup-test"))); assertTrue(Files.exists(f.file)); assertEquals(0, f.applies.get());
        }
    }

    /** A new unreviewed file after preview is never silently included in destructive apply. */
    @Test void changedScopeIsRejectedUnderRetainedFence(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            Map<String, Object> preview = f.service().preview(Map.of("operationId", "cleanup-test")); Files.writeString(f.selected.resolve("unexpected.cbz"), "new");
            assertThrows(Exception.class, () -> f.service().apply(Map.of("operationId", "cleanup-test", "scopeDigest", preview.get("scopeDigest"), "filesystemScopeDigest", preview.get("filesystemScopeDigest"))));
            assertTrue(Files.exists(f.file)); assertEquals(0, f.applies.get());
        }
    }

    /** Isolated broker, catalog, filesystem and actual-activity boundary. */
    private static final class Fixture implements AutoCloseable {
        private final Path root, selected, file, unrelated;
        private final FakeRavenBrokerClient catalog = new FakeRavenBrokerClient();
        private final DownloaderService downloader = mock(DownloaderService.class);
        private final LibraryIngestService ingest = mock(LibraryIngestService.class);
        private final AtomicInteger active = new AtomicInteger(), applies = new AtomicInteger();
        private final HttpServer server;
        private final IngestBrokerClient broker;
        /** @param root isolated managed directory @throws Exception when fixture creation fails */
        private Fixture(Path root) throws Exception {
            this.root = root; selected = root.resolve("downloaded/manhua/Fixture"); Files.createDirectories(selected); file = selected.resolve("chapter.cbz"); Files.writeString(file, "old");
            unrelated = root.resolve("downloaded/manhua/Other/chapter.cbz"); Files.createDirectories(unrelated.getParent()); Files.writeString(unrelated, "keep");
            Map<String, Object> title = Map.of("id", "title", "libraryTypeSlug", "manhua", "downloadRoot", selected.toString(), "chapters", List.of(Map.of("archivePath", file.toString())));
            catalog.putLibraryTitle("title", title);
            Map<String, Object> scope = Map.of("operationId", "cleanup-test", "scopeDigest", "a".repeat(64), "runId", "run", "planIds", List.of("plan-a", "plan-b"), "titleIds", List.of("title"), "titles", List.of(title),
                "plans", List.of(Map.of("planId", "plan-a", "downloadTaskId", "task-a", "titleName", "Fixture", "requestType", "Manhua"), Map.of("planId", "plan-b", "downloadTaskId", "task-b", "titleName", "Fixture", "requestType", "Manhua")), "tasks", List.of());
            ObjectMapper json = new ObjectMapper(); server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/api/internal/raven-ingest/content-reset", exchange -> {
                if (exchange.getRequestURI().getPath().endsWith("/apply")) applies.incrementAndGet();
                byte[] bytes = json.writeValueAsBytes(scope); exchange.sendResponseHeaders(200, bytes.length); exchange.getResponseBody().write(bytes); exchange.close();
            }); server.start(); broker = new IngestBrokerClient(Map.of("SCRIPTARR_SAGE_BASE_URL", "http://127.0.0.1:" + server.getAddress().getPort()));
            when(downloader.scopedExecutionActivity(anySet())).thenAnswer(call -> Map.of("runningThreads", active.get(), "queuedExecutors", 0));
        }
        /** @return a fresh coordinator instance restoring the real saved maintenance fence */
        private ScopedContentCleanup service() { return new ScopedContentCleanup(root, downloader, ingest, catalog, broker); }
        /** Stop only the loopback broker and release the test's process-local fence. */
        @Override public void close() throws Exception { server.stop(0); ContentMaintenance.release(root, "cleanup-test"); }
    }
}
