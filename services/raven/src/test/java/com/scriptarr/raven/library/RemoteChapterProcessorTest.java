package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.scriptarr.raven.settings.RavenNamingSettings;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Actual HTTP protocol checks across coordinator ownership, waiting, fencing and completion replay. */
class RemoteChapterProcessorTest {
    /** Upgrades reattach pending and accepted legacy executions through normal create rather than allocating another job. */
    @Test void legacyExecutionsReattachWithoutAnotherConversion(@TempDir Path root) throws Exception {
        for (String status : List.of("queued", "running", "result-ready", "publishing", "completed")) {
            try (Fixture f = new Fixture(root.resolve(status))) {
                f.legacy(status);
                if (List.of("queued", "running").contains(status)) {
                    assertThrows(InterruptedException.class, () -> f.processor.convert(f.title, f.chapter, f.archive, RavenNamingSettings.defaults(), () -> true, progress -> { }));
                } else {
                    RemoteChapterProcessor.Result result = f.processor.convert(f.title, f.chapter, f.archive, RavenNamingSettings.defaults(), () -> false, progress -> { });
                    assertEquals(f.legacyId, result.jobId()); assertEquals(1, result.epoch());
                    assertEquals(status.equals("completed"), result.completedChapter() != null);
                    assertTrue(OrderedPageIdentity.fields(result.bundle()).isEmpty());
                }
                assertEquals(f.legacyId, f.created.get().path("jobId").asText());
                assertFalse(f.created.get().path("spec").path("input").has("contentIdentityVersion"));
                assertFalse(f.created.get().path("spec").path("input").has("orderedEntriesSha256"));
                assertEquals(0, f.submits.get()); assertEquals(0, f.completes.get());
            }
        }
    }

