package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.metadata.MetadataService;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Exercise broker-outage terminal reconciliation without allocating another execution or losing files. */
class BulkTaskTerminalRecoveryTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String QUEUED = "2026-11-08T04:00:00.123456789Z";
    private static final String STARTED = "2026-11-08T04:00:01.123456789Z";
    private static final String FAILED = "2026-11-08T04:01:03.123456789Z";

    /** Reproduce the first running write and terminal write failing while the durable task remains queued. */
    @Test
    void actualWorkerFailureFromQueuedShadowHealsOnceWithoutDispatch(@TempDir Path root) throws Exception {
        Broker broker = new Broker(); broker.failAfterInitial = true;
        try (Fixture f = new Fixture(root, broker)) {
            DownloadRequest request = new DownloadRequest("Alpha", "https://weebcentral.com/series/alpha", "Manhua", "owner", "weebcentral", "",
                Map.of(), Map.of("expectedChapters", List.of(Map.of("chapter_number", "1"))), "", "normal");
            f.service.queueBulkOwned("task", "run", "batch", "plan", request);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < deadline && (!BulkTaskTerminalRecovery.dirtyFailure(f.tasks().get("task")) || !f.quiescent("task"))) Thread.sleep(5);
            assertTrue(BulkTaskTerminalRecovery.dirtyFailure(f.tasks().get("task")));
            assertTrue(f.quiescent("task"));
            assertEquals("queued", broker.row("task").get("status"));
            broker.failAfterInitial = false;
            broker.writes.clear();
            f.service.reconcileFailedBulkTaskPersistence();
            assertEquals("failed", broker.row("task").get("status"));
            assertEquals(List.of("job:failed", "jobTask:failed", "download:failed"), broker.writes);
            assertFalse(f.tasks().get("task").containsKey("persistenceError"));
            assertTrue(f.quiescent("task"));
            assertEquals(0, ((Number) f.service.stats().get("queued")).intValue());
            f.service.reconcileFailedBulkTaskPersistence();
            assertEquals(3, broker.writes.size());
        }
    }

    /** A running shadow preserves the failed snapshot's roots, frozen request and existing retry ordinals. */
    @Test
    void runningShadowRetainsFilesAndAcceptedReceipt(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root, new Broker())) {
            Map<String, Object> local = task("task", "failed");
            Map<String, Object> receipt = Map.of("attemptId", "retry-2", "cumulativeAttempt", 2, "approvalGeneration", 3, "approvalAttempt", 2, "acceptedAt", STARTED);
            details(local).put("bulkRetryAttempt", receipt);
            Path archive = root.resolve("downloading/manhua/Alpha/chapter.cbz");
            Files.createDirectories(archive.getParent()); Files.writeString(archive, "retained completed archive sentinel");
            details(local).put("workingRoot", archive.getParent().toString());
            details(local).put("downloadRoot", root.resolve("downloaded/manhua/Alpha").toString());
            Map<String, Object> durable = copy(local); durable.put("status", "running"); durable.put("updatedAt", "2026-11-08T04:00:30Z");
            durable.remove("persistenceError");
            f.seed(local, durable);
            f.service.reconcileFailedBulkTaskPersistence();
            Map<String, Object> saved = f.broker.row("task");
            assertEquals("failed", saved.get("status"));
            assertEquals(receipt, details(saved).get("bulkRetryAttempt"));
            assertEquals(details(local).get("selectedDownload"), details(saved).get("selectedDownload"));
            assertEquals(archive.getParent().toString(), details(saved).get("workingRoot"));
            assertEquals("retained completed archive sentinel", Files.readString(archive));
            assertTrue(f.quiescent("task"));
        }
    }

    /** Repeated outages retain the original dirty failure and never publish a successful terminal result. */
    @Test
    void repeatedFailureStaysDirtyUntilEveryWriteAcknowledges(@TempDir Path root) {
        try (Fixture f = new Fixture(root, new Broker())) {
            Map<String, Object> local = task("task", "failed"), durable = copy(local);
            durable.put("status", "running"); durable.remove("persistenceError");
            f.seed(local, durable); f.broker.fail = true;
            f.service.reconcileFailedBulkTaskPersistence(); f.service.reconcileFailedBulkTaskPersistence();
            assertSame(local, f.tasks().get("task"));
            assertTrue(local.containsKey("persistenceError"));
            assertEquals("running", f.broker.row("task").get("status"));
            f.broker.fail = false; f.broker.failDownload = true;
            f.service.reconcileFailedBulkTaskPersistence();
            assertTrue(local.containsKey("persistenceError"));
            assertEquals("running", f.broker.row("task").get("status"));
            f.broker.failDownload = false; f.broker.writes.clear();
            f.service.reconcileFailedBulkTaskPersistence();
            assertEquals(List.of("job:failed", "jobTask:failed", "download:failed"), f.broker.writes);
            assertEquals("failed", f.broker.row("task").get("status"));
        }
    }

    /** An already-failed matching row still repairs generic checkpoints and waits for all three acknowledgements. */
    @Test
    void identicalFailedRowDoesNotSkipGenericCheckpointRepair(@TempDir Path root) {
        try (Fixture f = new Fixture(root, new Broker())) {
            Map<String, Object> local = task("task", "failed"), durable = copy(local); durable.remove("persistenceError");
            f.seed(local, durable); f.broker.fail = true;
            f.service.reconcileFailedBulkTaskPersistence(); assertTrue(local.containsKey("persistenceError"));
            f.broker.fail = false; f.broker.writes.clear(); f.service.reconcileFailedBulkTaskPersistence();
            assertEquals(List.of("job:failed", "jobTask:failed", "download:failed"), f.broker.writes);
            assertFalse(f.tasks().get("task").containsKey("persistenceError"));
        }
    }

    /** Completed, cancelled and superseded state, changed owners and newer executions always win. */
    @Test
    void newerDurableStateAndDifferentRequestRemainUntouched(@TempDir Path root) {
        try (Fixture f = new Fixture(root, new Broker())) {
            for (String status : List.of("completed", "cancelled", "superseded")) {
                Map<String, Object> local = task(status, "failed"), durable = copy(local); durable.put("status", status); f.seed(local, durable);
            }
            for (String key : List.of("bulkRunId", "bulkBatchId", "bulkPlanId", "startedAt")) {
                Map<String, Object> local = task(key, "failed"), durable = copy(local); durable.put("status", "running"); details(durable).put(key, "different"); f.seed(local, durable);
            }
            Map<String, Object> local = task("receipt", "failed"), durable = copy(local); durable.put("status", "queued");
            details(durable).put("bulkRetryAttempt", Map.of("attemptId", "new", "cumulativeAttempt", 2, "approvalGeneration", 3, "approvalAttempt", 2, "acceptedAt", STARTED)); f.seed(local, durable);
            local = task("request", "failed"); durable = copy(local); durable.put("status", "running"); details(durable).put("selectedDownload", Map.of("changed", true)); f.seed(local, durable);
            local = task("queuedAt", "failed"); durable = copy(local); durable.put("status", "queued"); durable.put("queuedAt", "2026-11-08T04:02:00Z"); f.seed(local, durable);
            local = task("newer", "failed"); durable = copy(local); durable.put("status", "running"); durable.put("updatedAt", "2026-11-08T04:02:00Z"); f.seed(local, durable);
            f.broker.writes.clear(); f.service.reconcileFailedBulkTaskPersistence();
            assertTrue(f.broker.writes.isEmpty());
            assertTrue(f.tasks().values().stream().allMatch(t -> t.containsKey("persistenceError")));
        }
    }

    /** Local healthy work and any registered execution or cancellation gate are excluded. */
    @Test
    void healthyActiveQueuedAndWindingDownWorkNeverFlushes(@TempDir Path root) {
        try (Fixture f = new Fixture(root, new Broker())) {
            for (String status : List.of("running", "queued", "completed", "superseded")) f.seed(task(status, status), task(status, status));
            Map<String, Object> cancelled = task("cancelled", "failed"); cancelled.put("message", "Cancelled by admin."); f.seed(cancelled, copy(cancelled));
            for (String gate : List.of("runningTaskThreads", "queuedTasks", "bulkTaskDispatches")) {
                Map<String, Object> local = task(gate, "failed"), durable = copy(local); durable.put("status", "running"); f.seed(local, durable);
                f.fieldMap(gate).put(gate, new Object());
            }
            f.broker.writes.clear(); f.service.reconcileFailedBulkTaskPersistence(); assertTrue(f.broker.writes.isEmpty());
            for (String gate : List.of("runningTaskThreads", "queuedTasks", "bulkTaskDispatches")) f.fieldMap(gate).clear();
        }
    }

    /** Numeric JSON roundtrips and truncated SQL timestamps preserve an otherwise exact frozen execution. */
    @Test
    void persistedTimestampPrecisionAndRequestNumberTypesRemainCompatible() {
        Map<String, Object> local = task("task", "failed"), durable = copy(local);
        durable.put("status", "queued"); durable.put("queuedAt", "2026-11-08T04:00:00Z"); durable.put("updatedAt", "2026-11-08T04:01:03Z");
        details(durable).put("startedAt", ""); details(local).put("selectedMetadata", Map.of("count", 12L)); details(durable).put("selectedMetadata", Map.of("count", 12));
        assertTrue(BulkTaskTerminalRecovery.writableShadow(local, durable));
        details(durable).put("startedAt", "2026-11-08T04:00:02.123456789Z");
        assertFalse(BulkTaskTerminalRecovery.writableShadow(local, durable));
    }

    /** UI history pruning cannot discard the only dirty terminal snapshot beyond the two-hundred-row cap. */
    @Test
    void dirtyFailuresSurviveTerminalHistoryPruning(@TempDir Path root) {
        try (Fixture f = new Fixture(root, new Broker())) {
            Map<String, Object> dirty = task("old-dirty", "failed"); dirty.put("updatedAt", "2020-01-01T00:00:00Z"); f.tasks().put("old-dirty", dirty);
            for (int i = 0; i < 220; i++) {Map<String, Object> done = task("done-" + i, "failed"); done.remove("persistenceError"); f.tasks().put("done-" + i, done);}
            f.service.snapshot(); assertSame(dirty, f.tasks().get("old-dirty")); assertEquals(201, f.tasks().size());
        }
    }

    private static Map<String, Object> task(String id, String status) {
        Map<String, Object> task = new ConcurrentHashMap<>();
        task.putAll(Map.of("taskId", id, "jobId", id, "status", status, "percent", 90, "message", "Broker interrupted execution.", "queuedAt", QUEUED, "updatedAt", FAILED));
        task.put("persistenceError", "Could not persist the bulk-owned download state.");
        task.put("details", new LinkedHashMap<>(Map.of("bulkRunId", "run", "bulkBatchId", "batch", "bulkPlanId", "plan", "startedAt", STARTED,
            "selectedDownload", Map.of("expectedChapters", List.of(Map.of("chapter_number", "1"))), "selectedMetadata", Map.of())));
        return task;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> details(Map<String, Object> task) { return (Map<String, Object>) task.get("details"); }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> copy(Map<String, Object> task) { return JSON.convertValue(JSON.valueToTree(task), Map.class); }

    /** Track strict broker writes and controlled failures without touching another service. */
    private static final class Broker extends FakeRavenBrokerClient {
        private final List<String> writes = new ArrayList<>();
        private volatile boolean fail;
        private volatile boolean failDownload;
        private volatile boolean failAfterInitial;
        private int jobs;
        @Override public JsonNode putJob(String id, Map<String, Object> task) {
            if (fail || (failAfterInitial && jobs > 0)) throw new IllegalStateException("Transient broker outage.");
            jobs++; writes.add("job:" + task.get("status")); return super.putJob(id, task);
        }
        @Override public JsonNode putJobTask(String job, String id, Map<String, Object> task) {writes.add("jobTask:" + task.get("status")); return super.putJobTask(job, id, task);}
        @Override public JsonNode putDownloadTask(String id, Map<String, Object> task) {
            if (failDownload) throw new IllegalStateException("Lost download checkpoint.");
            writes.add("download:" + task.get("status")); return super.putDownloadTask(id, task);
        }
        private Map<String, Object> row(String id) {
            for (JsonNode task : listDownloadTasks()) if (id.equals(task.path("taskId").asText())) return copy(JSON.convertValue(task, Map.class));
            return Map.of();
        }
    }

    /** Construct a real queue and expose only its controlled test checkpoints. */
    private static final class Fixture implements AutoCloseable {
        private final Broker broker;
        private final DownloaderService service;
        private Fixture(Path root, Broker broker) {
            this.broker = broker;
            ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
            RavenSettingsService settings = new RavenSettingsService(broker, logger, List.of());
            service = new DownloaderService(new DownloadProviderRegistry(List.of(), settings), null, mock(LibraryService.class),
                mock(DownloadIntakeService.class), mock(MetadataService.class), broker, settings, logger);
        }
        @SuppressWarnings("unchecked") private Map<String, Map<String, Object>> tasks() {return (Map<String, Map<String, Object>>) ReflectionTestUtils.getField(service, "tasks");}
        @SuppressWarnings("unchecked") private Map<String, Object> fieldMap(String name) {return (Map<String, Object>) ReflectionTestUtils.getField(service, name);}
        private boolean quiescent(String id) {return List.of("runningTaskThreads", "queuedTasks", "bulkTaskDispatches").stream().noneMatch(name -> fieldMap(name).containsKey(id));}
        private void seed(Map<String, Object> local, Map<String, Object> durable) {
            broker.putDownloadTask(String.valueOf(local.get("taskId")), durable);
            details(local).forEach(local::putIfAbsent);
            tasks().put(String.valueOf(local.get("taskId")), local); broker.writes.clear();
        }
        /** Stop test executors without changing any brokered task state. */
        @Override public void close() {service.shutdown();}
    }
}
