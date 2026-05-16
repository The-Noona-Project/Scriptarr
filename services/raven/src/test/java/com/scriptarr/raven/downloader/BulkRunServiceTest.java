package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Unit coverage for Raven's durable mega downloadall run orchestration.
 */
class BulkRunServiceTest {
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    /**
     * Verify all/all mega runs persist batches in group-first then type order.
     */
    @Test
    void createRunPersistsGroupFirstTypeOrder() {
        BulkRunService service = new BulkRunService(
            new NoopDownloaderService(),
            new FakeRavenBrokerClient(),
            new TestLogger()
        );

        Map<String, Object> status = service.createRun(Map.of(
            "type", "all",
            "titlegroup", "all",
            "requestedBy", "owner-1",
            "start", false
        ));

        List<Map<String, Object>> batches = maps(status.get("batches"));
        assertEquals(104, batches.size());
        assertBatch(batches.get(0), "A", "Manga", 0);
        assertBatch(batches.get(1), "A", "Manhwa", 1);
        assertBatch(batches.get(2), "A", "Manhua", 2);
        assertBatch(batches.get(3), "A", "OEL", 3);
        assertBatch(batches.get(4), "B", "Manga", 4);
        assertEquals(104, map(status.get("summary")).get("queuedBatches"));
    }

    /**
     * Verify a durable run records run-owned title task ids and completes once
     * those title tasks finish.
     *
     * @throws Exception when the async run does not settle in time
     */
    @Test
    void startRunWaitsForOwnedTaskIdsAndPausesBeforeNextBatch() throws Exception {
        CompletingDownloaderService downloaderService = new CompletingDownloaderService();
        BulkRunService service = new BulkRunService(
            downloaderService,
            new FakeRavenBrokerClient(),
            new TestLogger()
        );

        Map<String, Object> created = service.createRun(Map.of(
            "type", "all",
            "titlegroup", "A",
            "requestedBy", "owner-1"
        ));
        Map<String, Object> status = awaitStatus(service, String.valueOf(created.get("runId")), "paused");

        assertEquals("paused", status.get("status"));
        assertEquals(List.of("task_1"), map(status.get("summary")).get("queuedTaskIds"));
        assertEquals(1, map(status.get("summary")).get("completedTitleTaskCount"));
        assertEquals(1, map(status.get("summary")).get("completedBatches"));
        assertEquals(3, map(status.get("summary")).get("remainingBatches"));
        assertEquals("Manhwa", map(status.get("currentBatch")).get("type"));
    }

    /**
     * Verify failed run-owned title tasks are retried before a batch completes.
     *
     * @throws Exception when the async run does not settle in time
     */
    @Test
    void failedOwnedTaskRetriesBeforeCompletion() throws Exception {
        RetryThenCompleteDownloaderService downloaderService = new RetryThenCompleteDownloaderService();
        BulkRunService service = new BulkRunService(
            downloaderService,
            new FakeRavenBrokerClient(),
            new TestLogger()
        );

        Map<String, Object> created = service.createRun(Map.of(
            "type", "manga",
            "titlegroup", "A",
            "requestedBy", "owner-1"
        ));
        Map<String, Object> status = awaitStatus(service, String.valueOf(created.get("runId")), "completed");

        assertEquals("completed", status.get("status"));
        assertEquals(1, downloaderService.retryCount.get());
        Map<String, Object> batchResult = map(maps(status.get("batches")).getFirst().get("result"));
        assertEquals(2, ((Number) map(batchResult.get("attempts")).get("task_1")).intValue());
        assertEquals(List.of("task_1"), batchResult.get("completedTaskIds"));
    }

    /**
     * Verify transient broker failures pause the run instead of leaving a
     * detached worker with a durable running status.
     *
     * @throws Exception when the async run does not settle in time
     */
    @Test
    void brokerFailurePausesRunWhenFailureSummaryCannotLoad() throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        BulkRunService service = new BulkRunService(
            new CompletingDownloaderService(),
            brokerClient,
            new TestLogger()
        );

        Map<String, Object> created = service.createRun(Map.of(
            "type", "manga",
            "titlegroup", "A",
            "requestedBy", "owner-1",
            "start", false
        ));
        brokerClient.failNextJobTaskWriteAndFollowingList();

