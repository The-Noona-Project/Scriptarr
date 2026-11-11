package com.scriptarr.raven.downloader;

import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryNaming;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.library.ArchiveDownloadEvidence;
import com.scriptarr.raven.metadata.MetadataService;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Exercise canonical archive reuse through real restoration, catalog writes and reader ingest. */
class CanonicalArchiveRecoveryTest {
    @TempDir Path root;
    private DownloaderService downloader;
    private HttpServer server;

    /** Startup discovery without any broker chapter row must restore source quality from the canonical CBZ. */
    @Test
    void startupScanRestoresPlaceholderQualityWithoutCatalog() throws Exception {
        Context context = context();
        Path archive = archive(context, canonicalRoot(), 1);
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archive))) {
            zip.putNextEntry(new ZipEntry("page-1.png")); zip.write(image()); zip.closeEntry();
            ArchiveDownloadEvidence.write(zip, chapter(1).get("href"), 1, List.of(1), List.of("Verified damaged source page."), "missing_content");
        }
        Fingerprint before = fingerprint(archive);
        context.library().rescanDownloadedFiles();
        LibraryChapter chapter = context.library().listTitles().getFirst().chapters().getFirst();
        assertEquals(List.of(1), chapter.missingPages());
        assertEquals("missing_content", chapter.qualityStatus());
        assertEquals(before, fingerprint(archive));
    }

    /** Both canonical task recovery and a startup scan restore embedded placeholder quality without provider calls. */
    @Test
    void promotedPlaceholderArchiveRetainsQualityWithoutCatalog() throws Exception {
        Context context = context();
        Path archive = archive(context, canonicalRoot(), 1);
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archive))) {
            zip.putNextEntry(new ZipEntry("page-1.png")); zip.write(image()); zip.closeEntry();
            ArchiveDownloadEvidence.write(zip, chapter(1).get("href"), 1, List.of(1), List.of("Verified damaged source page."), "missing_content");
        }
        Map<Path, Fingerprint> untouched = Map.of(archive, fingerprint(archive));
        seedTask(context, null, List.of(chapter(1)), "offline-fixture", "failed", "Catalog write interrupted.", false);
        start(context);
        assertEquals("failed", awaitTask().get("status"));
        downloader.retryTask("restore-task");
        assertCompleted(awaitTask());
        LibraryChapter recovered = context.library().listTitles().getFirst().chapters().getFirst();
        assertEquals(List.of(1), recovered.missingPages());
        assertEquals("missing_content", recovered.qualityStatus());
        context.library().rescanDownloadedFiles();
        recovered = context.library().listTitles().getFirst().chapters().getFirst();
        assertEquals(List.of(1), recovered.missingPages());
        assertEquals("missing_content", recovered.qualityStatus());
        assertFingerprints(untouched);
        verifyNoProvider(context.provider());
    }

    /** Stop asynchronous test workers and local source servers. */
    @AfterEach
    void close() {
        if (downloader != null) downloader.shutdown();
        if (server != null) server.stop(0);
    }

    /** Finish a restored append offline, preserving its ready chapter and both canonical archives. */
    @Test
    void restoredPendingIngestNeedsNoProviderAndPreservesReadyFiles() throws Exception {
        Context context = context();
        LibraryTitle title = seed(context, 2, 1);
        Map<Path, Fingerprint> untouched = fingerprints(title, true);
        seedTask(context, title, List.of(chapter(1), chapter(2)), "offline-fixture", "running", "", false);
        start(context);
        assertCompleted(awaitTask());
        LibraryTitle finished = context.library().findTitle(title.id());
        assertTrue(new DownloadCompletionVerifier(context.library()).complete(finished, List.of(chapter(1), chapter(2))));
        assertFingerprints(untouched);
        verifyNoProvider(context.provider());
    }

    /** Canonical ingest recovery must retain source-only saved cover art without touching ready pages. */
    @Test
    void canonicalRecoveryRetainsSavedSourceCover() throws Exception {
        recoveredCover(1);
    }

    /** Already-ready completion recovery must repair missing art before its early return. */
    @Test
    void completedRecoveryRetainsSavedSourceCover() throws Exception {
        recoveredCover(2);
    }

    /** Run both recovery branches with no metadata provider and no accessible download provider. */
    private void recoveredCover(int ready) throws Exception {
        Context context = context();
        LibraryTitle title = seed(context, 2, ready);
        Map<Path, Fingerprint> untouched = fingerprints(title, true);
        seedTask(context, title, List.of(chapter(1), chapter(2)), "offline-fixture", "running", "", false,
            "https://images.example/source-only.jpg");
        start(context);
        Map<String, Object> finishedTask = awaitTask();
        assertCompleted(finishedTask);
        LibraryTitle finished = context.library().findTitle(title.id());
        assertEquals("https://images.example/source-only.jpg", finished.coverUrl());
        assertEquals(finished.coverUrl(), finishedTask.get("coverUrl"));
        for (LibraryChapter original : title.chapters()) {
            if ("ready".equals(original.ingestStatus())) {
                assertEquals(original, finished.chapters().stream().filter(c -> c.id().equals(original.id())).findFirst().orElseThrow());
            }
        }
        assertFingerprints(untouched);
        verifyNoProvider(context.provider());
    }

    /** A real startup rescan must retain ready output when an import had no prior working folder. */
    @Test
    void startupRescanPreservesReadyChapterBeforeOfflineRecovery() throws Exception {
        startupRescanRecovery(false);
    }

    /** Discovering a newly promoted archive must not reset another chapter's ready reader metadata. */
    @Test
    void startupRescanPreservesReadyChapterWhenAnotherArchiveWasPromoted() throws Exception {
        startupRescanRecovery(true);
    }

    /** Startup scanning must wait for ingest rather than replace a newer durable chapter checkpoint. */
    @Test
    void concurrentStartupRescanCannotOverwriteIngestCheckpoints() throws Exception {
        Context context = context();
        LibraryTitle title = seed(context, 2, 1);
        Map<Path, Fingerprint> untouched = fingerprints(title, true);
        CountDownLatch ingestEntered = new CountDownLatch(1);
        CountDownLatch finishIngest = new CountDownLatch(1);
        CompletableFuture<LibraryTitle> ingest = CompletableFuture.supplyAsync(() -> context.library().ingestTitle(title.id(), "qa", () -> false, progress -> {
            ingestEntered.countDown();
            try { if (!finishIngest.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test ingest gate timed out."); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException(error); }
        }));
        CompletableFuture<Void> scan = null;
        try {
            assertTrue(ingestEntered.await(5, TimeUnit.SECONDS));
            scan = CompletableFuture.runAsync(context.library()::rescanDownloadedFiles);
            Thread.sleep(150);
            assertFalse(scan.isDone(), "Catalog scan must coordinate with the active title ingest.");
        } finally {
            finishIngest.countDown();
            ingest.get(10, TimeUnit.SECONDS);
            if (scan != null) scan.get(10, TimeUnit.SECONDS);
        }
        LibraryTitle finished = context.library().findTitle(title.id());
        assertTrue(new DownloadCompletionVerifier(context.library()).complete(finished, List.of(chapter(1), chapter(2))));
        assertFingerprints(untouched);
    }

    /** Reconstruct missing broker catalog state after promotion without upstream lookup or archive replacement. */
    @Test
    void catalogFailureAfterPromotionRecoversFromFrozenCanonicalFiles() throws Exception {
        Context context = context();
        Path canonical = canonicalRoot();
        Path archive = archive(context, canonical, 1);
        Map<Path, Fingerprint> untouched = Map.of(archive, fingerprint(archive));
        seedTask(context, null, List.of(chapter(1)), "offline-fixture", "failed", "Failed to persist Raven title.", false);
        start(context);
        assertEquals("failed", awaitTask().get("status"));
        assertTrue(context.library().listTitles().isEmpty());
        verifyNoProvider(context.provider());
        downloader.retryTask("restore-task");
        assertCompleted(awaitTask());
        assertEquals(1, context.library().listTitles().size());
        LibraryTitle title = context.library().listTitles().getFirst();
        assertTrue(new DownloadCompletionVerifier(context.library()).complete(title, List.of(chapter(1))));
        assertFingerprints(untouched);
        verifyNoProvider(context.provider());
    }

    /** Repair a missing catalog row from its promoted CBZ without touching existing ready reader files. */
    @Test
    void missingCatalogChapterStateRecoversOfflineFromPromotedArchive() throws Exception {
        unhealthyCatalogRow(false);
    }

    /** Repair a stale exact-path page count even when its filename no longer matches current naming. */
    @Test
    void staleCatalogPageCountRecoversOfflineFromItsAuthoritativePath() throws Exception {
        unhealthyCatalogRow(true);
    }

    /** Fetch only the missing planned chapter while retaining old ready metadata and pending canonical bytes. */
    @Test
    void partialResumeDownloadsOnlyMissingChapterAndRetainsOlderCatalog() throws Exception {
        partialResume(false);
    }

    /** A source chapter that disappeared remains recoverable when its healthy canonical archive exists. */
    @Test
    void partialResumeAllowsDisappearedSourceChaptersWithHealthyArchives() throws Exception {
        partialResume(true);
    }

    /** Missing canonical and source chapters cannot be accepted as complete merely because another title row exists. */
    @Test
    void missingPlannedArchiveAndSourceRemainsFailed() throws Exception {
        Context context = context();
        LibraryTitle title = seed(context, 1, 1);
        Map<Path, Fingerprint> untouched = fingerprints(title, true);
        when(context.provider().getChapters(anyString())).thenReturn(List.of(chapter(1)));
        seedTask(context, title, List.of(chapter(1), chapter(2)), "weebcentral", "running", "", false);
        start(context);
        Map<String, Object> task = awaitTask();
        assertEquals("failed", task.get("status"));
        assertTrue(((Number) task.get("percent")).intValue() < 100);
        assertTrue(String.valueOf(task.get("message")).contains("disappeared"));
        assertFingerprints(untouched);
        verify(context.provider(), never()).resolvePages(anyString());
    }

    /** Cancellation at the ingest-only boundary never publishes a completed title task. */
    @Test
    void cancellationDuringCanonicalIngestNeverPublishesCompletion() throws Exception {
        Context original = context();
        LibraryTitle title = seed(original, 2, 1);
        Map<Path, Fingerprint> untouched = fingerprints(title, true);
        LibraryService library = spy(original.library());
        CountDownLatch ingestEntered = new CountDownLatch(1);
        doAnswer(call -> {
            ingestEntered.countDown();
            new CountDownLatch(1).await(10, TimeUnit.SECONDS);
            return call.callRealMethod();
        }).when(library).ingestTitle(anyString(), anyString(), any(), any());
        Context context = new Context(original.broker(), original.settings(), library, original.provider(), original.logger());
        seedTask(context, title, List.of(chapter(1), chapter(2)), "offline-fixture", "running", "", false);
        start(context);
        assertTrue(ingestEntered.await(5, TimeUnit.SECONDS));
        downloader.cancelTask("restore-task");
        Map<String, Object> task = awaitTask();
        assertEquals("failed", task.get("status"));
        assertTrue(String.valueOf(task.get("message")).toLowerCase().contains("cancel"));
        assertTrue(((Number) task.get("percent")).intValue() < 100);
        assertFingerprints(untouched);
        verifyNoProvider(context.provider());
    }

    /** Explicit replacement repairs must still fetch replacement content rather than reusing the old title. */
    @Test
    void explicitReplacementDoesNotAcceptExistingCanonicalArchives() throws Exception {
        Context context = context();
        LibraryTitle title = seed(context, 1, 1);
        Map<Path, Fingerprint> untouched = fingerprints(title, true);
        when(context.provider().getChapters(anyString())).thenThrow(new IllegalStateException("Replacement source offline."));
        seedTask(context, title, List.of(chapter(1)), "weebcentral", "running", "", true);
        start(context);
        Map<String, Object> task = awaitTask();
        assertEquals("failed", task.get("status"));
        assertTrue(((Number) task.get("percent")).intValue() < 100);
        verify(context.provider()).getChapters(anyString());
        assertFingerprints(untouched);
    }

    private void startupRescanRecovery(boolean newlyPromoted) throws Exception {
        Context context = context();
        LibraryTitle title = seed(context, newlyPromoted ? 1 : 2, 1);
        LibraryChapter ready = title.chapters().stream().filter(chapter -> chapter.chapterNumber().equals("1")).findFirst().orElseThrow();
        Map<Path, Fingerprint> untouched = fingerprints(title, true);
        if (newlyPromoted) {
            Path archive = archive(context, canonicalRoot(), 2);
            untouched.put(archive, fingerprint(archive));
        }
        assertTrue(title.workingRoot() == null || title.workingRoot().isBlank());
        context.library().rescanDownloadedFiles();
        LibraryChapter scanned = context.library().findTitle(title.id()).chapters().stream().filter(chapter -> chapter.chapterNumber().equals("1")).findFirst().orElseThrow();
        assertEquals("ready", scanned.ingestStatus());
        assertEquals(ready.ingestRevision(), scanned.ingestRevision());
        assertEquals(ready.ingestedAt(), scanned.ingestedAt());
        assertEquals(ready.ingestManifestPath(), scanned.ingestManifestPath());
        seedTask(context, title, List.of(chapter(1), chapter(2)), "offline-fixture", "running", "", false);
        start(context);
        assertCompleted(awaitTask());
        assertFingerprints(untouched);
        verifyNoProvider(context.provider());
    }

    private void unhealthyCatalogRow(boolean staleCount) throws Exception {
        Context context = context();
        LibraryTitle title = seed(context, 2, 1);
        LibraryChapter one = title.chapters().stream().filter(c -> c.chapterNumber().equals("1")).findFirst().orElseThrow();
        LibraryChapter two = title.chapters().stream().filter(c -> c.chapterNumber().equals("2")).findFirst().orElseThrow();
        String path = two.archivePath();
        if (staleCount) {
            Path renamed = Path.of(path).resolveSibling("historical-title-final.cbz");
            Files.move(Path.of(path), renamed);
            path = renamed.toString();
        }
        LibraryChapter stale = new LibraryChapter(two.id(), two.label(), "2", staleCount ? 9 : 0, "", staleCount,
            staleCount ? path : "", two.sourceUrl(), "partial", 9, 1, List.of(9), List.of("Prior source quality evidence."), null);
        context.broker().putLibraryChapters(title.id(), Map.of("chapters", List.of(one, stale)));
        Map<Path, Fingerprint> untouched = fingerprints(context.library().findTitle(title.id()), true);
        // Missing catalog paths are absent from the snapshot, so record the promoted archive explicitly.
        untouched.put(Path.of(path), fingerprint(Path.of(path)));
        seedTask(context, title, List.of(chapter(1), chapter(2)), "offline-fixture", "running", "", false);
        start(context);
        assertCompleted(awaitTask());
        LibraryChapter repaired = context.library().findTitle(title.id()).chapters().stream().filter(c -> c.chapterNumber().equals("2")).findFirst().orElseThrow();
        assertEquals(two.id(), repaired.id());
        assertEquals(1, repaired.pageCount());
        assertTrue(repaired.available());
        assertEquals(path, repaired.archivePath());
        assertEquals(List.of("Prior source quality evidence."), repaired.qualityNotes());
        assertEquals(List.of(9), repaired.missingPages());
        assertFingerprints(untouched);
        verifyNoProvider(context.provider());
    }

    private void partialResume(boolean sourceDisappeared) throws Exception {
        Context context = context();
        LibraryTitle title = seed(context, 2, 1);
        Map<Path, Fingerprint> untouched = fingerprints(title, true);
        byte[] image = image();
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/page.png", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "image/png");
            exchange.sendResponseHeaders(200, image.length);
            exchange.getResponseBody().write(image);
            exchange.close();
        });
        server.start();
        List<Map<String, String>> expected = List.of(chapter(1), chapter(2), chapter(3));
        when(context.provider().getChapters(anyString())).thenReturn(sourceDisappeared ? List.of(chapter(3)) : expected);
        when(context.provider().getTitleDetails(anyString())).thenReturn(new TitleDetails("", "Manhua", List.of(), "ongoing", "", false, null, null, List.of(), List.of()));
        when(context.provider().resolvePages(chapter(3).get("href"))).thenReturn(List.of("http://127.0.0.1:" + server.getAddress().getPort() + "/page.png"));
        seedTask(context, title, expected, "weebcentral", "running", "", false);
        start(context);
        assertCompleted(awaitTask());
        LibraryTitle finished = context.library().findTitle(title.id());
        assertEquals(List.of("1", "2", "3"), finished.chapters().stream().map(LibraryChapter::chapterNumber).sorted().toList());
        assertTrue(new DownloadCompletionVerifier(context.library()).complete(finished, expected));
        LibraryChapter oldReady = title.chapters().stream().filter(c -> c.chapterNumber().equals("1")).findFirst().orElseThrow();
        LibraryChapter preserved = finished.chapters().stream().filter(c -> c.chapterNumber().equals("1")).findFirst().orElseThrow();
        assertEquals(oldReady.ingestRevision(), preserved.ingestRevision());
        assertEquals(oldReady.ingestManifestPath(), preserved.ingestManifestPath());
        assertEquals(oldReady.ingestedAt(), preserved.ingestedAt());
        assertFingerprints(untouched);
        verify(context.provider(), never()).resolvePages(chapter(1).get("href"));
        verify(context.provider(), never()).resolvePages(chapter(2).get("href"));
        verify(context.provider()).resolvePages(chapter(3).get("href"));
    }

    private Context context() {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(root);
        broker.setSetting("raven.download.providers", Map.of("providers", List.of(Map.of("id", "weebcentral", "enabled", true, "priority", 1))));
        RavenSettingsService settings = new RavenSettingsService(broker, logger, List.of());
        DownloadProvider provider = mock(DownloadProvider.class);
        when(provider.id()).thenReturn("weebcentral");
        when(provider.name()).thenReturn("WeebCentral");
        when(provider.supportsUrl(anyString())).thenReturn(true);
        return new Context(broker, settings, new LibraryService(broker, settings, logger), provider, logger);
    }

    private LibraryTitle seed(Context context, int count, int ready) throws Exception {
        Path canonical = canonicalRoot();
        List<LibraryChapter> chapters = new ArrayList<>();
        for (int number = 1; number <= count; number++) {
            Path archive = archive(context, canonical, number);
            chapters.add(new LibraryChapter("", "Chapter " + number, String.valueOf(number), 1, "", true, archive.toString(), chapter(number).get("href"), null));
        }
        LibraryTitle title = context.library().recordDownloadedTitle("Recovery Series", "Manhua", "https://example.invalid/series/recovery", "", null, chapters.subList(0, ready), null, canonical);
        if (ready > 0) title = context.library().ingestTitle(title.id(), "qa");
        if (ready < count) {
            List<LibraryChapter> all = new ArrayList<>(title.chapters());
            all.addAll(chapters.subList(ready, count));
            title = context.library().recordDownloadedTitle("Recovery Series", "Manhua", "https://example.invalid/series/recovery", "", null, all, null, canonical);
        }
        return title;
    }

    private Path canonicalRoot() { return root.resolve("downloaded/manhua/Recovery_Series"); }

    private Path archive(Context context, Path canonical, int number) throws Exception {
        Files.createDirectories(canonical);
        Path archive = canonical.resolve(LibraryNaming.buildChapterArchiveName(context.settings().getNamingSettings(), "Recovery Series", "Manhua", String.valueOf(number), "", 1, "example.invalid"));
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archive))) {
            zip.putNextEntry(new ZipEntry("page.png"));
            zip.write(image());
            zip.closeEntry();
        }
        Files.setLastModifiedTime(archive, FileTime.from(Instant.parse("2026-01-01T00:00:00Z")));
        return archive;
    }

    private byte[] image() throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(2, 2, BufferedImage.TYPE_INT_RGB), "png", bytes);
        return bytes.toByteArray();
    }

    private void seedTask(Context context, LibraryTitle title, List<Map<String, String>> expected, String provider, String status, String message, boolean replacement) {
        seedTask(context, title, expected, provider, status, message, replacement, "");
    }

    /** Seed a recoverable durable task whose cover exists only in its frozen source request. */
    private void seedTask(Context context, LibraryTitle title, List<Map<String, String>> expected, String provider, String status, String message, boolean replacement, String coverUrl) {
        Map<String, Object> selected = new LinkedHashMap<>();
        if (!coverUrl.isBlank()) selected.put("coverUrl", coverUrl);
        selected.put("expectedChapters", expected);
        selected.put("chapterNumbers", expected.stream().map(row -> row.get("chapter_number")).toList());
        if (!replacement) {selected.put("downloadMode", "append"); if (title != null) selected.put("appendTitleId", title.id());}
        Map<String, Object> task = new LinkedHashMap<>();
        task.put("taskId", "restore-task"); task.put("jobId", "restore-task");
        task.put("titleName", "Recovery Series"); task.put("titleId", title == null ? "" : title.id());
        task.put("titleUrl", "https://example.invalid/series/recovery"); task.put("requestType", "Manhua");
        task.put("requestedBy", "qa"); task.put("providerId", provider); task.put("status", status); task.put("percent", 98);
        task.put("message", message); task.put("downloadRoot", canonicalRoot().toString());
        if (replacement) task.put("replacementTitleId", title.id());
        task.put("details", Map.of("selectedDownload", selected, "bulkRunId", "run", "bulkBatchId", "batch", "bulkPlanId", "plan"));
        context.broker().putDownloadTask("restore-task", task);
    }

    private void start(Context context) {
        downloader = new DownloaderService(new DownloadProviderRegistry(List.of(context.provider()), context.settings()), null, context.library(), mock(DownloadIntakeService.class), mock(MetadataService.class), context.broker(), context.settings(), context.logger());
        downloader.restorePersistedTasks();
    }

    private Map<String, Object> awaitTask() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        Map<String, Object> task = Map.of();
        while (System.nanoTime() < deadline) {
            task = downloader.snapshot().stream().filter(t -> "restore-task".equals(t.get("taskId"))).findFirst().orElse(Map.of());
            if (List.of("completed", "failed", "cancelled").contains(task.get("status"))) return task;
            Thread.sleep(20);
        }
        fail("Restored task did not terminate: " + task);
        return task;
    }

    private Map<Path, Fingerprint> fingerprints(LibraryTitle title, boolean readyFiles) throws Exception {
        Map<Path, Fingerprint> values = new LinkedHashMap<>();
        for (LibraryChapter chapter : title.chapters()) {
            if (chapter.archivePath() != null && !chapter.archivePath().isBlank()) {
                Path archive = Path.of(chapter.archivePath()); values.put(archive, fingerprint(archive));
            }
            if (readyFiles && "ready".equals(chapter.ingestStatus())) {
                Path manifest = Path.of(chapter.ingestManifestPath());
                try (var files = Files.list(manifest.getParent())) {
                    for (Path file : files.filter(Files::isRegularFile).toList()) values.put(file, fingerprint(file));
                }
            }
        }
        return values;
    }

    private Fingerprint fingerprint(Path path) throws Exception {
        return new Fingerprint(java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(path))), Files.getLastModifiedTime(path));
    }

    private void assertFingerprints(Map<Path, Fingerprint> values) throws Exception {
        for (var entry : values.entrySet()) assertEquals(entry.getValue(), fingerprint(entry.getKey()), entry.getKey().toString());
    }

    private static Map<String, String> chapter(int number) {
        return Map.of("chapter_number", String.valueOf(number), "chapter_title", "Chapter " + number, "href", "https://example.invalid/chapters/" + number);
    }

    private static void assertCompleted(Map<String, Object> task) { assertEquals("completed", task.get("status"), task.toString()); assertEquals(100, task.get("percent")); }

    private static void verifyNoProvider(DownloadProvider provider) throws Exception {
        verify(provider, never()).getChapters(anyString()); verify(provider, never()).getTitleDetails(anyString()); verify(provider, never()).resolvePages(anyString());
    }

    private record Context(FakeRavenBrokerClient broker, RavenSettingsService settings, LibraryService library, DownloadProvider provider, ScriptarrLogger logger) { }
    private record Fingerprint(String sha256, FileTime modified) { }
}