    /** Only an authoritative absence or a valid different ordered list may select a new version2 identity. */
    @Test void legacyLookupDoesNotHideMalformedOrUnavailableState(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            assertThrows(InterruptedException.class, () -> f.processor.convert(f.title, f.chapter, f.archive, RavenNamingSettings.defaults(), () -> true, progress -> { }));
            assertEquals(f.id, f.created.get().path("jobId").asText()); assertEquals(2, f.created.get().path("spec").path("input").path("contentIdentityVersion").asInt());
            f.created.set(null); f.legacyLookupStatus = 503;
            assertThrows(java.io.IOException.class, () -> f.processor.convert(f.title, f.chapter, f.archive, RavenNamingSettings.defaults(), () -> true, progress -> { }));
            assertNull(f.created.get());
            f.legacy("queued"); f.legacyLookup.remove("spec");
            assertThrows(java.io.IOException.class, () -> f.processor.convert(f.title, f.chapter, f.archive, RavenNamingSettings.defaults(), () -> true, progress -> { }));
            assertNull(f.created.get());
            f.legacy("queued"); ((ObjectNode) f.legacyLookup.path("spec").path("input").path("sourceFingerprint")).put("size", 1);
            assertThrows(java.io.IOException.class, () -> f.processor.convert(f.title, f.chapter, f.archive, RavenNamingSettings.defaults(), () -> true, progress -> { }));
            assertNull(f.created.get());
        }
    }

    /** Actual canonical entries reordered by naming settings need separate jobs, while unchanged ordering replays. */
    @Test void frozenPageOrderChangesConversionIdentity(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(f.archive))) {
                for (String name : List.of("001_p2.png", "002_p1.png")) {
                    zip.putNextEntry(new ZipEntry(name)); zip.write(new byte[]{1}); zip.closeEntry();
                }
            }
            assertThrows(InterruptedException.class, () -> f.processor.convert(f.title, f.chapter, f.archive, RavenNamingSettings.defaults(), () -> true, progress -> { }));
            JsonNode original = f.created.get().deepCopy();
            f.legacy("queued");
            ObjectNode legacyInput = (ObjectNode) f.legacyLookup.path("spec").path("input");
            legacyInput.put("sourcePageCount", 2).set("entries", original.path("spec").path("input").path("entries"));
            ((ObjectNode) legacyInput.path("sourceFingerprint")).put("sha256", WebpChapterEncoder.sha256(f.archive)).put("size", Files.size(f.archive));
            f.legacyId = RemoteChapterProcessor.jobId("title", "chapter", WebpChapterEncoder.sha256(f.archive)); f.legacyLookup.put("jobId", f.legacyId);
            RavenNamingSettings reordered = new RavenNamingSettings("{title} c{chapter_padded}.cbz", "{chapter_padded}_p{page}{ext}", 2, 3, 2);
            assertThrows(InterruptedException.class, () -> f.processor.convert(f.title, f.chapter, f.archive, reordered, () -> true, progress -> { }));
            JsonNode changed = f.created.get().deepCopy();
            assertEquals(List.of("001_p2.png", "002_p1.png"), new ObjectMapper().convertValue(original.path("spec").path("input").path("entries"), List.class));
            assertEquals(List.of("002_p1.png", "001_p2.png"), new ObjectMapper().convertValue(changed.path("spec").path("input").path("entries"), List.class));
            assertNotEquals(original.path("jobId"), changed.path("jobId"), "Frozen logical page order is part of the content job identity.");
            RavenNamingSettings sameOrder = new RavenNamingSettings("Changed_{chapter}.cbz", "{chapter_padded}_p{page}{ext}", 4, 3, 2);
            assertThrows(InterruptedException.class, () -> f.processor.convert(f.title, f.chapter, f.archive, sameOrder, () -> true, progress -> { }));
            assertEquals(changed.path("jobId"), f.created.get().path("jobId"), "Unrelated naming changes must not allocate another content job.");
        }
    }

    /** A missing worker waits without local encoding, retaining parent attribution and cancelling only its observed epoch. */
    @Test void workerWaitCarriesPriorityAndCancelFence(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            f.job.put("status", "queued"); ((ObjectNode) f.job.path("lease")).put("epoch", 7);
            f.cancelEpoch.set(8);
            AtomicInteger checks = new AtomicInteger();
            try (var context = IngestExecutionContext.enter("bulk", Map.of("runId", "run", "downloadTaskId", "task", "attemptId", "attempt-2"))) {
                assertThrows(InterruptedException.class, () -> f.processor.convert(f.title, f.chapter, f.archive, RavenNamingSettings.defaults(), () -> checks.incrementAndGet() > 1, progress -> { }));
            }
            assertEquals("bulk", f.created.get().path("priority").asText());
            assertEquals("attempt-2", f.created.get().path("spec").path("owner").path("attemptId").asText());
            assertEquals("execution-old", f.cancelled.get().path("expectedCoordinatorGeneration").asText());
            assertFalse(f.cancelled.get().has("expectedEpoch"));
            assertEquals(8, f.job.path("lease").path("epoch").asLong()); assertEquals("queued", f.job.path("status").asText());
            assertEquals(0, f.submits.get()); assertEquals(0, f.completes.get());
            assertEquals("interactive", IngestExecutionContext.current().get("kind"));
        }
    }

    /** The actual running vocabulary authorizes exact input; stale epochs and source changes fail closed. */
    @Test void runningLeaseAndInputFingerprintAreRequired(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            assertEquals(f.archive, f.processor.input(f.id, "worker", 1));
            assertThrows(Exception.class, () -> f.processor.input(f.id, "worker", 2));
            Files.write(f.archive, new byte[]{1, 2, 3});
            assertThrows(Exception.class, () -> f.processor.input(f.id, "worker", 1));
        }
    }

    /** Worker claim/reassignment changes epoch without changing the coordinator's right to stop its own execution. */
    @Test void sameGenerationCanCancelAfterQueuedClaim(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            f.job.put("status", "queued"); f.cancelEpoch.set(2); f.rotateOnCancel = false; AtomicInteger checks = new AtomicInteger();
            assertThrows(InterruptedException.class, () -> f.processor.convert(f.title, f.chapter, f.archive, RavenNamingSettings.defaults(), () -> checks.incrementAndGet() > 1, progress -> { }));
            assertEquals("execution-old", f.cancelled.get().path("expectedCoordinatorGeneration").asText()); assertEquals("cancelled", f.job.path("status").asText());
        }
    }

    /** Completed exact replay reads the current chapter and does not write a changed timestamp or spend another execution. */
    @Test void acceptedCompletionReplayDoesNotWriteAgain(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root); var manifest = mockStatic(DerivedPageManifest.class)) {
            manifest.when(() -> DerivedPageManifest.catalogFields(f.chapter)).thenReturn(Map.of());
            f.job.put("status", "completed"); f.job.set("result", f.json.valueToTree(Map.of("artifact", Map.of("sha256", "a".repeat(64)))));
            RemoteChapterProcessor.Result result = new RemoteChapterProcessor.Result(f.id, 1, "a".repeat(64), null, null);
            assertEquals(f.chapter, f.processor.complete(result, f.chapter)); assertEquals(0, f.completes.get());
            assertThrows(Exception.class, () -> f.processor.complete(new RemoteChapterProcessor.Result(f.id, 2, "a".repeat(64), null, null), f.chapter));
        }
    }

    /** A retry caller retains failed segment readiness until actual manifest validation supplies authoritative ready evidence. */
    @Test void completedArtifactNormalizesRetainedFailedSegmentReadiness(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root); var manifest = mockStatic(DerivedPageManifest.class)) {
            ObjectNode original = f.json.valueToTree(f.chapter);
            original.put("archivePath", "/downloads/downloaded/manga/Fixture/chapter.cbz")
                .put("ingestManifestPath", "/downloads/ingested/manga/title/chapter/webp-1111111111111111/manifest.json")
                .put("sourcePageCount", 1).put("expectedSegmentCount", 1).put("ingestedSegmentCount", 1).put("segmentsReady", true);
            f.job.put("status", "completed"); f.job.set("result", f.json.valueToTree(Map.of("artifact", Map.of("sha256", "a".repeat(64), "segmentCount", 1), "chapter", original)));
            ObjectNode current = original.deepCopy(); current.put("ingestStatus", "failed").put("ingestError", "A saved tile is missing.").put("segmentsReady", false)
                .put("qualityStatus", "possible_missing_page").put("missingPageCount", 1);
            current.putArray("missingPages").add(1); current.putArray("qualityNotes").add("Retained reader quality evidence."); current.putObject("futureMetadata").putNull("retained");
            f.catalog.putLibraryChapters("title", Map.of("chapters", List.of(f.json.convertValue(current, Map.class))));
            ObjectNode desired = current.deepCopy(); desired.put("ingestStatus", "ready").put("ingestError", "");
            LibraryChapter checkpoint = f.json.treeToValue(desired, LibraryChapter.class);
            assertEquals(Boolean.FALSE, checkpoint.segmentsReady(), "The real retry copy retains the prior failed checkpoint flag.");
            manifest.when(() -> DerivedPageManifest.catalogFields(checkpoint)).thenReturn(Map.of("sourcePageCount", 1, "expectedSegmentCount", 1, "ingestedSegmentCount", 1, "segmentsReady", true));
            RemoteChapterProcessor.Result result = new RemoteChapterProcessor.Result(f.id, 1, "a".repeat(64), null, null);
            LibraryChapter saved = f.processor.complete(result, checkpoint);
            assertEquals("ready", saved.ingestStatus()); assertEquals(Boolean.TRUE, saved.segmentsReady()); assertEquals(current.path("qualityNotes"), f.completedBody.get().path("chapter").path("qualityNotes"));
            assertEquals(Boolean.FALSE, checkpoint.segmentsReady(), "Validation must not mutate the caller's retained state.");
            assertEquals("execution-old", f.completedBody.get().path("expectedCoordinatorGeneration").asText());
            Map<String, Object> validated = f.json.convertValue(checkpoint, Map.class); validated.putAll(DerivedPageManifest.catalogFields(checkpoint));
            Map<String, Object> expected = CompletedArtifactRepair.request(f.job, current, validated);
            assertEquals(f.json.valueToTree(expected).path("repair"), f.completedBody.get().path("repair"));
            assertEquals(1, f.completes.get()); assertEquals(0, f.submits.get()); assertNull(f.created.get());
            f.catalog.putLibraryChapters("title", Map.of("chapters", List.of(f.json.convertValue(saved, Map.class))));
            assertEquals(saved, f.processor.complete(result, checkpoint)); assertEquals(1, f.completes.get());
            ObjectNode changed = current.deepCopy(); changed.put("archivePath", "/downloads/downloaded/manga/Other/chapter.cbz");
            f.catalog.putLibraryChapters("title", Map.of("chapters", List.of(f.json.convertValue(changed, Map.class))));
            assertThrows(Exception.class, () -> f.processor.complete(result, checkpoint)); assertEquals(1, f.completes.get());
            f.catalog.putLibraryChapters("title", Map.of("chapters", List.of(f.json.convertValue(current, Map.class))));
            f.invalidCompletionAck = true;
            assertThrows(java.io.IOException.class, () -> f.processor.complete(result, checkpoint), "A false broker acknowledgment must still fail against validated readiness.");
            assertEquals(2, f.completes.get()); assertEquals(0, f.submits.get());
        }
    }

    /** Invalid artifact ZIPs cannot submit metadata or alter canonical bytes. */
    @Test void invalidArtifactNeverReachesSubmit(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            String before = WebpChapterEncoder.sha256(f.archive);
            assertThrows(Exception.class, () -> f.processor.accept(f.id, "worker", 1, "lease", new ByteArrayInputStream(new byte[]{1, 2, 3})));
            assertEquals(0, f.submits.get()); assertEquals(before, WebpChapterEncoder.sha256(f.archive));
        }
    }

    /** Exact disk-backed upload replay survives JSON integer normalization; changed bytes cannot replace it. */
    @Test void acceptedArtifactReplayRetainsImmutableFiles(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root); var media = mockStatic(MediaProcess.class)) {
            media.when(() -> MediaProcess.run(anyList(), anyBoolean())).thenAnswer(call -> (boolean) call.getArgument(1) ? "{\"streams\":[{\"width\":1,\"height\":1}]}".getBytes(java.nio.charset.StandardCharsets.UTF_8) : new byte[0]);
            byte[] artifact = artifact(false);
            f.processor.accept(f.id, "worker", 1, "lease", new ByteArrayInputStream(artifact));
            Path file = root.resolve(".ingest-jobs").resolve(f.id).resolve("1/files/p000001-s0000.webp"); String hash = WebpChapterEncoder.sha256(file); long modified = Files.getLastModifiedTime(file).toMillis();
            f.processor.accept(f.id, "worker", 1, "lease", new ByteArrayInputStream(artifact));
            assertEquals(2, f.submits.get()); assertEquals(hash, WebpChapterEncoder.sha256(file)); assertEquals(modified, Files.getLastModifiedTime(file).toMillis());
            assertThrows(Exception.class, () -> f.processor.accept(f.id, "worker", 1, "lease", new ByteArrayInputStream(artifact(true))));
            assertEquals(2, f.submits.get()); assertEquals(hash, WebpChapterEncoder.sha256(file));
        }
    }

    /** @param changed whether to alter one accepted output byte @return bounded exact chapter artifact @throws Exception when ZIP serialization fails */
    private static byte[] artifact(boolean changed) throws Exception {
        byte[] image = new byte[]{'R', 'I', 'F', 'F', 8, 0, 0, 0, 'W', 'E', 'B', 'P', 1, 2, 3, (byte) (changed ? 5 : 4)};
        String hash = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(image));
        Map<String, Object> segment = Map.of("slug", "p000001-s0000.webp", "width", 1, "height", 1, "size", image.length, "sha256", hash, "index", 0, "x", 0, "y", 0);
        Map<String, Object> thumbnail = Map.of("slug", "p000001-thumbnail.webp", "width", 1, "height", 1, "size", image.length, "sha256", hash);
        Map<String, Object> bundle = new java.util.LinkedHashMap<>(Map.of("format", "webp", "mediaType", "image/webp", "encoder", "ffmpeg/libwebp", "profile", RemoteChapterProcessor.PROFILE, "pageCount", 1,
            "pages", List.of(Map.of("index", 0, "width", 1, "height", 1, "segments", List.of(segment), "thumbnail", thumbnail))));
        bundle.putAll(OrderedPageIdentity.create(List.of("001.png")));
        byte[] metadata = new ObjectMapper().writeValueAsBytes(bundle);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
            for (var entry : Map.of("bundle.json", metadata, "p000001-s0000.webp", image, "p000001-thumbnail.webp", image).entrySet()) { zip.putNextEntry(new ZipEntry(entry.getKey())); zip.write(entry.getValue()); zip.closeEntry(); }
        }
        return bytes.toByteArray();
    }

    /** HTTP-backed isolated broker with only scoped catalog rows and no production configuration. */
    private static final class Fixture implements AutoCloseable {
        private final ObjectMapper json = new ObjectMapper();
        private final HttpServer server;
        private final Path archive;
        private final String id;
        private String legacyId;
        private final LibraryChapter chapter;
        private final LibraryTitle title;
        private final ObjectNode job;
        private final RemoteChapterProcessor processor;
        private final FakeRavenBrokerClient catalog = new FakeRavenBrokerClient();
        private final AtomicReference<JsonNode> created = new AtomicReference<>(), cancelled = new AtomicReference<>(), completedBody = new AtomicReference<>();
        private final AtomicInteger submits = new AtomicInteger(), completes = new AtomicInteger();
        private final AtomicInteger cancelEpoch = new AtomicInteger(-1);
        private boolean rotateOnCancel = true;
        private boolean invalidCompletionAck;
        private ObjectNode legacyLookup;
        private int legacyLookupStatus = 404;

        /** @param root isolated storage @throws Exception when local fixture creation fails */
        private Fixture(Path root) throws Exception {
            Path canonical = root.resolve("downloaded/manga/Fixture"); archive = DerivedPageManifestTest.source(canonical);
            chapter = new LibraryChapter("chapter", "Chapter 1", "1", 1, "", true, archive.toString(), "", "clean", 1, 0, List.of(), List.of(), "ready", "webp-1111111111111111", 1, "2026-11-08T00:00:00Z", "", canonical.resolve("manifest.json").toString(), "2026-11-08T00:00:00Z");
            title = new LibraryTitle("title", "Fixture", "Manga", "Manga", "manga", "active", "1", "", "", "", 1, 1, "", List.of(), List.of(), "", "", List.of(), "", "https://example.invalid/cover", "", canonical.toString(), List.of(chapter), "2026-11-08T00:00:00Z");
            id = RemoteChapterProcessor.jobId("title", "chapter", WebpChapterEncoder.sha256(archive), List.of("001.png"));
            legacyId = RemoteChapterProcessor.jobId("title", "chapter", WebpChapterEncoder.sha256(archive));
            job = json.valueToTree(Map.of("jobId", id, "status", "running", "lease", Map.of("workerId", "worker", "epoch", 1, "expiresAt", Instant.now().plusSeconds(120).toString()),
                "spec", Map.of("coordinatorGeneration", "execution-old", "input", Map.of("titleId", "title", "chapterId", "chapter", "sourcePageCount", 1, "entries", List.of("001.png"), "archiveName", "chapter.cbz", "sourceFingerprint", Map.of("sha256", WebpChapterEncoder.sha256(archive), "size", Files.size(archive))), "profile", RemoteChapterProcessor.PROFILE)));
            ((ObjectNode) job.path("spec").path("input")).setAll((ObjectNode) json.valueToTree(OrderedPageIdentity.create(List.of("001.png"))));
            catalog.putLibraryTitle("title", json.convertValue(title, Map.class)); catalog.putLibraryChapters("title", Map.of("chapters", json.convertValue(title.chapters(), List.class)));
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0); server.createContext("/api/internal/raven-ingest", this::handle); server.start();
            processor = new RemoteChapterProcessor(catalog, root, new IngestBrokerClient(Map.of("SCRIPTARR_SAGE_BASE_URL", "http://127.0.0.1:" + server.getAddress().getPort())), true);
        }

        /** @param status existing pre-version2 execution state @throws Exception when accepted fixture files cannot be written */
        private void legacy(String status) throws Exception {
            legacyLookupStatus = 200; legacyLookup = job.deepCopy(); legacyLookup.put("jobId", legacyId).put("status", status);
            ObjectNode input = (ObjectNode) legacyLookup.path("spec").path("input"); input.remove(List.of("contentIdentityVersion", "orderedEntriesSha256"));
            ObjectNode result = legacyLookup.putObject("result"); result.putObject("artifact").put("sha256", "a".repeat(64)); result.set("chapter", json.valueToTree(chapter));
            Path files = archive.getParent().getParent().getParent().getParent().resolve(".ingest-jobs").resolve(legacyId).resolve("1/files"); Files.createDirectories(files);
            json.writeValue(files.resolve("bundle.json").toFile(), Map.of("format", "webp", "profile", RemoteChapterProcessor.PROFILE, "pageCount", 1, "pages", List.of()));
        }

        /** @param exchange one local broker request @throws java.io.IOException when test transport fails */
        private void handle(HttpExchange exchange) throws java.io.IOException {
            String path = exchange.getRequestURI().getPath();
            if (exchange.getRequestMethod().equals("GET") && path.endsWith("/jobs/" + legacyId)) {
                if (legacyLookupStatus != 200) { exchange.sendResponseHeaders(legacyLookupStatus, -1); exchange.close(); return; }
                byte[] bytes = json.writeValueAsBytes(legacyLookup); exchange.getResponseHeaders().set("Content-Type", "application/json"); exchange.sendResponseHeaders(200, bytes.length); exchange.getResponseBody().write(bytes); exchange.close(); return;
            }
            if (exchange.getRequestMethod().equals("GET") && path.contains("/jobs/") && !path.endsWith("/jobs/" + id)) { exchange.sendResponseHeaders(404, -1); exchange.close(); return; }
            JsonNode response = job;
            if (exchange.getRequestMethod().equals("POST")) {
                JsonNode body = json.readTree(exchange.getRequestBody());
                if (path.endsWith("/jobs")) { created.set(body); if (legacyLookup != null && body.path("jobId").asText().equals(legacyId)) response = legacyLookup; }
                if (path.endsWith("/cancel")) {
                    cancelled.set(body); if (cancelEpoch.get() >= 0) { ((ObjectNode) job.path("lease")).put("epoch", cancelEpoch.get()); if (rotateOnCancel) ((ObjectNode) job.path("spec")).put("coordinatorGeneration", "execution-new"); }
                    if (!body.path("expectedCoordinatorGeneration").asText().equals(job.path("spec").path("coordinatorGeneration").asText())) { exchange.sendResponseHeaders(409, -1); exchange.close(); return; }
                    job.put("status", "cancelled");
                }
                if (path.endsWith("/submit")) submits.incrementAndGet();
                if (path.endsWith("/complete")) {
                    completes.incrementAndGet(); completedBody.set(body);
                    ObjectNode acknowledgment = body.path("chapter").deepCopy();
                    if (invalidCompletionAck) acknowledgment.put("segmentsReady", false);
                    byte[] bytes = json.writeValueAsBytes(Map.of("job", job, "chapter", acknowledgment));
                    exchange.getResponseHeaders().set("Content-Type", "application/json"); exchange.sendResponseHeaders(200, bytes.length); exchange.getResponseBody().write(bytes); exchange.close(); return;
                }
            }
            byte[] bytes = json.writeValueAsBytes(Map.of("job", response)); exchange.getResponseHeaders().set("Content-Type", "application/json"); exchange.sendResponseHeaders(200, bytes.length); exchange.getResponseBody().write(bytes); exchange.close();
        }
        /** Stop only this test's loopback broker. */
        @Override public void close() { server.stop(0); }
    }
}
