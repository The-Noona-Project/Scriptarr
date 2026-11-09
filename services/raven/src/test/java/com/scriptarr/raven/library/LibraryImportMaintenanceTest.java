package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** An import remains an active writer while its copied files are being checkpointed into the catalog. */
class LibraryImportMaintenanceTest {
    /** Cleanup cannot observe quiescence during a delayed import catalog write after file copying. */
    @Test void writerLeaseCoversBothCatalogCheckpoints(@TempDir Path root) throws Exception {
        Path target = root.resolve("downloaded/manhua/Import_Race"), source = root.resolve("import-staging/source.cbz");
        Files.createDirectories(source.getParent());
        try (var zip = new ZipOutputStream(Files.newOutputStream(source))) {
            zip.putNextEntry(new ZipEntry("page.png")); zip.write(new byte[]{1, 2, 3}); zip.closeEntry();
        }
        String key = ContentMaintenance.pathKey(target), operation = "import-race-" + root.getFileName();
        CountDownLatch catalogEntered = new CountDownLatch(1), releaseCatalog = new CountDownLatch(1);
        AtomicReference<String> titleId = new AtomicReference<>();
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient() {
            /** Retain the writer while the title checkpoint is awaiting its broker acknowledgment. */
            @Override public JsonNode putLibraryTitle(String id, Map<String, Object> payload) {
                titleId.set(id); catalogEntered.countDown();
                try { if (!releaseCatalog.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Catalog checkpoint not released."); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException(error); }
                assertTrue(ContentMaintenance.active(List.of(key)) > 0, "Title persistence must hold the filesystem writer lease.");
                return super.putLibraryTitle(id, payload);
            }
            /** The chapter checkpoint is also covered, after the title checkpoint has returned. */
            @Override public JsonNode putLibraryChapters(String id, Map<String, Object> payload) {
                assertTrue(ContentMaintenance.active(List.of(key)) > 0, "Chapter persistence must hold the filesystem writer lease.");
                return super.putLibraryChapters(id, payload);
            }
        };
        ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
        LibraryService service = new LibraryService(broker, new RavenSettingsService(broker, logger, List.of()), logger);
        var executor = Executors.newSingleThreadExecutor();
        try {
            var imported = executor.submit(() -> service.importLibrary(Map.of("titleName", "Import Race", "libraryType", "Manhua", "chapters", List.of(Map.of("sourcePath", source.toString(), "chapterNumber", "1")))));
            assertTrue(catalogEntered.await(10, TimeUnit.SECONDS)); assertTrue(Files.isDirectory(target));
            ContentMaintenance.block(root, operation, List.of(key, "title:" + titleId.get()));
            assertTrue(ContentMaintenance.active(List.of(key)) > 0, "Cleanup must wait for the real delayed writer.");
            assertThrows(IllegalStateException.class, () -> ContentMaintenance.enter(key));
            releaseCatalog.countDown();
            var stopped = assertThrows(java.util.concurrent.ExecutionException.class, () -> imported.get(10, TimeUnit.SECONDS));
            assertInstanceOf(IllegalStateException.class, stopped.getCause());
            assertTrue(stopped.getCause().getMessage().contains("scoped maintenance"));
            assertEquals(0, ContentMaintenance.active(List.of(key)));
            assertEquals(1, broker.getLibraryTitle(titleId.get()).path("chapters").size());
        } finally { releaseCatalog.countDown(); executor.shutdownNow(); ContentMaintenance.release(root, operation); service.shutdownCatalogScanExecutor(); }
    }
}
