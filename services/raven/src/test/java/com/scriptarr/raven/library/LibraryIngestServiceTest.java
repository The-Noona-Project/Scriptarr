package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Unit tests for Raven's derived reader-page ingest service.
 */
class LibraryIngestServiceTest {
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    /**
     * Verify chapter ingest can convert multiple pages concurrently while
     * publishing a stable ordered AVIF manifest.
     *
     * @param tempDir temporary test directory
     * @throws Exception when fixture IO fails
     */
    @Test
    void ingestChapterTranscodesPagesInParallelAndKeepsManifestOrder(@TempDir Path tempDir) throws Exception {
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        CountingTranscoder transcoder = new CountingTranscoder(75);
        LibraryIngestService service = new LibraryIngestService(
            new RavenSettingsService(new FakeRavenBrokerClient(), logger, List.of()),
            logger,
            transcoder,
            3
        );
        Path archive = writeArchive(tempDir.resolve("chapter.cbz"), 6);
        LibraryTitle title = new LibraryTitle(
            "title-1",
            "Parallel Test",
            "manga",
            "Manga",
            "manga",
            "active",
            "",
            "",
            "",
            "",
            1,
            1,
            "",
            List.of(),
            List.of(),
            "",
            null,
            List.of(),
            "",
            "",
            "",
            "",
            List.of(new LibraryChapter("chapter-1", "Chapter 1", "1", 6, Instant.now().toString(), true, archive.toString(), "", null)),
            Instant.now().toString()
        );

        LibraryIngestResult result = service.ingestChapter(title, title.chapters().getFirst());

        assertEquals(6, result.pageCount());
        assertTrue(transcoder.maxActive.get() > 1);
        JsonNode manifest = OBJECT_MAPPER.readTree(Path.of(result.manifestPath()).toFile());
        assertEquals("p000001.avif", manifest.path("pages").get(0).path("slug").asText());
        assertEquals("p000006.avif", manifest.path("pages").get(5).path("slug").asText());
        assertEquals(6, Files.list(Path.of(result.manifestPath()).getParent()).filter((path) -> path.toString().endsWith(".avif")).count());
    }

    private static Path writeArchive(Path archivePath, int pages) throws IOException {
        Files.createDirectories(archivePath.getParent());
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archivePath))) {
            for (int index = 1; index <= pages; index += 1) {
                zip.putNextEntry(new ZipEntry(String.format("%03d.jpg", index)));
                zip.write(("page-" + index).getBytes(java.nio.charset.StandardCharsets.UTF_8));
                zip.closeEntry();
            }
        }
        return archivePath;
    }

    private static final class CountingTranscoder implements PageTranscoder {
        private final int delayMillis;
        private final AtomicInteger active = new AtomicInteger();
        private final AtomicInteger maxActive = new AtomicInteger();

        private CountingTranscoder(int delayMillis) {
            this.delayMillis = delayMillis;
        }

        @Override
        public String format() {
            return "avif";
        }

        @Override
        public String fileExtension() {
            return ".avif";
        }

        @Override
        public String mediaType() {
            return "image/avif";
        }

        @Override
        public String encoderName() {
            return "test/parallel-avif";
        }

        @Override
        public Readiness readiness() {
            return Readiness.ok();
        }

        @Override
        public void transcode(byte[] inputBytes, String sourceMediaType, Path outputPath, int quality)
            throws IOException, InterruptedException {
            writeOutput(outputPath);
        }

        @Override
        public void transcodeFile(Path inputPath, String sourceMediaType, Path outputPath, int quality)
            throws IOException, InterruptedException {
            int current = active.incrementAndGet();
            maxActive.accumulateAndGet(current, Math::max);
            try {
                TimeUnit.MILLISECONDS.sleep(delayMillis);
                writeOutput(outputPath);
            } finally {
                active.decrementAndGet();
            }
        }

        private void writeOutput(Path outputPath) throws IOException {
            Files.createDirectories(outputPath.getParent());
            Files.write(outputPath, "00000000ftypavif".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        }
    }
}
