package com.scriptarr.raven.library;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** Pure geometry, input-bound, TLS and actual maintenance writer contracts. */
class WebpWorkerContractsTest {
    /** Normal odd pages remain one logical full-resolution image. */
    @Test void normalOddPageIsNotPaddedOrResized() {
        assertEquals(List.of(new WebpSegmentation.Rectangle(0, 0, 0, 257, 513)), WebpSegmentation.split(257, 513));
    }

    /** Both dimensions split with exact row-major coverage and no dropped pixels. */
    @Test void oversizedBothDimensionsCoverOriginalExactly() {
        var rectangles = WebpSegmentation.split(16384, 16384);
        assertEquals(8, rectangles.size());
        assertEquals(268435456L, rectangles.stream().mapToLong(r -> (long) r.width() * r.height()).sum());
        assertEquals(new WebpSegmentation.Rectangle(7, 16383, 12288, 1, 4096), rectangles.getLast());
        assertTrue(rectangles.stream().allMatch(r -> r.width() <= 16383 && r.height() <= 16383));
        assertTrue(rectangles.stream().allMatch(r -> (long) r.width() * r.height() <= WebpSegmentation.MAX_TILE_PIXELS && (8L * r.width() + 1024) * (r.height() + 128L) < Integer.MAX_VALUE));
        assertEquals(4, WebpSegmentation.split(16384, 16384, 1).size());
        assertEquals(10, WebpSegmentation.split(17000, 17000, 2).size());
    }

    /** Resource and frontend bounds fail explicitly rather than crop, resize or silently omit segments. */
    @Test void invalidOrExcessiveDimensionsFailClosed() {
        assertThrows(IllegalArgumentException.class, () -> WebpSegmentation.split(0, 100));
        assertThrows(IllegalArgumentException.class, () -> WebpSegmentation.split(100000, 100000));
        assertThrows(IllegalArgumentException.class, () -> WebpSegmentation.split(1, 16383 * 1024 + 1));
    }

    /** Central-directory lengths never substitute for actual byte-stream bounds. */
    @Test void actualEntryLengthIsBounded(@TempDir Path root) throws Exception {
        assertThrows(IOException.class, () -> WebpChapterEncoder.copyBounded(new ByteArrayInputStream(new byte[20]), root.resolve("too-long"), 10, 100));
        assertThrows(IOException.class, () -> WebpChapterEncoder.copyBounded(new ByteArrayInputStream(new byte[5]), root.resolve("too-short"), 10, 100));
        assertThrows(IOException.class, () -> WebpChapterEncoder.copyBounded(new ByteArrayInputStream(new byte[20]), root.resolve("over-budget"), 20, 10));
        WebpChapterEncoder.copyBounded(new ByteArrayInputStream(new byte[20]), root.resolve("exact"), 20, 20);
        assertEquals(20, Files.size(root.resolve("exact")));
    }

    /** A worker must never downgrade its protected cross-host connection to plain HTTP. */
    @Test void workerRequiresTlsWhileExplicitIsolatedTestsRemainPossible() {
        assertThrows(IllegalArgumentException.class, () -> new IngestBrokerClient(Map.of("SCRIPTARR_RAVEN_ROLE", "ingest-worker", "SCRIPTARR_SAGE_BASE_URL", "http://example.invalid")));
        assertThrows(IllegalArgumentException.class, () -> new IngestBrokerClient(Map.of("SCRIPTARR_RAVEN_ROLE", "ingest-worker", "SCRIPTARR_SAGE_BASE_URL", "http://127.0.0.1:1", "SCRIPTARR_TEST_MODE", "true")));
    }

    /** Status changes cannot hide a real writer that has not exited its maintenance lease. */
    @Test void fenceWaitsForActualWriterAndBlocksNewWriters(@TempDir Path root) throws Exception {
        String operation = "writer-test"; String key = "title:" + root.getFileName();
        var writer = ContentMaintenance.enter(key);
        try {
            ContentMaintenance.block(root, operation, List.of(key));
            assertEquals(1, ContentMaintenance.active(List.of(key)));
            assertThrows(IllegalStateException.class, () -> ContentMaintenance.enter(key));
            try (var unrelated = ContentMaintenance.enter("title:unrelated")) { assertEquals(1, ContentMaintenance.active(List.of(key))); }
            writer.close(); assertEquals(0, ContentMaintenance.active(List.of(key)));
            ContentMaintenance.restore(root);
            assertThrows(IllegalStateException.class, () -> ContentMaintenance.enter(key));
        } finally { writer.close(); ContentMaintenance.release(root, operation); }
        try (var allowed = ContentMaintenance.enter(key)) { assertEquals(1, ContentMaintenance.active(List.of(key))); }
    }

    /** A title path fence covers descendant writers while preserving similarly named unrelated folders. */
    @Test void pathFenceUsesPathComponentsAndRetainsParentBounds(@TempDir Path root) throws Exception {
        Path selected = root.resolve("downloaded/manhua/Selected"); String key = ContentMaintenance.pathKey(selected);
        ContentMaintenance.block(root, "path-test", List.of(key));
        try {
            assertThrows(IllegalStateException.class, () -> ContentMaintenance.enter(ContentMaintenance.pathKey(selected.resolve("chapter.cbz"))));
            try (var unrelated = ContentMaintenance.enter(ContentMaintenance.pathKey(root.resolve("downloaded/manhua/SelectedOther")))) { assertEquals(0, ContentMaintenance.active(List.of(key))); }
        } finally { ContentMaintenance.release(root, "path-test"); }
    }

    /** Physical segment completion is distinct from logical page count. */
    @Test void segmentProgressDoesNotAdvanceLogicalPagePosition() {
        IngestProgress progress = new IngestProgress("ingesting", 0, 1, 0, 1, true, 3, 4);
        assertTrue(progress.advanced()); assertEquals(0, progress.completedPages()); assertEquals(3, progress.completedSegments());
    }
}
