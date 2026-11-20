package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.scriptarr.raven.settings.RavenBrokerClient;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Completed payload cleanup requires durable and canonical proof, and cannot affect active writers. */
class CompletedArtifactRetentionTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Empty and malformed published metadata remain typed reconstruction failures after duplicate removal. */
    @Test void corruptReclaimedManifestRequiresReconstruction(@TempDir Path root) throws Exception {
        Fixture f = fixture(root);
        assertTrue(CompletedArtifactRetention.reclaim(root, f.catalog, f.job, Instant.parse("2026-11-20T12:00:00Z")));
        for (String broken : List.of("", "{malformed")) {
            Files.writeString(Path.of(f.chapter.ingestManifestPath()), broken);
            assertThrows(CompletedArtifactRetention.OutputUnavailable.class, () -> CompletedArtifactRetention.canonical(root, f.catalog, f.job));
        }
    }

    /** @param root isolated canonical storage @throws Exception when fixture IO fails */
    @Test void reclaimsOnlyDuplicatePayloadAndCanReplayFromCanonicalOutput(@TempDir Path root) throws Exception {
        Fixture f = fixture(root);
        try (var writer = ContentMaintenance.enter("title:title")) {
            assertFalse(CompletedArtifactRetention.reclaim(root, f.catalog, f.job, Instant.parse("2026-11-20T12:00:00Z")));
        }
        assertTrue(CompletedArtifactRetention.reclaim(root, f.catalog, f.job, Instant.parse("2026-11-20T12:00:00Z")));
        assertTrue(Files.exists(f.files.resolve("bundle.json")));
        assertTrue(Files.exists(f.files.resolve("payload-reclaimed.json")));
        try (var paths = Files.list(f.files)) { assertFalse(paths.anyMatch(p -> p.toString().endsWith(".webp"))); }
        assertEquals(f.chapter, CompletedArtifactRetention.canonical(root, f.catalog, f.job));
        assertTrue(DerivedPageManifest.reusable(f.chapter));
        assertFalse(CompletedArtifactRetention.reclaim(root, f.catalog, f.job, Instant.parse("2026-11-20T12:00:00Z")));
    }

    /** @param root isolated canonical storage @throws Exception when fixture IO fails */
    @Test void preservesUnfinishedRecentOrUnverifiedArtifacts(@TempDir Path root) throws Exception {
        Fixture f = fixture(root); f.job.put("status", "publishing");
        assertFalse(CompletedArtifactRetention.reclaim(root, f.catalog, f.job, Instant.parse("2026-11-20T12:00:00Z")));
        f.job.put("status", "completed");
        assertFalse(CompletedArtifactRetention.reclaim(root, f.catalog, f.job, Instant.parse("2026-11-18T13:00:00Z")));
        Files.write(f.files.resolve("unrecognized.webp"), new byte[]{1, 2});
        assertThrows(Exception.class, () -> CompletedArtifactRetention.reclaim(root, f.catalog, f.job, Instant.parse("2026-11-20T12:00:00Z")));
        assertTrue(Files.exists(f.files.resolve("unrecognized.webp"))); assertTrue(DerivedPageManifest.reusable(f.chapter));
    }

    /** @param root isolated root @return strict completed publication @throws Exception when constructing files fails */
    private Fixture fixture(Path root) throws Exception {
        LibraryChapter old = DerivedPageManifestTest.chapter(root.resolve("downloaded/manga/title"));
        Path destination = root.resolve("ingested/manga/title/chapter/" + old.ingestRevision()); Files.createDirectories(destination.getParent());
        Files.move(Path.of(old.ingestManifestPath()).getParent(), destination);
        ObjectNode row = JSON.valueToTree(old); row.put("ingestManifestPath", destination.resolve("manifest.json").toString());
        LibraryChapter chapter = JSON.treeToValue(row, LibraryChapter.class);
        String id = "raven_webp_" + "a".repeat(64);
        ObjectNode manifest = (ObjectNode) JSON.readTree(destination.resolve("manifest.json").toFile());
        manifest.put("conversionJobId", id).put("conversionEpoch", 1).put("artifactSha256", "b".repeat(64));
        JSON.writeValue(destination.resolve("manifest.json").toFile(), manifest);
        Path files = root.resolve(".ingest-jobs/" + id + "/1/files"); Files.createDirectories(files);
        try (var paths = Files.list(destination)) { for (Path file : paths.filter(p -> p.toString().endsWith(".webp")).toList()) Files.copy(file, files.resolve(file.getFileName())); }
        JSON.writeValue(files.resolve("bundle.json").toFile(), manifest);
        RavenBrokerClient catalog = mock(RavenBrokerClient.class);
        when(catalog.getLibraryTitle("title")).thenReturn(JSON.valueToTree(Map.of("id", "title", "chapters", List.of(chapter))));
        ObjectNode job = JSON.valueToTree(Map.of("jobId", id, "status", "completed", "updatedAt", "2026-11-18T12:00:00Z", "lease", Map.of("epoch", 1),
            "spec", Map.of("input", Map.of("titleId", "title", "chapterId", "chapter", "sourceFingerprint", Map.of("size", Files.size(Path.of(chapter.archivePath())), "sha256", WebpChapterEncoder.sha256(Path.of(chapter.archivePath()))))),
            "result", Map.of("artifact", Map.of("sha256", "b".repeat(64)), "chapter", chapter)));
        return new Fixture(catalog, chapter, job, files);
    }

    /** @param catalog strict store @param chapter canonical checkpoint @param job completed receipt @param files duplicate payload */
    private record Fixture(RavenBrokerClient catalog, LibraryChapter chapter, ObjectNode job, Path files) { }
}
