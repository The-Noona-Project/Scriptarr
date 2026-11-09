package com.scriptarr.raven.library;

import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Verifies CPU readiness and reuse of valid pages after an encoder change.
 */
class LibraryIngestEncoderCompatibilityTest {
    /**
     * Verify existing NVIDIA-generated AVIF output remains reusable and
     * readable when Raven changes to CPU mode, but archive changes invalidate it.
     *
     * @param tempDir fixture data root
     * @throws Exception when fixture IO fails
     */
    @Test
    void encoderChangeKeepsReadyPagesButSourceChangesInvalidateThem(@TempDir Path tempDir) throws Exception {
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        RavenSettingsService settings = new RavenSettingsService(new FakeRavenBrokerClient(), logger, List.of());
        LibraryIngestService gpu = new LibraryIngestService(settings, logger, transcoder("ffmpeg/av1_nvenc", "nvidia-avif"), 1);
        LibraryIngestService cpu = new LibraryIngestService(settings, logger, transcoder("ffmpeg/libaom-av1", "cpu-avif"), 1);
        Path archive = tempDir.resolve("chapter.cbz");
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archive))) {
            zip.putNextEntry(new ZipEntry("001.jpg"));
            zip.write(new byte[] {1});
            zip.closeEntry();
        }
        LibraryTitle title = mock(LibraryTitle.class);
        when(title.id()).thenReturn("title-1");
        when(title.libraryTypeSlug()).thenReturn("manga");
        LibraryChapter chapter = mock(LibraryChapter.class);
        when(chapter.id()).thenReturn("chapter-1");
        when(chapter.archivePath()).thenReturn(archive.toString());
        when(chapter.available()).thenReturn(true);
        try {
            LibraryIngestResult result = gpu.ingestChapter(title, chapter);
            when(chapter.ingestStatus()).thenReturn("ready");
            when(chapter.ingestRevision()).thenReturn(result.revision());
            when(chapter.ingestedPageCount()).thenReturn(result.pageCount());
            when(chapter.ingestManifestPath()).thenReturn(result.manifestPath());
            assertTrue(cpu.canReuseReadyChapter(chapter));
            assertTrue(cpu.readIngestedPage(chapter, 0).length > 0);
            assertEquals("cpu-avif", cpu.hardwareStatus().get("profile"));
            assertEquals(false, cpu.hardwareStatus().get("required"));
            assertEquals("ready", cpu.hardwareStatus().get("state"));
            Files.write(archive, new byte[] {0}, StandardOpenOption.APPEND);
            assertFalse(cpu.canReuseReadyChapter(chapter));
        } finally {
            gpu.shutdown();
            cpu.shutdown();
        }
    }

    /**
     * Verify cancellation interrupts an active page encoder and never publishes
     * the incomplete chapter, while preserving its canonical CBZ archive.
     *
     * @param tempDir fixture data root
     * @throws Exception when fixture IO or worker coordination fails
     */
    @Test
    void cancellationStopsActiveEncoderAndLeavesNoPublishedChapter(@TempDir Path tempDir) throws Exception {
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        PageTranscoder transcoder = transcoder("ffmpeg/libaom-av1", "cpu-avif");
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch stopped = new CountDownLatch(1);
        doAnswer(invocation -> {
            started.countDown();
            try {
                TimeUnit.SECONDS.sleep(30);
            } finally {
                stopped.countDown();
            }
            return null;
        }).when(transcoder).transcodeFile(any(Path.class), anyString(), any(Path.class), anyInt());
        LibraryIngestService service = new LibraryIngestService(
            new RavenSettingsService(new FakeRavenBrokerClient(), logger, List.of()), logger, transcoder, 1
        );
        Path archive = tempDir.resolve("chapter.cbz");
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archive))) {
            zip.putNextEntry(new ZipEntry("001.jpg"));
            zip.write(new byte[] {1});
            zip.closeEntry();
        }
        LibraryTitle title = mock(LibraryTitle.class);
        when(title.id()).thenReturn("title-1");
        when(title.libraryTypeSlug()).thenReturn("manga");
        LibraryChapter chapter = mock(LibraryChapter.class);
        when(chapter.id()).thenReturn("chapter-1");
        when(chapter.archivePath()).thenReturn(archive.toString());
        AtomicBoolean cancelled = new AtomicBoolean();
        var worker = Executors.newSingleThreadExecutor();
        try {
            var result = worker.submit(() -> service.ingestChapter(title, chapter, cancelled::get));
            assertTrue(started.await(5, TimeUnit.SECONDS));
            cancelled.set(true);
            ExecutionException failure = assertThrows(ExecutionException.class, () -> result.get(3, TimeUnit.SECONDS));
            assertTrue(failure.getCause() instanceof LibraryIngestException);
            assertEquals("ingest_cancelled", ((LibraryIngestException) failure.getCause()).failureCode());
            assertTrue(stopped.await(3, TimeUnit.SECONDS));
            assertFalse(Files.exists(tempDir.resolve("ingested/manga/title-1/chapter-1")));
            assertTrue(Files.exists(archive));
        } finally {
            service.shutdown();
            worker.shutdownNow();
        }
    }

    private static PageTranscoder transcoder(String encoder, String profile) throws Exception {
        PageTranscoder transcoder = mock(PageTranscoder.class);
        when(transcoder.format()).thenReturn("avif");
        when(transcoder.mediaType()).thenReturn("image/avif");
        when(transcoder.fileExtension()).thenReturn(".avif");
        when(transcoder.encoderName()).thenReturn(encoder);
        when(transcoder.runtimeProfile()).thenReturn(profile);
        when(transcoder.requiresNvidiaRuntime()).thenReturn("nvidia-avif".equals(profile));
        when(transcoder.readiness()).thenReturn(PageTranscoder.Readiness.ok());
        doAnswer(invocation -> {
            Files.write(invocation.getArgument(2, Path.class), "00000000ftypavif0000".getBytes(StandardCharsets.US_ASCII));
            return null;
        }).when(transcoder).transcodeFile(any(Path.class), anyString(), any(Path.class), anyInt());
        return transcoder;
    }
}
