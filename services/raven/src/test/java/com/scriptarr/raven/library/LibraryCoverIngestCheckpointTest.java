package com.scriptarr.raven.library;

import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Exercise concurrent cover repair during actual ingest checkpoints. */
class LibraryCoverIngestCheckpointTest {
    private static final String COVER = "https://images.example/retained-cover.jpg";

    /** The saved-request artwork writer must survive the older ingest snapshot's final checkpoint. */
    @Test
    void retainCoverSurvivesConcurrentIngest(@TempDir Path root) throws Exception {
        reproduce(root, false);
    }

    /** A metadata artwork repair must survive the older ingest snapshot's final checkpoint. */
    @Test
    void metadataCoverSurvivesConcurrentIngest(@TempDir Path root) throws Exception {
        reproduce(root, true);
    }

    /** Pause a real ingest after its title load, repair cover art from another thread, then allow completion. */
    private void reproduce(Path root, boolean metadata) throws Exception {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(root);
        LibraryService service = new LibraryService(broker, new RavenSettingsService(broker, logger, List.of()), logger);
        Path archive = root.resolve("downloaded/manhua/Race/Race c001.cbz");
        Files.createDirectories(archive.getParent());
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(2, 2, BufferedImage.TYPE_INT_RGB), "png", png);
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archive))) {
            zip.putNextEntry(new ZipEntry("page.png")); zip.write(png.toByteArray()); zip.closeEntry();
        }
        String archiveHash = hash(Files.readAllBytes(archive));
        var archiveModified = Files.getLastModifiedTime(archive);
        LibraryTitle title = service.recordDownloadedTitle("Race", "Manhua", "", "", null,
            List.of(new LibraryChapter("", "Chapter 1", "1", 1, "", true, archive.toString(), "", null)), null, archive.getParent());
        CountDownLatch loaded = new CountDownLatch(1), release = new CountDownLatch(1);
        AtomicBoolean reached = new AtomicBoolean();
        var worker = Executors.newSingleThreadExecutor();
        try {
            var ingest = worker.submit(() -> service.ingestTitle(title.id(), "isolated-qa", () -> false, progress -> {
                if (progress.advanced() && reached.compareAndSet(false, true)) {
                    loaded.countDown();
                    try {if (!release.await(15, TimeUnit.SECONDS)) throw new IllegalStateException("Race checkpoint was not released.");}
                    catch (InterruptedException error) {Thread.currentThread().interrupt(); throw new IllegalStateException(error);}
                }
            }));
            assertTrue(loaded.await(15, TimeUnit.SECONDS), "Actual page ingest must reach its progress callback.");
            if (metadata) service.applyMetadata(title.id(), "qa-metadata", "2026-11-08T08:00:00Z", Map.of("coverUrl", COVER));
            else service.retainCoverUrl(title.id(), COVER);
            assertEquals(COVER, service.findTitleById(title.id()).coverUrl(), "The concurrent writer must durably save artwork before release.");
            release.countDown();
            LibraryTitle finished = ingest.get(20, TimeUnit.SECONDS);
            LibraryTitle durable = service.findTitleById(title.id());
            assertEquals("ready", finished.ingestStatus());
            assertTrue(Files.isRegularFile(Path.of(finished.chapters().getFirst().ingestManifestPath())));
            assertEquals(archiveHash, hash(Files.readAllBytes(archive)));
            assertEquals(archiveModified, Files.getLastModifiedTime(archive));
            assertEquals(COVER, durable.coverUrl(), "A stale blank-cover ingest checkpoint must not erase concurrent artwork.");
        } finally {release.countDown();worker.shutdownNow();service.shutdownCatalogScanExecutor();}
    }

    /** Hash the unchanged synthetic canonical archive for the reproduction evidence. */
    private String hash(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
