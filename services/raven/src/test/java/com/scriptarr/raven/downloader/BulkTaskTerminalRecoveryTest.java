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

    /** A retry accepted during gap restoration cannot be overwritten by the old failed observation. */
    @Test void gapDiagnosticsCannotOverwriteNewApprovedRetry(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root, new Broker())) {
            Map<String, Object> old = task("task", "failed"); old.remove("persistenceError"); old.put("titleId", "title");
            f.seed(old, copy(old));
            f.broker.putJobTask("run", "plan", Map.of("taskId", "plan", "status", "queued", "payload", Map.of("kind", "bulk-title-plan", "runId", "run"), "result", Map.of("downloadTaskId", "task")));
            when(f.library.restorePlannedChapterGaps(anyString(), anyString(), anyList())).thenAnswer(i -> {
                f.service.retryBulkTask("task", "run", "batch", "approved-new", 2, 2, 1);
                var title = mock(com.scriptarr.raven.library.LibraryTitle.class); when(title.id()).thenReturn("title"); when(title.chapters()).thenReturn(List.of()); return title;
            });
            f.service.reconcileBulkChapterGaps("run", List.of(copy(old)));
            Map<String, Object> saved = f.broker.row("task");
            assertEquals("approved-new", ((Map<?, ?>) details(saved).get("bulkRetryAttempt")).get("attemptId"));
            assertFalse(details(saved).containsKey("completionProblems"));
        }
    }

    /** One changed source cannot stop diagnostics for another accepted title. */
    @Test void oneSourceConflictDoesNotBlockOtherGapObservations(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root, new Broker())) {
            List<Map<String, Object>> owned = new ArrayList<>();
            for (String id : List.of("conflict", "other")) {
                Map<String, Object> row = task(id, "failed"); row.remove("persistenceError"); row.put("titleId", id); details(row).put("bulkPlanId", "plan-" + id);
                f.seed(row, copy(row)); owned.add(copy(row));
                f.broker.putJobTask("run", "plan-" + id, Map.of("taskId", "plan-" + id, "status", "queued", "payload", Map.of("kind", "bulk-title-plan", "runId", "run"), "result", Map.of("downloadTaskId", id)));
            }
            when(f.library.restorePlannedChapterGaps(eq("conflict"), anyString(), anyList())).thenThrow(new IllegalStateException("Source changed"));
            var title = mock(com.scriptarr.raven.library.LibraryTitle.class); when(title.id()).thenReturn("other"); when(title.chapters()).thenReturn(List.of());
            when(f.library.restorePlannedChapterGaps(eq("other"), anyString(), anyList())).thenReturn(title);
            assertEquals(2, f.service.reconcileBulkChapterGaps("run", owned).size());
            assertTrue(details(f.broker.row("other")).containsKey("completionProblems"));
            assertFalse(details(f.broker.row("conflict")).containsKey("completionProblems"));
        }
    }

    /** Reproduce the first running write and terminal write failing while the durable task remains queued. */
    @Test
    void actualWorkerFailureFromQueuedShadowHealsOnceWithoutDispatch(@TempDir Path root) throws Exception {
        Broker broker = new Broker(); broker.failAfterInitial = true;
        try (Fixture f = new Fixture(root, broker)) {
            DownloadRequest request = new DownloadRequest("Alpha", "https://weebcentral.com/series/8ED3F6AD685B959EAD7022518E", "Manhua", "owner", "weebcentral", "",
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

    /** Default SQL rounding and explicit truncation both retain the same fractional queued execution across a minute. */
    @Test
    void fractionalSqlRoundAndTruncateAreBothRecognizedWithoutChangingTheAttempt() {
        Map<String, Object> local = task("fractional", "failed");
        local.put("queuedAt", "2026-11-08T04:00:59.750999999Z");
        local.put("updatedAt", "2026-11-08T04:01:59.750999999Z");
        details(local).put("startedAt", "2026-11-08T04:01:01.123456789Z");
        for (String[] persisted : List.of(new String[]{"2026-11-08T04:01:00Z", "2026-11-08T04:02:00Z"},
            new String[]{"2026-11-08T04:00:59Z", "2026-11-08T04:01:59Z"},
            new String[]{"2026-11-08T04:00:59.750Z", "2026-11-08T04:01:59.750Z"})) {
            Map<String, Object> durable = copy(local); durable.put("status", "running");
            durable.put("queuedAt", persisted[0]); durable.put("updatedAt", persisted[1]);
            assertTrue(BulkTaskTerminalRecovery.writableShadow(local, durable));
            details(durable).put("startedAt", "2026-11-08T04:01:02.123456789Z");
            assertFalse(BulkTaskTerminalRecovery.writableShadow(local, durable));
        }
    }

    /** Only exact serialization results may look newer; unrelated queued seconds or later checkpoints still reject. */
    @Test
    void roundingDoesNotPermitANewerExecutionOrLaterFractionalCheckpoint() {
        Map<String, Object> local = task("fractional", "failed");
        local.put("queuedAt", "2026-11-08T04:00:00.750Z"); local.put("updatedAt", "2026-11-08T04:01:02.750Z");
        Map<String, Object> durable = copy(local); durable.put("status", "queued"); details(durable).put("startedAt", "");
        durable.put("queuedAt", "2026-11-08T04:00:01Z"); durable.put("updatedAt", "2026-11-08T04:01:03Z");
        assertTrue(BulkTaskTerminalRecovery.writableShadow(local, durable));
        for (String newer : List.of("2026-11-08T04:01:03.001Z", "2026-11-08T04:01:04Z", "2026-11-08T04:01:02.900Z")) {
            durable.put("updatedAt", newer); assertFalse(BulkTaskTerminalRecovery.writableShadow(local, durable));
        }
        durable.put("updatedAt", "2026-11-08T04:01:03Z"); durable.put("queuedAt", "2026-11-08T04:00:02Z");
        assertFalse(BulkTaskTerminalRecovery.writableShadow(local, durable));
        local.put("queuedAt", "2026-11-08T04:00:00.499999999Z"); durable.put("queuedAt", "2026-11-08T04:00:01Z");
        assertFalse(BulkTaskTerminalRecovery.writableShadow(local, durable));
        local.put("queuedAt", "2026-11-08T04:00:59.999999999Z"); durable.put("queuedAt", "2026-11-08T04:01:00Z");
        assertTrue(BulkTaskTerminalRecovery.writableShadow(local, durable));
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

    /** Build one known execution with nanosecond live timestamps and a dirty terminal checkpoint. */
    private static Map<String, Object> task(String id, String status) {
        Map<String, Object> task = new ConcurrentHashMap<>();
        task.putAll(Map.of("taskId", id, "jobId", id, "status", status, "percent", 90, "message", "Broker interrupted execution.", "queuedAt", QUEUED, "updatedAt", FAILED));
        task.put("persistenceError", "Could not persist the bulk-owned download state.");
        task.put("details", new LinkedHashMap<>(Map.of("bulkRunId", "run", "bulkBatchId", "batch", "bulkPlanId", "plan", "startedAt", STARTED,
            "selectedDownload", Map.of("expectedChapters", List.of(Map.of("chapter_number", "1"))), "selectedMetadata", Map.of())));
        return task;
    }

    /** Access mutable fixture details before they are flattened into the real queue representation. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> details(Map<String, Object> task) { return (Map<String, Object>) task.get("details"); }

    /** Simulate a broker JSON roundtrip without sharing mutable local task state. */
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
        /** Read exactly one authoritative task from the fixture broker. */
        private Map<String, Object> row(String id) {
            for (JsonNode task : listDownloadTasks()) if (id.equals(task.path("taskId").asText())) return copy(JSON.convertValue(task, Map.class));
            return Map.of();
        }
    }

    /** Construct a real queue and expose only its controlled test checkpoints. */
    private static final class Fixture implements AutoCloseable {
        private final Broker broker;
        private final DownloaderService service;
        private final LibraryService library = mock(LibraryService.class);
        /** Construct a real downloader with isolated broker and filesystem dependencies. */
        private Fixture(Path root, Broker broker) {
            this.broker = broker;
            ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
            RavenSettingsService settings = new RavenSettingsService(broker, logger, List.of());
            service = new DownloaderService(new DownloadProviderRegistry(List.of(), settings), null, library,
                mock(DownloadIntakeService.class), mock(MetadataService.class), broker, settings, logger);
        }
        /** Inspect the exact local checkpoint boundary under test. */
        @SuppressWarnings("unchecked") private Map<String, Map<String, Object>> tasks() {return (Map<String, Map<String, Object>>) ReflectionTestUtils.getField(service, "tasks");}
        /** Access one execution guard for deterministic winding-down fixtures. */
        @SuppressWarnings("unchecked") private Map<String, Object> fieldMap(String name) {return (Map<String, Object>) ReflectionTestUtils.getField(service, name);}
        /** Require no registered worker, queued runnable or accepted dispatch for the identity. */
        private boolean quiescent(String id) {return List.of("runningTaskThreads", "queuedTasks", "bulkTaskDispatches").stream().noneMatch(name -> fieldMap(name).containsKey(id));}
        /** Seed divergent local and durable snapshots without allocating an executable attempt. */
        private void seed(Map<String, Object> local, Map<String, Object> durable) {
            broker.putDownloadTask(String.valueOf(local.get("taskId")), durable);
            details(local).forEach(local::putIfAbsent);
            tasks().put(String.valueOf(local.get("taskId")), local); broker.writes.clear();
        }
        /** Stop test executors without changing any brokered task state. */
        @Override public void close() {service.shutdown();}
    }
}
