package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/** Ordinary catalog writes retain durable reader evidence so strict ingest can repair missing older output. */
class LibraryChapterCatalogCheckpointTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Appending a healthy CBZ remains possible after a tile from an older durable ready chapter disappears. */
    @Test void appendRetainsMissingOlderDerivedCheckpoint(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root);
        Path lostTile = manifest(fixture.ready);
        assertTrue(DerivedPageManifest.reusable(fixture.ready)); Files.delete(lostTile);
        assertFalse(DerivedPageManifest.reusable(fixture.ready));
        Path added = archive(Path.of(fixture.title.downloadRoot()).resolve("new-two.cbz"));
        byte[] original = Files.readAllBytes(Path.of(fixture.ready.archivePath()));
        var modified = Files.getLastModifiedTime(Path.of(fixture.ready.archivePath()));
        try {
            fixture.library.recordDownloadedChapter(fixture.title.title(), "Manhua", fixture.title.sourceUrl(), fixture.title.coverUrl(), null,
                new LibraryChapter("new", "Chapter 2", "2", 1, null, true, added.toString(), "https://example.invalid/chapter-2", null), added);
            LibraryTitle saved = fixture.library.findTitleById(fixture.title.id());
            assertEquals(2, saved.chapters().size());
            LibraryChapter retained = saved.chapters().stream().filter(chapter -> chapter.id().equals(fixture.ready.id())).findFirst().orElseThrow();
            assertEquals("ready", retained.ingestStatus()); assertEquals(Boolean.TRUE, retained.segmentsReady());
            assertEquals(fixture.ready.ingestManifestPath(), retained.ingestManifestPath()); assertEquals(Integer.valueOf(1), retained.expectedSegmentCount());
            assertArrayEquals(original, Files.readAllBytes(Path.of(fixture.ready.archivePath())));
            assertEquals(modified, Files.getLastModifiedTime(Path.of(fixture.ready.archivePath())));
            assertEquals(1, ArchiveImageEntries.verifiedCount(added)); verifyNoInteractions(fixture.ingest);
        } finally { fixture.library.shutdownCatalogScanExecutor(); }
    }

    /** A manual import checkpoints its added CBZ and reaches strict repair even when the older manifest is missing. */
    @Test void manualImportReachesOlderChapterRepair(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root); Path source = archive(root.resolve("import-staging/new-zero.cbz"));
        AtomicBoolean enteredRepair = new AtomicBoolean();
        when(fixture.ingest.ingestChapter(any(), any(), any(), any())).thenAnswer(invocation -> {
            LibraryChapter chapter = invocation.getArgument(1); assertEquals(fixture.ready.id(), chapter.id());
            JsonNode rows = fixture.broker.getLibraryTitle(fixture.title.id()).path("chapters");
            assertEquals(2, rows.size()); assertTrue(rows.findValuesAsText("chapterNumber").contains("0"));
            assertEquals(1, ArchiveImageEntries.verifiedCount(Path.of(chapter.archivePath())));
            enteredRepair.set(true); throw new LibraryIngestException("fixture_repair_boundary", "Reached canonical repair after catalog persistence.");
        });
        try {
            LibraryIngestException error = assertThrows(LibraryIngestException.class, () -> fixture.library.importLibrary(Map.of(
                "existingTitleId", fixture.title.id(), "libraryType", "Manhua", "chapters", List.of(Map.of("sourcePath", source.toString(), "chapterNumber", "0")))));
            assertEquals("fixture_repair_boundary", error.failureCode()); assertTrue(enteredRepair.get());
            LibraryTitle saved = fixture.library.findTitleById(fixture.title.id()); assertEquals(2, saved.chapters().size());
            LibraryChapter failed = saved.chapters().stream().filter(chapter -> chapter.id().equals(fixture.ready.id())).findFirst().orElseThrow();
            assertEquals("failed", failed.ingestStatus()); assertEquals(Boolean.FALSE, failed.segmentsReady());
            assertEquals(Integer.valueOf(1), failed.sourcePageCount()); assertEquals(Integer.valueOf(1), failed.ingestedSegmentCount());
        } finally { fixture.library.shutdownCatalogScanExecutor(); }
    }

    /** One durable read retains omitted checkpoint fields for all matching metadata-only rows without touching files. */
    @Test void metadataListReadsDurableChaptersOnce(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root); fixture.broker.exactReads = 0;
        ObjectNode secondRow = JSON.valueToTree(fixture.ready); secondRow.put("id", "second"); secondRow.put("chapterNumber", "2");
        secondRow.put("ingestManifestPath", root.resolve("ingested/second/manifest.json").toString());
        LibraryChapter second = JSON.treeToValue(secondRow, LibraryChapter.class);
        fixture.broker.setLibraryTitle(title(fixture.title.downloadRoot(), List.of(fixture.ready, second)));
        LibraryChapter copy = new LibraryChapter(fixture.ready.id(), "Metadata edit", "1", 1, null, true,
            fixture.ready.archivePath(), fixture.ready.sourceUrl(), "partial", 1, 1, List.of(1), List.of("Keep evidence"), "ready",
            fixture.ready.ingestRevision(), 1, fixture.ready.ingestedAt(), "", fixture.ready.ingestManifestPath(), fixture.ready.updatedAt());
        try {
            List<LibraryChapter> result = fixture.library.replaceChapters(fixture.title.id(), List.of(copy, second));
            assertEquals(1, fixture.broker.exactReads); assertEquals(Boolean.TRUE, result.getFirst().segmentsReady());
            assertEquals(Integer.valueOf(1), result.getFirst().expectedSegmentCount()); assertEquals("Metadata edit", result.getFirst().label());
            assertEquals(List.of("Keep evidence"), result.getFirst().qualityNotes()); assertFalse(Files.exists(Path.of(fixture.ready.ingestManifestPath())));
            assertEquals(second, result.get(1));
        } finally { fixture.library.shutdownCatalogScanExecutor(); }
    }

    /** Changed identities, output paths, logical totals or supplied segment evidence cannot borrow prior readiness. */
    @Test void forgedNewReadyOutputStillRequiresStrictManifestValidation(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root);
        try {
            for (Map<String, Object> change : List.of(Map.<String, Object>of("id", "forged"), Map.<String, Object>of("archivePath", "/different.cbz"),
                Map.<String, Object>of("ingestRevision", "webp-fedcba9876543210"), Map.<String, Object>of("ingestManifestPath", root.resolve("new/manifest.json").toString()),
                Map.<String, Object>of("pageCount", 2), Map.<String, Object>of("ingestedPageCount", 2), Map.<String, Object>of("sourcePageCount", 2),
                Map.<String, Object>of("expectedSegmentCount", 2, "ingestedSegmentCount", 2), Map.<String, Object>of("segmentsReady", false))) {
                ObjectNode row = JSON.valueToTree(fixture.ready); change.forEach((key, value) -> row.set(key, JSON.valueToTree(value)));
                LibraryChapter forged = JSON.treeToValue(row, LibraryChapter.class);
                assertThrows(IllegalStateException.class, () -> fixture.library.replaceChapters(fixture.title.id(), List.of(forged)));
            }
            assertEquals(0, fixture.broker.replaceChapterListWrites());
            ObjectNode incomplete = JSON.valueToTree(fixture.ready); incomplete.put("segmentsReady", false);
            fixture.broker.setLibraryTitle(title(fixture.title.downloadRoot(), JSON.treeToValue(incomplete, LibraryChapter.class)));
            assertThrows(IllegalStateException.class, () -> fixture.library.replaceChapters(fixture.title.id(), List.of(fixture.ready)));
            assertEquals(0, fixture.broker.replaceChapterListWrites());
        } finally { fixture.library.shutdownCatalogScanExecutor(); }
    }

    /** A failure uses the single-row checkpoint path, clears readiness and retains an untouched sibling verbatim. */
    @Test void nonReadyCheckpointDoesNotReadOrReplaceSiblings(@TempDir Path root) throws Exception {
        Fixture fixture = fixture(root); ObjectNode row = JSON.valueToTree(fixture.ready); row.put("ingestStatus", "failed");
        LibraryChapter failed = JSON.treeToValue(row, LibraryChapter.class);
        assertEquals(Map.of("segmentsReady", false), LibraryChapterCatalogCheckpoint.fields(failed, fixture.ready));
        LibraryChapter sibling = new LibraryChapter("sibling", "Chapter 0", "0", 1, null, true, archive(root.resolve("downloaded/manhua/Checkpoint_Series/sibling.cbz")).toString(), "", null);
        fixture.broker.setLibraryTitle(title(fixture.title.downloadRoot(), List.of(fixture.ready, sibling)));
        when(fixture.ingest.ingestChapter(any(), any(), any(), any())).thenThrow(new LibraryIngestException("fixture_failure", "Controlled repair failure."));
        fixture.broker.exactReads = 0;
        try {
            assertThrows(LibraryIngestException.class, () -> fixture.library.ingestTitle(fixture.title.id(), "fixture"));
            assertEquals(2, fixture.broker.exactReads, "Canonical resolution and the locked title load are normal; a failed checkpoint must not fetch an extra snapshot.");
            assertEquals(0, fixture.broker.replaceChapterListWrites()); assertEquals(1, fixture.broker.singleChapterWrites());
            JsonNode rows = fixture.broker.getLibraryTitle(fixture.title.id()).path("chapters");
            assertFalse(storedChapter(rows, "chapter").path("segmentsReady").asBoolean());
            assertEquals(JSON.valueToTree(sibling), storedChapter(rows, "sibling"));
            assertEquals(Integer.valueOf(1), failed.ingestedSegmentCount());
        } finally { fixture.library.shutdownCatalogScanExecutor(); }
    }

    /** A genuinely new ready checkpoint still verifies every manifest segment rather than requiring prior catalog state. */
    @Test void newReadyOutputUsesStrictManifestValidation(@TempDir Path root) throws Exception {
        LibraryChapter ready = DerivedPageManifestTest.chapter(root);
        assertEquals(Map.of("sourcePageCount", 1, "expectedSegmentCount", 2, "ingestedSegmentCount", 2, "segmentsReady", true),
            LibraryChapterCatalogCheckpoint.fields(ready, null));
        Files.delete(Path.of(ready.ingestManifestPath()).getParent().resolve("p000001-s0001.webp"));
        assertThrows(java.io.IOException.class, () -> LibraryChapterCatalogCheckpoint.fields(ready, null));
    }

    /** @param root isolated file root @return real library and durable seeded checkpoint with missing output @throws Exception when fixture creation fails */
    private static Fixture fixture(Path root) throws Exception {
        CountingBroker broker = new CountingBroker(); ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
        LibraryIngestService ingest = mock(LibraryIngestService.class);
        LibraryService library = new LibraryService(broker, new RavenSettingsService(broker, logger, List.of()), logger, ingest);
        Path canonical = archive(root.resolve("downloaded/manhua/Checkpoint_Series/old-one.cbz"));
        String revision = DerivedPageManifest.revision(canonical, 1, "webp", "ffmpeg/libwebp", 85);
        LibraryChapter ready = new LibraryChapter("chapter", "Chapter 1", "1", 1, null, true, canonical.toString(), "https://example.invalid/chapter-1",
            "clean", 1, 0, List.of(), List.of(), "ready", revision, 1, "2026-11-08T00:00:00Z", "",
            root.resolve("ingested/manhua/title/chapter/" + revision + "/manifest.json").toString(), "2026-11-08T00:00:00Z", 1, 1, 1, true);
        LibraryTitle title = title(canonical.getParent().toString(), ready); broker.setLibraryTitle(title);
        return new Fixture(broker, library, ingest, title, ready);
    }

    /** @param root canonical chapter folder @param chapter saved checkpoint @return stable existing title */
    private static LibraryTitle title(String root, LibraryChapter chapter) {
        return title(root, List.of(chapter));
    }

    /** @param root canonical chapter folder @param chapters exact durable rows @return title with accurate fixture summaries */
    private static LibraryTitle title(String root, List<LibraryChapter> chapters) {
        return new LibraryTitle("title", "Checkpoint Series", "manhua", "Manhua", "manhua", "ongoing", "1", "#123456", "", "", chapters.size(), chapters.size(),
            "", List.of(), List.of(), "", null, List.of(), "https://example.invalid/series/checkpoint", "https://example.invalid/cover.jpg", "", root,
            chapters, "2026-11-08T00:00:00Z");
    }

    /** @param file scoped CBZ destination @return healthy canonical archive @throws Exception when fixture image or ZIP cannot be written */
    private static Path archive(Path file) throws Exception {
        Files.createDirectories(file.getParent()); ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        assertTrue(ImageIO.write(new BufferedImage(8, 8, BufferedImage.TYPE_INT_RGB), "png", bytes));
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(file))) {
            zip.putNextEntry(new ZipEntry("page.png")); zip.write(bytes.toByteArray()); zip.closeEntry();
        }
        assertEquals(1, ArchiveImageEntries.verifiedCount(file)); return file;
    }

    /** @param chapter durable ready checkpoint @return tile that can be removed after complete saved-manifest verification @throws Exception when fixture writes fail */
    private static Path manifest(LibraryChapter chapter) throws Exception {
        Path file = Path.of(chapter.ingestManifestPath()), root = file.getParent(); Files.createDirectories(root);
        Path tile = Files.write(root.resolve("p000001-s0000.webp"), new byte[]{1, 2, 3});
        Path thumbnail = Files.write(root.resolve("p000001-thumbnail.webp"), new byte[]{3, 2, 1});
        Map<String, Object> segment = Map.of("index", 0, "x", 0, "y", 0, "width", 8, "height", 8, "slug", tile.getFileName().toString(), "size", Files.size(tile), "sha256", WebpChapterEncoder.sha256(tile));
        Map<String, Object> thumb = Map.of("width", 8, "height", 8, "slug", thumbnail.getFileName().toString(), "size", Files.size(thumbnail), "sha256", WebpChapterEncoder.sha256(thumbnail));
        JSON.writeValue(file.toFile(), Map.of("format", "webp", "mediaType", "image/webp", "chapterId", chapter.id(), "revision", chapter.ingestRevision(),
            "quality", 85, "method", 4, "segmentationVersion", 1, "encoder", "ffmpeg/libwebp", "pageCount", 1,
            "pages", List.of(Map.of("index", 0, "width", 8, "height", 8, "segments", List.of(segment), "thumbnail", thumb))));
        return tile;
    }

    /** @param rows durable catalog chapters @param id exact chapter identity @return one stored row */
    private static JsonNode storedChapter(JsonNode rows, String id) {
        for (JsonNode chapter : rows) if (id.equals(chapter.path("id").asText())) return chapter;
        throw new AssertionError("Missing stored chapter " + id);
    }

    /** Count only exact durable reads so list serialization cannot hydrate each retained chapter separately. */
    private static final class CountingBroker extends FakeRavenBrokerClient {
        private int exactReads;
        /** @param id stable title identity @return current durable title including chapters */
        @Override public JsonNode getLibraryTitle(String id) { exactReads++; return super.getLibraryTitle(id); }
    }

    /** Actual catalog and filesystem fixture; only the later encoding boundary is controlled. */
    private record Fixture(CountingBroker broker, LibraryService library, LibraryIngestService ingest, LibraryTitle title, LibraryChapter ready) { }
}
