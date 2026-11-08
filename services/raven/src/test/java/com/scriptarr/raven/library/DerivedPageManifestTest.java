package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Saved-format identities, complete logical geometry and full-first-page cover invariants. */
class DerivedPageManifestTest {
    /** Complete validation must parse one snapshot rather than reading the full manifest for every physical tile. */
    @Test void reusableUsesOneValidatedManifestSnapshot(@TempDir Path root) throws Exception {
        LibraryChapter chapter = chapter(root);
        try (var saved = mockStatic(DerivedPageManifest.class, CALLS_REAL_METHODS)) {
            assertTrue(DerivedPageManifest.reusable(chapter));
            saved.verify(() -> DerivedPageManifest.read(chapter), times(1));
        }
    }

    /** Catalog readiness reuses that same snapshot for counts and complete validation. */
    @Test void catalogFieldsUsesOneValidatedManifestSnapshot(@TempDir Path root) throws Exception {
        LibraryChapter chapter = chapter(root);
        try (var saved = mockStatic(DerivedPageManifest.class, CALLS_REAL_METHODS)) {
            assertEquals(2, DerivedPageManifest.catalogFields(chapter).get("expectedSegmentCount"));
            saved.verify(() -> DerivedPageManifest.read(chapter), times(1));
        }
    }
    /** Touching a CBZ does not invalidate content-addressed WebP, while changed bytes do. */
    @Test void webpRevisionUsesContentRatherThanTimestamp(@TempDir Path root) throws Exception {
        Path source = source(root); String first = DerivedPageManifest.revision(source, 1, "webp", "ffmpeg/libwebp", 85);
        Files.setLastModifiedTime(source, FileTime.fromMillis(Files.getLastModifiedTime(source).toMillis() + 10000));
        assertEquals(first, DerivedPageManifest.revision(source, 1, "webp", "ffmpeg/libwebp", 85));
        byte[] bytes = Files.readAllBytes(source); bytes[0] ^= 1; Files.write(source, bytes);
        assertNotEquals(first, DerivedPageManifest.revision(source, 1, "webp", "ffmpeg/libwebp", 85));
    }

    /** New bounded raster profiles cannot overwrite a legacy successful content revision or reuse its content job. */
    @Test void segmentationVersionHasAnIndependentImmutableRevision(@TempDir Path root) throws Exception {
        Path source = source(root);
        String legacy = DerivedPageManifest.revision(source, 1, "webp", "ffmpeg/libwebp", 85, 1), bounded = DerivedPageManifest.revision(source, 1, "webp", "ffmpeg/libwebp", 85, 2);
        assertNotEquals(legacy, bounded); assertEquals(legacy, DerivedPageManifest.revision(source, 1, "webp", "ffmpeg/libwebp", 85));
        assertTrue(DerivedPageManifest.reusable(chapter(root)));
    }

    /** Every segment belongs to the same logical page; no-selector reads cannot silently return its top. */
    @Test void segmentedLogicalPageRequiresExplicitIdentity(@TempDir Path root) throws Exception {
        LibraryChapter chapter = chapter(root);
        assertTrue(DerivedPageManifest.reusable(chapter));
        assertThrows(java.io.IOException.class, () -> DerivedPageManifest.page(chapter, 0, null, false));
        assertEquals("p000001-s0001.webp", DerivedPageManifest.page(chapter, 0, 1, false).getFileName().toString());
        assertEquals("p000001-thumbnail.webp", DerivedPageManifest.page(chapter, 0, null, true).getFileName().toString());
        assertEquals(Map.of("sourcePageCount", 1, "expectedSegmentCount", 2, "ingestedSegmentCount", 2, "segmentsReady", true), DerivedPageManifest.catalogFields(chapter));
    }

    /** A missing unsampled tile or corrupt thumbnail makes the complete logical chapter unready. */
    @Test void allSegmentsAndThumbnailAreRequired(@TempDir Path root) throws Exception {
        LibraryChapter chapter = chapter(root); Path directory = Path.of(chapter.ingestManifestPath()).getParent();
        Files.write(directory.resolve("p000001-thumbnail.webp"), new byte[]{9});
        assertFalse(DerivedPageManifest.reusable(chapter));
        Files.write(directory.resolve("p000001-thumbnail.webp"), new byte[]{3, 4});
        assertTrue(DerivedPageManifest.reusable(chapter));
        Files.delete(directory.resolve("p000001-s0001.webp"));
        assertFalse(DerivedPageManifest.reusable(chapter));
        assertThrows(java.io.IOException.class, () -> DerivedPageManifest.page(chapter, 0, 0, false));
    }

