package com.scriptarr.raven.library;

import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Unit coverage for Raven's durable library AVIF rebuild runs.
 */
class LibraryIngestRunServiceTest {
    /**
     * Verify a library ingest run rebuilds only the requested type and creates
     * one durable job task per matching title.
     *
     * @param tempDir temporary Raven data root
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void createRunRebuildsOnlyRequestedLibraryType(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        TestLogger logger = new TestLogger(tempDir);
        LibraryService libraryService = libraryService(brokerClient, logger, new TestTranscoder());
        LibraryTitle manga = recordTitle(libraryService, tempDir, "Blue Box", "Manga", "001.png");
        LibraryTitle manhwa = recordTitle(libraryService, tempDir, "Solo Leveling", "Manhwa", "001.png");
        LibraryIngestRunService runService = new LibraryIngestRunService(libraryService, brokerClient, logger);
        int fullCatalogCallsBeforeRun = brokerClient.listLibraryTitlesCalls();
        int cardCallsBeforeRun = brokerClient.listLibraryTitleCardsCalls();

        Map<String, Object> created = runService.createRun(Map.of(
            "libraryTypeSlug", "manga",
            "requestedBy", "owner-1"
        ));
        Map<String, Object> status = awaitStatus(runService, String.valueOf(created.get("runId")), "completed");

        assertEquals("completed", status.get("status"));
        assertEquals(1, maps(status.get("tasks")).size());
        assertEquals(manga.id(), map(maps(status.get("tasks")).getFirst().get("payload")).get("titleId"));
        assertEquals(1, map(status.get("result")).get("totalTitles"));
        assertEquals(1, map(status.get("result")).get("completedTitles"));
        assertEquals(0, map(status.get("result")).get("failedTitles"));
        assertEquals("ready", libraryService.findTitleById(manga.id()).ingestStatus());
        assertTrue(Files.exists(Path.of(libraryService.findTitleById(manga.id()).chapters().getFirst().ingestManifestPath())));
        assertEquals("pending", libraryService.findTitleById(manhwa.id()).ingestStatus());
        assertEquals(fullCatalogCallsBeforeRun, brokerClient.listLibraryTitlesCalls());
        assertTrue(brokerClient.listLibraryTitleCardsCalls() > cardCallsBeforeRun);
        runService.shutdown();
    }

    /**
     * Verify the durable run fails overall when any title fails, but later
     * titles still continue and publish their AVIF output.
     *
     * @param tempDir temporary Raven data root
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void runContinuesThroughPerTitleFailureAndCountsFailures(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        TestLogger logger = new TestLogger(tempDir);
        LibraryService libraryService = libraryService(brokerClient, logger, new TestTranscoder());
        LibraryTitle badTitle = recordTitle(libraryService, tempDir, "Broken Title", "Manga", "notes.txt");
        LibraryTitle goodTitle = recordTitle(libraryService, tempDir, "Good Title", "Manga", "001.png");
        LibraryIngestRunService runService = new LibraryIngestRunService(libraryService, brokerClient, logger);

        Map<String, Object> created = runService.createRun(Map.of(
            "type", "manga",
            "requestedBy", "owner-1"
        ));
        Map<String, Object> status = awaitStatus(runService, String.valueOf(created.get("runId")), "failed");

        assertEquals("failed", status.get("status"));
        assertEquals(2, map(status.get("result")).get("totalTitles"));
        assertEquals(1, map(status.get("result")).get("completedTitles"));
        assertEquals(1, map(status.get("result")).get("failedTitles"));
        assertEquals(List.of(badTitle.id()), map(status.get("result")).get("failedTitleIds"));
        assertEquals("failed", libraryService.findTitleById(badTitle.id()).ingestStatus());
        assertEquals("ready", libraryService.findTitleById(goodTitle.id()).ingestStatus());
        assertTrue(statuses(status).containsAll(List.of("completed", "failed")));
        runService.shutdown();
    }

    /**
     * Verify Raven rejects a second queued or running rebuild for the same
     * library type.
     *
     * @param tempDir temporary Raven data root
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void createRunReusesSecondActiveRunForSameType(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        TestLogger logger = new TestLogger(tempDir);
        BlockingTranscoder transcoder = new BlockingTranscoder();
        LibraryService libraryService = libraryService(brokerClient, logger, transcoder);
        recordTitle(libraryService, tempDir, "Waiting Title", "Webtoon", "001.png");
        LibraryIngestRunService runService = new LibraryIngestRunService(libraryService, brokerClient, logger);

        Map<String, Object> created = runService.createRun(Map.of("libraryTypeSlug", "webtoon"));
        assertTrue(transcoder.started.await(2, TimeUnit.SECONDS));

        Map<String, Object> reused = runService.createRun(Map.of("libraryTypeSlug", "webtoon"));

        assertEquals(created.get("runId"), reused.get("runId"));
        assertEquals(true, reused.get("reused"));
        transcoder.release.countDown();
        assertEquals("completed", awaitStatus(runService, String.valueOf(created.get("runId")), "completed").get("status"));
        runService.shutdown();
    }

    /**
     * Verify a second library type waits behind the single fair scheduler lane
     * instead of being reported as another true running worker.
     *
     * @param tempDir temporary Raven data root
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void fairSchedulerKeepsOtherTypesWaitingWhileOneTitleRuns(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        TestLogger logger = new TestLogger(tempDir);
        BlockingTranscoder transcoder = new BlockingTranscoder();
        LibraryService libraryService = libraryService(brokerClient, logger, transcoder);
        recordTitle(libraryService, tempDir, "Blocked Manga", "Manga", "001.png");
        recordTitle(libraryService, tempDir, "Waiting OEL", "OEL", "001.png");
        LibraryIngestRunService runService = new LibraryIngestRunService(libraryService, brokerClient, logger);

        Map<String, Object> manga = runService.createRun(Map.of("libraryTypeSlug", "manga"));
        assertTrue(transcoder.started.await(2, TimeUnit.SECONDS));
        Map<String, Object> oel = runService.createRun(Map.of("libraryTypeSlug", "oel"));
        Map<String, Object> oelStatus = runService.status(String.valueOf(oel.get("runId")));

        assertEquals("queued", oelStatus.get("status"));
        assertEquals("waiting", map(oelStatus.get("runtime")).get("schedulerState"));
        assertEquals("running", map(runService.status(String.valueOf(manga.get("runId"))).get("runtime")).get("schedulerState"));
        assertTrue((Integer) map(oelStatus.get("runtime")).get("queuedPosition") > 0);

        transcoder.release.countDown();
        assertEquals("completed", awaitStatus(runService, String.valueOf(manga.get("runId")), "completed").get("status"));
        assertEquals("completed", awaitStatus(runService, String.valueOf(oel.get("runId")), "completed").get("status"));
        runService.shutdown();
    }

    /**
     * Verify cancelling a waiting run keeps it from consuming the AVIF lane.
     *
     * @param tempDir temporary Raven data root
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void cancelWaitingRunMarksTasksCancelledWithoutTranscoding(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        TestLogger logger = new TestLogger(tempDir);
        BlockingTranscoder transcoder = new BlockingTranscoder();
        LibraryService libraryService = libraryService(brokerClient, logger, transcoder);
        recordTitle(libraryService, tempDir, "Blocked Manga", "Manga", "001.png");
        LibraryTitle waitingTitle = recordTitle(libraryService, tempDir, "Waiting OEL", "OEL", "001.png");
        LibraryIngestRunService runService = new LibraryIngestRunService(libraryService, brokerClient, logger);

        Map<String, Object> manga = runService.createRun(Map.of("libraryTypeSlug", "manga"));
        assertTrue(transcoder.started.await(2, TimeUnit.SECONDS));
        Map<String, Object> oel = runService.createRun(Map.of("libraryTypeSlug", "oel"));
        Map<String, Object> cancelled = runService.cancelRun(String.valueOf(oel.get("runId")));

        assertEquals("cancelled", cancelled.get("status"));
        assertEquals(List.of("cancelled"), statuses(cancelled));
        transcoder.release.countDown();
        assertEquals("completed", awaitStatus(runService, String.valueOf(manga.get("runId")), "completed").get("status"));
        assertEquals("pending", libraryService.findTitleById(waitingTitle.id()).ingestStatus());
        runService.shutdown();
    }

    /**
     * Verify durable run summaries stay small and separate active runs from
     * recent terminal runs.
     *
     * @param tempDir temporary Raven data root
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void runSummariesExposeBoundedActiveAndRecentRowsWithoutTasks(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        TestLogger logger = new TestLogger(tempDir);
        BlockingTranscoder transcoder = new BlockingTranscoder();
        LibraryService libraryService = libraryService(brokerClient, logger, transcoder);
        recordTitle(libraryService, tempDir, "Waiting Title", "Manga", "001.png");
        seedIngestRunJob(brokerClient, "ingestrun_recent_failed", "failed", "manhwa", 3, 2, 1);
        seedIngestRunJob(brokerClient, "ingestrun_recent_done", "completed", "oel", 2, 2, 0);
        LibraryIngestRunService runService = new LibraryIngestRunService(libraryService, brokerClient, logger);

        Map<String, Object> created = runService.createRun(Map.of("libraryTypeSlug", "manga"));
        assertTrue(transcoder.started.await(2, TimeUnit.SECONDS));

        List<Map<String, Object>> active = runService.listRunSummaries("active");
        Map<String, Object> activeRun = active.stream()
            .filter((run) -> created.get("runId").equals(run.get("runId")))
            .findFirst()
            .orElseThrow();
        assertEquals("running", activeRun.get("status"));
        assertEquals(true, activeRun.get("active"));
        assertEquals("manga", activeRun.get("libraryTypeSlug"));
        assertEquals("avif", activeRun.get("format"));
        assertEquals(1, map(activeRun.get("counts")).get("totalTitles"));
        assertFalse(activeRun.containsKey("tasks"));
        assertFalse(activeRun.containsKey("completedTitleIds"));
        assertFalse(activeRun.containsKey("failedTitleIds"));

        List<Map<String, Object>> recent = runService.listRunSummaries("recent");
        List<String> recentRunIds = recent.stream().map((run) -> String.valueOf(run.get("runId"))).toList();
        assertTrue(recentRunIds.containsAll(List.of("ingestrun_recent_done", "ingestrun_recent_failed")));
        assertTrue(recent.stream().noneMatch((run) -> run.containsKey("tasks")));

        transcoder.release.countDown();
        assertEquals("completed", awaitStatus(runService, String.valueOf(created.get("runId")), "completed").get("status"));
        runService.shutdown();
    }

    /**
     * Verify admin summary reads degrade to cached recovered run rows instead
     * of returning HTTP 500 when the broker has a transient job-list failure.
     *
     * @param tempDir temporary Raven data root
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void runSummariesUseCachedRunsWhenBrokerListFails(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        TestLogger logger = new TestLogger(tempDir);
        LibraryService libraryService = libraryService(brokerClient, logger, new TestTranscoder());
        seedIngestRunJob(brokerClient, "ingestrun_cached_active", "running", "oel", 84, 12, 1);
        LibraryIngestRunService runService = new LibraryIngestRunService(libraryService, brokerClient, logger);

        assertEquals(1, runService.listRunSummaries("active").size());
        brokerClient.failNextJobList();

        List<Map<String, Object>> fallback = runService.listRunSummaries("active");

        assertEquals(1, fallback.size());
        assertEquals("ingestrun_cached_active", fallback.getFirst().get("runId"));
        assertFalse(fallback.getFirst().containsKey("tasks"));
        runService.shutdown();
    }

    /**
     * Verify old WebP-format type runs are superseded before Raven accepts a
     * new AVIF run for the same library type.
     *
     * @param tempDir temporary Raven data root
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void createRunSupersedesLegacyWebpRunForSameType(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        TestLogger logger = new TestLogger(tempDir);
        LibraryService libraryService = libraryService(brokerClient, logger, new TestTranscoder());
        LibraryTitle title = recordTitle(libraryService, tempDir, "Legacy Waiting Title", "OEL", "001.png");
        String legacyRunId = "ingestrun_legacy_webp";
        seedLegacyWebpRunJob(brokerClient, legacyRunId, "running", "oel");
        seedIngestRunTask(brokerClient, legacyRunId, title, "queued", 0);
        LibraryIngestRunService runService = new LibraryIngestRunService(libraryService, brokerClient, logger);

        Map<String, Object> created = runService.createRun(Map.of("libraryTypeSlug", "oel"));
        Map<String, Object> completed = awaitStatus(runService, String.valueOf(created.get("runId")), "completed");
        Map<String, Object> legacy = runService.status(legacyRunId);

        assertEquals("completed", completed.get("status"));
        assertEquals("superseded", legacy.get("status"));
        assertEquals(List.of("superseded"), statuses(legacy));
        assertEquals("avif", map(completed.get("filters")).get("format"));
        assertEquals("avif-force-rebuild", map(completed.get("filters")).get("mode"));
        runService.shutdown();
    }

    /**
     * Verify a detached durable type run is resumed when Appa/Sage asks to
     * start the same type again, while failed title tasks stay failed.
     *
     * @param tempDir temporary Raven data root
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void duplicateRunRequestResumesDetachedRunAndSkipsFailedTasks(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        TestLogger logger = new TestLogger(tempDir);
        LibraryService libraryService = libraryService(brokerClient, logger, new TestTranscoder());
        LibraryTitle failedTitle = recordTitle(libraryService, tempDir, "Broken Title", "Manga", "notes.txt");
        LibraryTitle queuedTitle = recordTitle(libraryService, tempDir, "Good Title", "Manga", "001.png");
        String runId = "ingestrun_recover_same_type";
        seedIngestRunJob(brokerClient, runId, "running", "manga", 2, 0, 1);
        seedIngestRunTask(brokerClient, runId, failedTitle, "failed", 0);
        seedIngestRunTask(brokerClient, runId, queuedTitle, "queued", 1);
        LibraryIngestRunService runService = new LibraryIngestRunService(libraryService, brokerClient, logger);

        Map<String, Object> reused = runService.createRun(Map.of("type", "manga"));
        Map<String, Object> status = awaitStatus(runService, runId, "failed");

        assertEquals(runId, reused.get("runId"));
        assertEquals(true, reused.get("reused"));
        assertEquals(2, map(status.get("result")).get("totalTitles"));
        assertEquals(1, map(status.get("result")).get("completedTitles"));
        assertEquals(1, map(status.get("result")).get("failedTitles"));
        assertEquals(List.of(failedTitle.id()), map(status.get("result")).get("failedTitleIds"));
        assertEquals("ready", libraryService.findTitleById(queuedTitle.id()).ingestStatus());
        assertTrue(statuses(status).containsAll(List.of("completed", "failed")));
        runService.shutdown();
    }

    /**
     * Verify Raven startup recovery reattaches a queued type ingest run.
     *
     * @param tempDir temporary Raven data root
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void startupRecoveryReschedulesDetachedQueuedRun(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        TestLogger logger = new TestLogger(tempDir);
        LibraryService libraryService = libraryService(brokerClient, logger, new TestTranscoder());
        LibraryTitle queuedTitle = recordTitle(libraryService, tempDir, "Good Title", "Manhwa", "001.png");
        String runId = "ingestrun_startup_recover";
        seedIngestRunJob(brokerClient, runId, "queued", "manhwa", 1, 0, 0);
        seedIngestRunTask(brokerClient, runId, queuedTitle, "queued", 0);
        LibraryIngestRunService runService = new LibraryIngestRunService(libraryService, brokerClient, logger);

        runService.resumeInterruptedRuns();
        Map<String, Object> status = awaitStatus(runService, runId, "completed");

        assertEquals(1, map(status.get("result")).get("completedTitles"));
        assertEquals("ready", libraryService.findTitleById(queuedTitle.id()).ingestStatus());
        runService.shutdown();
    }

    /**
     * Verify a detached running run with no remaining work is finalized so it
     * does not block future runs for that library type.
     *
     * @param tempDir temporary Raven data root
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void duplicateRunRequestFinalizesAllTerminalDetachedRun(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        TestLogger logger = new TestLogger(tempDir);
        LibraryService libraryService = libraryService(brokerClient, logger, new TestTranscoder());
        LibraryTitle failedTitle = recordTitle(libraryService, tempDir, "Broken Title", "Comic", "notes.txt");
        LibraryTitle completedTitle = recordTitle(libraryService, tempDir, "Good Title", "Comic", "001.png");
        String runId = "ingestrun_terminal_recover";
        seedIngestRunJob(brokerClient, runId, "running", "comic", 2, 1, 1);
        seedIngestRunTask(brokerClient, runId, failedTitle, "failed", 0);
        seedIngestRunTask(brokerClient, runId, completedTitle, "completed", 1);
        LibraryIngestRunService runService = new LibraryIngestRunService(libraryService, brokerClient, logger);

        Map<String, Object> reused = runService.createRun(Map.of("type", "comic"));
        Map<String, Object> status = runService.status(runId);

        assertEquals(runId, reused.get("runId"));
        assertEquals("failed", status.get("status"));
        assertEquals(false, status.get("active"));
        assertEquals(1, map(status.get("result")).get("completedTitles"));
        assertEquals(1, map(status.get("result")).get("failedTitles"));
        runService.shutdown();
    }

    private static LibraryService libraryService(
        FakeRavenBrokerClient brokerClient,
        ScriptarrLogger logger,
        PageTranscoder transcoder
    ) {
        RavenSettingsService settingsService = new RavenSettingsService(brokerClient, logger, List.of());
        return new LibraryService(
            brokerClient,
            settingsService,
            logger,
            new LibraryIngestService(settingsService, logger, transcoder)
        );
    }

    private static LibraryTitle recordTitle(
        LibraryService libraryService,
        Path tempDir,
        String titleName,
        String type,
        String archiveEntry
    ) throws IOException {
        String typeSlug = LibraryNaming.normalizeTypeSlug(type);
        Path titleRoot = tempDir.resolve("downloaded").resolve(typeSlug).resolve(LibraryNaming.sanitizeTitleFolder(titleName));
        Path archive = writeArchive(
            titleRoot.resolve(titleName + " c001.cbz"),
            archiveEntry,
            archiveEntry.endsWith(".png") ? pngPage(20) : "not an image".getBytes(java.nio.charset.StandardCharsets.UTF_8)
        );
        return libraryService.recordDownloadedTitle(
            titleName,
            type,
            "",
            "",
            null,
            List.of(new LibraryChapter("", "Chapter 1", "1", 1, null, true, archive.toString(), "", null)),
            titleRoot,
            titleRoot
        );
    }

    private static Map<String, Object> awaitStatus(
        LibraryIngestRunService runService,
        String runId,
        String expectedStatus
    ) throws InterruptedException {
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        Map<String, Object> status = runService.status(runId);
        while (!expectedStatus.equals(status.get("status")) && System.nanoTime() < deadline) {
            TimeUnit.MILLISECONDS.sleep(25);
            status = runService.status(runId);
        }
        return status;
    }

    private static Path writeArchive(Path archivePath, String entryName, byte[] bytes) throws IOException {
        Files.createDirectories(archivePath.getParent());
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archivePath))) {
            zip.putNextEntry(new ZipEntry(entryName));
            zip.write(bytes);
            zip.closeEntry();
        }
        return archivePath;
    }

    private static void seedIngestRunJob(
        FakeRavenBrokerClient brokerClient,
        String runId,
        String status,
        String typeSlug,
        int totalTitles,
        int completedTitles,
        int failedTitles
    ) {
        String now = Instant.now().toString();
        Map<String, Object> job = new LinkedHashMap<>();
        job.put("jobId", runId);
        job.put("kind", "raven-library-ingest");
        job.put("ownerService", "scriptarr-raven");
        job.put("status", status);
        job.put("label", "Raven AVIF rebuild");
        job.put("requestedBy", "owner-1");
        job.put(
            "payload",
            Map.of(
                "libraryTypeSlug", typeSlug,
                "libraryTypeLabel", LibraryNaming.normalizeTypeLabel(typeSlug),
                "mode", "avif-force-rebuild",
                "format", "avif",
                "titleCount", totalTitles
            )
        );
        job.put(
            "result",
            Map.of(
                "totalTitles", totalTitles,
                "completedTitles", completedTitles,
                "failedTitles", failedTitles,
                "remainingTitles", Math.max(0, totalTitles - completedTitles - failedTitles),
                "completedTitleIds", List.of(),
                "failedTitleIds", List.of()
            )
        );
        job.put("createdAt", now);
        job.put("startedAt", now);
        job.put("updatedAt", now);
        brokerClient.putJob(runId, job);
    }

    private static void seedLegacyWebpRunJob(
        FakeRavenBrokerClient brokerClient,
        String runId,
        String status,
        String typeSlug
    ) {
        String now = Instant.now().toString();
        Map<String, Object> job = new LinkedHashMap<>();
        job.put("jobId", runId);
        job.put("kind", "raven-library-ingest");
        job.put("ownerService", "scriptarr-raven");
        job.put("status", status);
        job.put("label", "Raven WebP rebuild");
        job.put("message", "Queued WebP rebuild from existing canonical CBZ archives.");
        job.put("requestedBy", "owner-1");
        job.put(
            "payload",
            Map.of(
                "libraryTypeSlug", typeSlug,
                "libraryTypeLabel", LibraryNaming.normalizeTypeLabel(typeSlug),
                "mode", "webp-force-rebuild",
                "titleCount", 1
            )
        );
        job.put("result", Map.of("totalTitles", 1, "completedTitles", 0, "failedTitles", 0, "remainingTitles", 1));
        job.put("createdAt", now);
        job.put("startedAt", now);
        job.put("updatedAt", now);
        brokerClient.putJob(runId, job);
    }

    private static void seedIngestRunTask(
        FakeRavenBrokerClient brokerClient,
        String runId,
        LibraryTitle title,
        String status,
        int sortOrder
    ) {
        String now = Instant.now().toString();
        String taskId = runId + "_title_" + LibraryNaming.slugifySegment(title.id());
        Map<String, Object> task = new LinkedHashMap<>();
        task.put("taskId", taskId);
        task.put("jobId", runId);
        task.put("taskKey", title.id());
        task.put("status", status);
        task.put("label", title.title());
        task.put("message", status.equals("queued") ? "Queued title AVIF rebuild." : "Seeded terminal task.");
        task.put("requestedBy", "owner-1");
        task.put("sortOrder", sortOrder);
        task.put("percent", status.equals("queued") ? 0 : 100);
        task.put(
            "payload",
            Map.of(
                "runId", runId,
                "titleId", title.id(),
                "titleName", title.title(),
                "libraryTypeSlug", title.libraryTypeSlug(),
                "libraryTypeLabel", title.libraryTypeLabel(),
                "downloadRoot", title.downloadRoot(),
                "mode", "avif-force-rebuild",
                "format", "avif"
            )
        );
        task.put("result", status.equals("failed") ? Map.of("titleId", title.id(), "error", "seeded failure") : Map.of("titleId", title.id()));
        task.put("createdAt", now);
        task.put("updatedAt", now);
        brokerClient.putJobTask(runId, taskId, task);
    }

    private static byte[] pngPage(int shade) throws IOException {
        BufferedImage image = new BufferedImage(1, 1, BufferedImage.TYPE_INT_RGB);
        int value = Math.max(0, Math.min(255, shade));
        image.setRGB(0, 0, (value << 16) | (value << 8) | value);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return output.toByteArray();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return value instanceof Map<?, ?> ? (Map<String, Object>) value : Map.of();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> maps(Object value) {
        return value instanceof List<?> ? (List<Map<String, Object>>) value : List.of();
    }

    private static List<String> statuses(Map<String, Object> status) {
        return maps(status.get("tasks")).stream()
            .map((task) -> String.valueOf(task.get("status")))
            .toList();
    }

    private static final class TestLogger extends ScriptarrLogger {
        private final Path downloadsRoot;

        private TestLogger(Path downloadsRoot) {
            this.downloadsRoot = downloadsRoot;
        }

        @Override
        public Path getDownloadsRoot() {
            return downloadsRoot;
        }

        @Override
        public Path getLogsRoot() {
            return downloadsRoot.resolve("logs");
        }

        @Override
        public void warn(String tag, String message, String detail) {
        }

        @Override
        public void error(String tag, String message, Throwable error) {
        }
    }

    private static class TestTranscoder implements PageTranscoder {
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
            return "test/passthrough-avif";
        }

        @Override
        public Readiness readiness() {
            return Readiness.ok();
        }

        @Override
        public void transcode(byte[] inputBytes, String sourceMediaType, Path outputPath, int quality)
            throws IOException, InterruptedException {
            Files.createDirectories(outputPath.getParent());
            Files.write(outputPath, inputBytes == null ? new byte[0] : inputBytes);
        }
    }

    private static final class BlockingTranscoder extends TestTranscoder {
        private final CountDownLatch started = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);

        @Override
        public void transcode(byte[] inputBytes, String sourceMediaType, Path outputPath, int quality)
            throws IOException, InterruptedException {
            started.countDown();
            release.await(5, TimeUnit.SECONDS);
            super.transcode(inputBytes, sourceMediaType, outputPath, quality);
        }
    }
}