        service.startRun(String.valueOf(created.get("runId")));
        Map<String, Object> status = awaitStatus(service, String.valueOf(created.get("runId")), "paused");

        assertEquals("paused", status.get("status"));
        assertEquals(false, status.get("active"));
        assertTrue(String.valueOf(status.get("message")).contains("Raven could not persist a durable bulk-run batch."));
    }

    /**
     * Verify a stale title task that remains running after cancellation pauses
     * the bulk run with a precise admin recovery action instead of looping.
     *
     * @throws Exception when the async run does not settle in time
     */
    @Test
    void staleRunningOwnedTaskPausesRunWithRecoveryAction() throws Exception {
        BulkRunService service = new BulkRunService(
            new StuckRunningDownloaderService(),
            new FakeRavenBrokerClient(),
            new TestLogger()
        );

        Map<String, Object> created = service.createRun(Map.of(
            "type", "manga",
            "titlegroup", "A",
            "requestedBy", "owner-1"
        ));
        Map<String, Object> status = awaitStatus(service, String.valueOf(created.get("runId")), "paused");

        assertEquals("paused", status.get("status"));
        assertEquals(false, status.get("active"));
        assertTrue(String.valueOf(status.get("message")).contains("cancel that task"));
        Map<String, Object> summary = map(status.get("summary"));
        List<Map<String, Object>> actions = maps(summary.get("recoveryActions"));
        assertEquals(1, actions.size());
        assertEquals("stale-running-title-task", actions.getFirst().get("type"));
        assertEquals(List.of("task_1"), actions.getFirst().get("taskIds"));
        assertEquals("/admin/activity/queue", actions.getFirst().get("adminPath"));
        Map<String, Object> batchResult = map(maps(status.get("batches")).getFirst().get("result"));
        assertEquals(List.of("task_1"), batchResult.get("staleTaskIds"));
    }

    /**
     * Verify Raven shutdown interruptions leave a running durable run for
     * recovery instead of incorrectly making the run terminal failed.
     *
     * @throws Exception when the async run does not enter or leave active state
     */
    @Test
    void interruptedWorkerLeavesRunningRunRecoverable() throws Exception {
        BulkRunService service = new BulkRunService(
            new NeverCompletingDownloaderService(),
            new FakeRavenBrokerClient(),
            new TestLogger()
        );

        Map<String, Object> created = service.createRun(Map.of(
            "type", "manga",
            "titlegroup", "A",
            "requestedBy", "owner-1"
        ));
        String runId = String.valueOf(created.get("runId"));
        awaitActive(service, runId);

        service.shutdown();
        Map<String, Object> status = awaitInactive(service, runId);

        assertEquals("running", status.get("status"));
        assertEquals(false, status.get("active"));
        assertTrue(String.valueOf(status.get("message")).contains("resume"));
    }

    /**
     * Verify status inspection repairs a detached durable running job by
     * scheduling the missing in-memory worker again.
     *
     * @throws Exception when the recovered run does not finish
     */
    @Test
    void statusReschedulesDetachedRunningRun() throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        BulkRunService service = new BulkRunService(
            new CompletingDownloaderService(),
            brokerClient,
            new TestLogger()
        );

        Map<String, Object> created = service.createRun(Map.of(
            "type", "manga",
            "titlegroup", "A",
            "requestedBy", "owner-1",
            "start", false
        ));
        String runId = String.valueOf(created.get("runId"));
        seedDurableRun(brokerClient, runId, "running", "running");

        service.status(runId);
        Map<String, Object> status = awaitStatus(service, runId, "completed");

        assertEquals("completed", status.get("status"));
        assertEquals(1, map(status.get("summary")).get("completedTitleTaskCount"));
    }

    /**
     * Verify an old failed durable run with runnable batches can be continued
     * without allowing genuinely failed or cancelled batches to restart.
     *
     * @throws Exception when the recovered run does not finish
     */
    @Test
    void resumeRunRecoversFailedRunWithRunnableBatches() throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        BulkRunService service = new BulkRunService(
            new CompletingDownloaderService(),
            brokerClient,
            new TestLogger()
        );

        Map<String, Object> created = service.createRun(Map.of(
            "type", "manga",
            "titlegroup", "A",
            "requestedBy", "owner-1",
            "start", false
        ));
        String runId = String.valueOf(created.get("runId"));
        seedDurableRun(brokerClient, runId, "failed", "running");

        service.resumeRun(runId);
        Map<String, Object> status = awaitStatus(service, runId, "completed");

        assertEquals("completed", status.get("status"));
        assertEquals(1, map(status.get("summary")).get("completedTitleTaskCount"));
    }

    private static void assertBatch(Map<String, Object> batch, String group, String type, int sortOrder) {
        Map<String, Object> filters = map(batch.get("filters"));
        assertEquals(group, filters.get("titleGroup"));
        assertEquals(type, filters.get("type"));
        assertEquals(sortOrder, batch.get("sortOrder"));
    }

    private static Map<String, Object> awaitStatus(BulkRunService service, String runId, String expectedStatus) throws Exception {
        for (int index = 0; index < 20; index++) {
            Map<String, Object> status = service.status(runId);
            String runStatus = String.valueOf(status.get("status"));
            if (expectedStatus.equals(runStatus)) {
                return status;
            }
            TimeUnit.MILLISECONDS.sleep(100);
        }
        Map<String, Object> status = service.status(runId);
        assertTrue(false, "Run did not reach status " + expectedStatus + ": " + status);
        return status;
    }

    private static Map<String, Object> awaitActive(BulkRunService service, String runId) throws Exception {
        for (int index = 0; index < 20; index++) {
            Map<String, Object> status = service.status(runId);
            if (Boolean.TRUE.equals(status.get("active"))) {
                return status;
            }
            TimeUnit.MILLISECONDS.sleep(100);
        }
        Map<String, Object> status = service.status(runId);
        assertTrue(false, "Run did not become active: " + status);
        return status;
    }

    private static Map<String, Object> awaitInactive(BulkRunService service, String runId) throws Exception {
        for (int index = 0; index < 20; index++) {
            Map<String, Object> status = service.status(runId);
            if (Boolean.FALSE.equals(status.get("active"))) {
                return status;
            }
            TimeUnit.MILLISECONDS.sleep(100);
        }
        Map<String, Object> status = service.status(runId);
        assertTrue(false, "Run did not become inactive: " + status);
        return status;
    }

    private static void seedDurableRun(FakeRavenBrokerClient brokerClient, String runId, String runStatus, String batchStatus) {
        Map<String, Object> job = brokerJobs(brokerClient).stream()
            .filter((entry) -> runId.equals(String.valueOf(entry.get("jobId"))))
            .findFirst()
            .orElseThrow();
        job.put("status", runStatus);
        job.put("message", "Seeded " + runStatus + " run.");
        brokerClient.putJob(runId, job);

        Map<String, Object> batch = brokerTasks(brokerClient, runId).getFirst();
        Map<String, Object> result = new LinkedHashMap<>(map(batch.get("result")));
        result.put("taskIds", List.of("task_1"));
        result.put("queuedTaskIds", List.of("task_1"));
        result.put("attempts", Map.of("task_1", 1));
        result.put("lastProgressAt", Instant.now().toString());
        batch.put("status", batchStatus);
        batch.put("message", "Seeded " + batchStatus + " batch.");
        batch.put("percent", 25);
        batch.put("startedAt", Instant.now().toString());
        batch.put("result", result);
        brokerClient.putJobTask(runId, String.valueOf(batch.get("taskId")), batch);
    }

    private static List<Map<String, Object>> brokerJobs(FakeRavenBrokerClient brokerClient) {
        return OBJECT_MAPPER.convertValue(
            brokerClient.listJobs("scriptarr-raven", "raven-bulk-downloadall", ""),
            new TypeReference<>() {
            }
        );
    }

    private static List<Map<String, Object>> brokerTasks(FakeRavenBrokerClient brokerClient, String runId) {
        return OBJECT_MAPPER.convertValue(
            brokerClient.listJobTasks(runId, ""),
            new TypeReference<>() {
            }
        );
    }

    private static Map<String, Object> map(Object value) {
        if (value instanceof Map<?, ?> raw) {
            Map<String, Object> mapped = new LinkedHashMap<>();
            raw.forEach((key, entryValue) -> mapped.put(String.valueOf(key), entryValue));
            return mapped;
        }
        return Map.of();
    }

    private static List<Map<String, Object>> maps(Object value) {
        if (value instanceof List<?> raw) {
            return raw.stream().map(BulkRunServiceTest::map).toList();
        }
        return List.of();
    }

    private static BulkQueueDownloadResult queuedBulkResult() {
        return new BulkQueueDownloadResult(
            BulkQueueDownloadResult.STATUS_QUEUED,
            "Queued 1 title(s) for download.",
            new BulkQueueDownloadResult.Filters("Manga", false, "A"),
            1,
            1,
            1,
            0,
            0,
            0,
            0,
            0,
            List.of("task_1"),
            List.of("Alpha Start"),
            List.of(),
            List.of(),
            List.of(),
            List.of(),
            List.of()
        );
    }

    private static final class TestLogger extends ScriptarrLogger {
        @Override
        public Path getDownloadsRoot() {
            return Path.of("build/test-downloads");
        }

        @Override
        public Path getLogsRoot() {
            return Path.of("build/test-logs");
        }

        @Override
        public void warn(String tag, String message, String detail) {
        }

        @Override
        public void error(String tag, String message, Throwable error) {
        }
    }

    private static class NoopDownloaderService extends DownloaderService {
        NoopDownloaderService() {
            super(null, null, null, null, null, null, null, new TestLogger());
        }
    }

    private static final class CompletingDownloaderService extends NoopDownloaderService {
        @Override
        public BulkQueueDownloadResult bulkQueueDownload(
            String providerId,
            String type,
            Boolean nsfw,
            String titlePrefix,
            String requestedBy
        ) {
            return queuedBulkResult();
        }

        @Override
        public List<Map<String, Object>> snapshot() {
            return List.of(Map.of("taskId", "task_1", "status", "completed"));
        }
    }

    private static final class RetryThenCompleteDownloaderService extends NoopDownloaderService {
        private final AtomicInteger retryCount = new AtomicInteger();

        @Override
        public BulkQueueDownloadResult bulkQueueDownload(
            String providerId,
            String type,
            Boolean nsfw,
            String titlePrefix,
            String requestedBy
        ) {
            return queuedBulkResult();
        }

        @Override
        public List<Map<String, Object>> snapshot() {
            String status = retryCount.get() == 0 ? "failed" : "completed";
            return List.of(Map.of("taskId", "task_1", "status", status));
        }

        @Override
        public synchronized Map<String, Object> retryTask(String taskId) {
            retryCount.incrementAndGet();
            return Map.of("taskId", taskId, "status", "queued");
        }
    }

    private static final class NeverCompletingDownloaderService extends NoopDownloaderService {
        @Override
        public BulkQueueDownloadResult bulkQueueDownload(
            String providerId,
            String type,
            Boolean nsfw,
            String titlePrefix,
            String requestedBy
        ) {
            return queuedBulkResult();
        }

        @Override
        public List<Map<String, Object>> snapshot() {
            String now = Instant.now().toString();
            return List.of(Map.of(
                "taskId", "task_1",
                "status", "queued",
                "queuedAt", now,
                "updatedAt", now
            ));
        }
    }

    private static final class StuckRunningDownloaderService extends NoopDownloaderService {
        private final String staleUpdatedAt = Instant.now().minus(Duration.ofHours(2)).toString();

        @Override
        public BulkQueueDownloadResult bulkQueueDownload(
            String providerId,
            String type,
            Boolean nsfw,
            String titlePrefix,
            String requestedBy
        ) {
            return queuedBulkResult();
        }

        @Override
        public List<Map<String, Object>> snapshot() {
            return List.of(Map.of(
                "taskId", "task_1",
                "status", "running",
                "queuedAt", staleUpdatedAt,
                "updatedAt", staleUpdatedAt
            ));
        }

        @Override
        public synchronized Map<String, Object> cancelTask(String taskId) {
            return snapshot().getFirst();
        }
    }
}