    /** Files alone cannot convert a pending or failed durable checkpoint into reader completion evidence. */
    @Test void pendingAndFailedRowsWithValidFilesAreNotReady(@TempDir Path root) throws Exception {
        LibraryChapter ready = chapter(root); ObjectMapper json = new ObjectMapper();
        for (String state : List.of("pending", "failed")) {
            var row = json.valueToTree(ready); ((com.fasterxml.jackson.databind.node.ObjectNode) row).put("ingestStatus", state);
            assertFalse(DerivedPageManifest.reusable(json.treeToValue(row, LibraryChapter.class)));
        }
    }

    /** Legacy AVIF bytes remain readable without a WebP worker or current encoder policy. */
    @Test void legacyAvifManifestRemainsReadable(@TempDir Path root) throws Exception {
        Path archive = source(root), directory = root.resolve("old"); Files.createDirectories(directory); Files.write(directory.resolve("p000001.avif"), new byte[]{1, 2});
        String revision = DerivedPageManifest.revision(archive, 1, "avif", "ffmpeg/libaom-av1", 50);
        Path manifest = directory.resolve("manifest.json"); new ObjectMapper().writeValue(manifest.toFile(), Map.of("format", "avif", "mediaType", "image/avif", "chapterId", "chapter", "revision", revision, "quality", 50, "encoder", "ffmpeg/libaom-av1", "pageCount", 1, "pages", List.of(Map.of("index", 0, "slug", "p000001.avif"))));
        LibraryChapter chapter = ready(archive, manifest, revision);
        assertTrue(DerivedPageManifest.reusable(chapter)); assertEquals("p000001.avif", DerivedPageManifest.page(chapter, 0, null, false).getFileName().toString());
    }

    /** @param root isolated fixture root @return one logical image archive @throws Exception when writing fails */
    static Path source(Path root) throws Exception {
        Files.createDirectories(root); Path archive = root.resolve("source.cbz");
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archive))) { zip.putNextEntry(new ZipEntry("001.png")); zip.write(new byte[]{1, 2, 3}); zip.closeEntry(); }
        return archive;
    }

    /** @param root isolated fixture root @return complete two-segment logical chapter @throws Exception when writing fails */
    static LibraryChapter chapter(Path root) throws Exception {
        Path archive = source(root), directory = root.resolve("webp"); Files.createDirectories(directory);
        Files.write(directory.resolve("p000001-s0000.webp"), new byte[]{1, 2}); Files.write(directory.resolve("p000001-s0001.webp"), new byte[]{2, 3}); Files.write(directory.resolve("p000001-thumbnail.webp"), new byte[]{3, 4});
        Map<String, Object> first = file(directory.resolve("p000001-s0000.webp"), 16383, 1), last = file(directory.resolve("p000001-s0001.webp"), 1, 1);
        first.putAll(Map.of("index", 0, "x", 0, "y", 0)); last.putAll(Map.of("index", 1, "x", 16383, "y", 0));
        String revision = DerivedPageManifest.revision(archive, 1, "webp", "ffmpeg/libwebp", 85); Path manifest = directory.resolve("manifest.json");
        Map<String, Object> metadata = new LinkedHashMap<>(Map.of("format", "webp", "mediaType", "image/webp", "chapterId", "chapter", "revision", revision, "quality", 85, "method", 4, "segmentationVersion", 1, "encoder", "ffmpeg/libwebp", "pageCount", 1));
        metadata.put("pages", List.of(Map.of("index", 0, "width", 16384, "height", 1, "segments", List.of(first, last), "thumbnail", file(directory.resolve("p000001-thumbnail.webp"), 512, 1))));
        new ObjectMapper().writeValue(manifest.toFile(), metadata); return ready(archive, manifest, revision);
    }

    /** @param file exact derived fixture @param width original geometry @param height original geometry @return mutable manifest declaration @throws Exception when hashing fails */
    private static Map<String, Object> file(Path file, int width, int height) throws Exception { return new LinkedHashMap<>(Map.of("slug", file.getFileName().toString(), "size", Files.size(file), "sha256", WebpChapterEncoder.sha256(file), "width", width, "height", height)); }

    /** @param archive canonical source @param manifest saved manifest @param revision saved identity @return reader-ready chapter */
    static LibraryChapter ready(Path archive, Path manifest, String revision) { return new LibraryChapter("chapter", "Chapter 1", "1", 1, "", true, archive.toString(), "", "clean", 1, 0, List.of(), List.of(), "ready", revision, 1, "2026-11-08T00:00:00Z", "", manifest.toString(), "2026-11-08T00:00:00Z"); }
}
