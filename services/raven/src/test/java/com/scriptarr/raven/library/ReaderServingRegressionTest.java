package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Reader projection and missing-content regressions through the exact variant serving path. */
class ReaderServingRegressionTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    /** All pages must use the same parsed manifest instead of reparsing it for each logical index. */
    @Test void largeChapterUsesOneManifestSnapshot() throws Exception {
        LibraryChapter chapter = chapter("webp", Path.of("manifest.json"));
        var manifest = JSON.createObjectNode(); ArrayNode pages = manifest.putArray("pages");
        for (int index = 0; index < 250; index++) pages.addObject().put("width", index + 10).put("height", 80)
            .putArray("segments").addObject().put("index", 0).put("slug", "page-" + index);
        try (var saved = mockStatic(DerivedPageManifest.class)) {
            saved.when(() -> DerivedPageManifest.read(chapter)).thenReturn(manifest).thenThrow(new java.io.IOException("Later generation unavailable"));
            List<ReaderPage> result = ReaderPageDescriptors.describe(chapter, 250, "image/webp");
            assertEquals(250, result.size());
            for (int index = 0; index < result.size(); index++) {
                assertEquals(index + 10, result.get(index).width());
                assertEquals("page-" + index, result.get(index).segments().getFirst().get("slug"));
            }
            saved.verify(() -> DerivedPageManifest.read(chapter), times(1));
        }
    }

    /** Losing a legacy image must still persist the chapter and title quality checkpoint. */
    @Test void missingAvifVariantMarksQuality(@TempDir Path root) throws Exception { missingVariant(root, "avif"); }

    /** A missing WebP tile invalidates readiness and remains retryable from the retained archive identity. */
    @Test void missingWebpSegmentMarksQualityAndIngestFailure(@TempDir Path root) throws Exception { missingVariant(root, "webp"); }

    /** Existing source-damage evidence must not suppress a new derived-file failure checkpoint. */
    @Test void missingWebpSegmentWithSourceDamageStillFailsIngest(@TempDir Path root) throws Exception { missingVariant(root, "webp", true); }

    /** Another damaged chapter must not prevent the requested page's focused quality checkpoint. */
    @Test void missingWebpSegmentDoesNotReplaceBrokenSibling(@TempDir Path root) throws Exception { missingVariant(root, "webp", false, true); }

    /** Exercise invalid user selectors followed by actual loss of a declared saved variant. */
    private void missingVariant(Path root, String format) throws Exception {
        missingVariant(root, format, false);
    }

    /** Exercise loss independently of whether the upstream page already carried quality evidence. */
    private void missingVariant(Path root, String format, boolean sourceDamage) throws Exception {
        missingVariant(root, format, sourceDamage, false);
    }

    /** Verify the requested checkpoint remains independent of unrelated reader-file damage. */
    private void missingVariant(Path root, String format, boolean sourceDamage, boolean brokenSibling) throws Exception {
        Path pageFile = root.resolve("p000001" + (format.equals("webp") ? "-s0000" : "") + "." + format);
        Path manifestFile = root.resolve("manifest.json"); Files.writeString(pageFile, "saved encoded test bytes");
        var page = JSON.createObjectNode().put("index", 0).put("slug", pageFile.getFileName().toString()).put("width", 20).put("height", 20);
        if (format.equals("webp")) page.putArray("segments").addObject().put("index", 0).put("slug", pageFile.getFileName().toString()).put("size", Files.size(pageFile));
        JSON.writeValue(manifestFile.toFile(), Map.of("format", format, "revision", format + "-" + "a".repeat(16), "chapterId", "chapter", "mediaType", "image/" + format, "pageCount", 1, "pages", List.of(page)));
        LibraryChapter chapter = chapter(format, manifestFile);
        if (sourceDamage) {
            var damagedSource = JSON.valueToTree(chapter);
            ((com.fasterxml.jackson.databind.node.ObjectNode) damagedSource).put("qualityStatus", "possible_missing_page").put("missingPageCount", 1).putArray("missingPages").add(1);
            chapter = JSON.treeToValue(damagedSource, LibraryChapter.class);
        }
        var fixtureChapters = new java.util.ArrayList<>(List.of(chapter));
        if (brokenSibling) {
            var sibling = (com.fasterxml.jackson.databind.node.ObjectNode) JSON.valueToTree(chapter);
            sibling.put("id", "sibling").put("chapterNumber", "2").put("label", "Chapter 2").put("archivePath", "retained-other.cbz")
                .put("ingestManifestPath", root.resolve("missing-sibling-manifest.json").toString());
            fixtureChapters.add(JSON.treeToValue(sibling, LibraryChapter.class));
        }
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient();
        broker.setLibraryTitle(new LibraryTitle("title", "Reader Fixture", "manhua", "Manhua", "manhua", "active", "1", "#123456", "", "", fixtureChapters.size(), fixtureChapters.size(),
            "", List.of(), List.of(), "", null, List.of(), "", "https://example.invalid/cover.png", "", root.toString(), fixtureChapters, null));
        ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
        LibraryService service = new LibraryService(broker, new RavenSettingsService(broker, logger, List.of()), logger);
        try {
            assertNull(service.renderReaderPage("title", "chapter", 0, 99, false));
            assertNull(service.renderReaderPage("title", "chapter", -1, null, false));
            assertEquals(sourceDamage ? "possible_missing_page" : "clean", service.findTitle("title").chapters().stream().filter(row -> row.id().equals("chapter")).findFirst().orElseThrow().qualityStatus(), "Invalid selectors must not damage catalog quality.");
            Files.delete(pageFile);
            assertNull(service.renderReaderPage("title", "chapter", 0, 0, false));
            LibraryTitle updated = service.findTitle("title"); LibraryChapter damaged = updated.chapters().stream().filter(row -> row.id().equals("chapter")).findFirst().orElseThrow();
            assertEquals(List.of(1), damaged.missingPages()); assertEquals(1, damaged.missingPageCount());
            assertEquals("possible_missing_page", damaged.qualityStatus()); assertEquals(1, updated.partialChapterCount());
            assertEquals(chapter.archivePath(), damaged.archivePath());
            assertEquals(format.equals("webp") ? "failed" : "ready", damaged.ingestStatus());
            if (format.equals("webp")) {
                assertTrue(damaged.ingestError().contains("canonical archive"));
                assertTrue(java.time.Instant.parse(damaged.updatedAt()).isAfter(java.time.Instant.parse(chapter.updatedAt())), "A failure must advance the stored checkpoint even under clock skew and second-precision storage.");
            }
            if (brokenSibling) assertEquals("ready", updated.chapters().stream().filter(row -> row.id().equals("sibling")).findFirst().orElseThrow().ingestStatus());
        } finally { service.shutdownCatalogScanExecutor(); }
    }

    /** @param format saved image format @param manifest saved manifest @return an explicitly ready test chapter */
    private LibraryChapter chapter(String format, Path manifest) {
        return new LibraryChapter("chapter", "Chapter 1", "1", 1, "", true, "retained-source.cbz", "", "clean", 1, 0, List.of(), List.of(),
            "ready", format + "-" + "a".repeat(16), 1, "2026-11-08T00:00:00Z", "", manifest.toString(), format.equals("webp") ? "2099-11-08T00:00:00Z" : "");
    }
}
