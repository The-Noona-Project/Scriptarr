package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.IntFunction;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/** Deterministic coverage for durable bulk ownership, approvals, and honest recovery. */
class BulkRunServiceTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Instant NOW = Instant.parse("2026-11-07T12:00:00Z");
    private final List<BulkRunService> services = new ArrayList<>();

    /** Stop every executor even when a test fails before explicit cancellation. */
    @AfterEach
    void stopWorkers() {
        services.forEach(BulkRunService::shutdown);
    }

    /** Twenty is an approval batch count, never a title limit. */
    @Test
    void exactManhuaCommandQueuesAllTwentyFiveTitlesInOneBatch() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.taskCount = 25;
        String runId = fixture.create(Map.of("type", "Manhua", "titlegroup", "t", "nsfw", false, "groupsize", 20));
        Map<String, Object> status = awaitStatus(fixture.service, runId, "completed");
        assertEquals(1, maps(status.get("batches")).size());
        assertEquals("Manhua", map(status.get("filters")).get("type"));
        assertEquals("T", map(status.get("filters")).get("titlegroup"));
        assertEquals(false, map(status.get("filters")).get("nsfw"));
        assertEquals(20, number(map(status.get("filters")).get("batchesPerApproval")));
        assertEquals(25, number(map(status.get("summary")).get("completedTitleTaskCount")));
        assertEquals(1, fixture.gateway.queueCalls.get());
    }

    /** Expanded commands retain group-first type ordering. */
    @Test
    void allGroupsKeepTheirHundredAndFourBatchManifest() {
        Fixture fixture = fixture();
        String runId = fixture.create(Map.of("type", "all", "titlegroup", "all", "start", false));
        List<Map<String, Object>> batches = maps(fixture.service.status(runId).get("batches"));
        assertEquals(104, batches.size());
        assertEquals(List.of("A Manga", "A Manhwa", "A Manhua", "A OEL", "B Manga"),
            batches.subList(0, 5).stream().map(batch -> map(batch.get("filters")).get("titleGroup")
                + " " + map(batch.get("filters")).get("type")).toList());
    }

    /** A paused run observes late terminal changes without dispatching, rotating approval, or writing from GET. */
    @Test void pausedRunObservesAcceptedWorkWithoutStartingIt() {
        Fixture fixture = fixture();
        String runId = fixture.create(Map.of("type", "Manhua", "titlegroup", "t", "start", false));
        String batchId = String.valueOf(maps(fixture.service.status(runId).get("batches")).getFirst().get("batchId"));
        fixture.broker.setStatus(runId, "paused");
        fixture.gateway.addOwned(runId, batchId, "accepted", "running");
        String approval = String.valueOf(fixture.service.status(runId).get("approvalId"));
        fixture.service.reconcileInterruptedRuns();
        assertEquals(1, number(map(fixture.service.status(runId).get("counts")).get("runningTitleTaskCount")));
        fixture.gateway.update("accepted", Map.of("status", "completed", "titleId", "kept-title"));
        fixture.service.reconcileInterruptedRuns();
        Map<String, Object> status = fixture.service.status(runId);
        assertEquals(1, number(map(status.get("counts")).get("completedTitleTaskCount")));
        assertEquals("paused", status.get("status")); assertEquals(approval, status.get("approvalId"));
        int writes = fixture.broker.taskWrites + fixture.broker.jobWrites;
        for (int i = 0; i < 5; i++) fixture.service.status(runId);
        fixture.service.reconcileInterruptedRuns();
        assertEquals(writes, fixture.broker.taskWrites + fixture.broker.jobWrites);
        assertEquals(0, fixture.gateway.queueCalls.get()); assertTrue(fixture.requestedRetryIds.isEmpty());
    }

    /** Lost responses reuse one creation identity; changed options cannot mutate it. */
    @Test
    void creationKeyIsCanonicalAndConflictsDoNotMutateTheRun() {
        Fixture fixture = fixture();
        Map<String, Object> request = Map.of("requestId", "discord:interaction:123", "start", false);
        String runId = fixture.create(request);
        int writes = fixture.broker.jobWrites;
        assertEquals(runId, fixture.create(request));
        assertEquals(writes, fixture.broker.jobWrites);
        assertEquals(1, fixture.broker.jobs.size());
        assertThrows(BulkRunConflictException.class, () -> fixture.create(Map.of(
            "requestId", "discord:interaction:123", "type", "Manga", "start", false)));
        assertThrows(BulkRunConflictException.class, () -> fixture.create(Map.of(
            "requestId", "discord:interaction:123", "requestedBy", "another-owner", "start", false)));
        assertThrows(IllegalArgumentException.class, () -> fixture.create(Map.of("requestId", "x".repeat(201))));
        assertThrows(IllegalArgumentException.class, () -> fixture.create(Map.of("requestId", "hidden\n")));
    }

    /** Creation replay repairs absent deterministic rows without resetting finished work. */
    @Test
    void creationReplayRepairsOnlyMissingBatches() {
        Fixture fixture = fixture();
        Map<String, Object> request = Map.of("requestId", "discord:message:partial", "type", "all", "start", false);
        String runId = fixture.create(request);
        List<Map<String, Object>> batches = maps(fixture.service.status(runId).get("batches"));
        Map<String, Object> kept = new LinkedHashMap<>(batches.getFirst());
        kept.put("taskId", kept.get("batchId"));
        kept.put("taskKey", "bulk-batch");
        kept.put("status", "completed");
        kept.put("result", Map.of("completedTaskIds", List.of("old-task"), "discoveryComplete", true));
        fixture.broker.putJobTask(runId, String.valueOf(kept.get("taskId")), kept);
        fixture.broker.deleteBatch(runId, String.valueOf(batches.getLast().get("batchId")));
        fixture.create(request);
        List<Map<String, Object>> repaired = maps(fixture.service.status(runId).get("batches"));
        assertEquals(4, repaired.size());
        assertEquals("completed", repaired.getFirst().get("status"));
        assertEquals(List.of("old-task"), map(repaired.getFirst().get("result")).get("completedTaskIds"));
        assertEquals(0, fixture.gateway.queueCalls.get());
    }

    /** Monitoring cannot schedule a detached running job or write any durable state. */
    @Test
    void statusNeverSchedulesOrWritesDetachedRunningWork() {
        Fixture fixture = fixture();
        String runId = fixture.create(Map.of("start", false));
        fixture.broker.setStatus(runId, "running");
        int writes = fixture.broker.jobWrites + fixture.broker.taskWrites;
        for (int index = 0; index < 20; index++) {
            Map<String, Object> status = fixture.service.status(runId);
            assertEquals("running", status.get("status"));
            assertFalse((Boolean) status.get("active"));
        }
        assertEquals(writes, fixture.broker.jobWrites + fixture.broker.taskWrites);
        assertEquals(0, fixture.gateway.queueCalls.get());
    }

    /** Recovery cannot classify local omissions before full restoration succeeds. */
    @Test
    void restorationBarrierDefersStartedQueuedWork() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.restored = new CompletableFuture<>();
        String runId = fixture.create(Map.of());
        assertEquals("queued", fixture.service.status(runId).get("status"));
        fixture.service.reconcileInterruptedRuns();
        assertEquals(0, fixture.gateway.queueCalls.get());
        fixture.gateway.restored.complete(null);
        fixture.service.reconcileInterruptedRuns();
        awaitStatus(fixture.service, runId, "completed");
    }

    /** Legacy and explicit manual queued jobs do not acquire an implicit start. */
    @Test
    void recoveryLeavesManualQueuedAndPausedJobsAlone() {
        Fixture fixture = fixture();
        String runId = fixture.create(Map.of("start", false));
        fixture.service.reconcileInterruptedRuns();
        assertEquals("queued", fixture.service.status(runId).get("status"));
        Map<String, Object> job = fixture.broker.job(runId);
        Map<String, Object> payload = map(job.get("payload"));
        payload.remove("startRequested");
        job.put("payload", payload);
        fixture.broker.putJob(runId, job);
        fixture.service.reconcileInterruptedRuns();
        assertEquals(0, fixture.gateway.queueCalls.get());
        fixture.broker.setStatus(runId, "paused");
        fixture.service.reconcileInterruptedRuns();
        assertEquals("paused", fixture.service.status(runId).get("status"));
    }

    /** Lifecycle persistence repair waits for restore and never starts paused or cancelled runs from a status read. */
    @Test
    void dirtyTerminalFlushRunsAfterRestoreWithoutStartingPausedOrCancelledWork() {
        Fixture fixture = fixture();
        String runId = fixture.create(Map.of("start", false));
        fixture.broker.setStatus(runId, "paused");
        fixture.gateway.restored = new CompletableFuture<>();
        fixture.service.status(runId);
        fixture.service.reconcileInterruptedRuns();
        verify(fixture.downloader, never()).reconcileFailedBulkTaskPersistence();
        fixture.gateway.restored.complete(null);
        fixture.service.reconcileInterruptedRuns();
        verify(fixture.downloader, times(1)).reconcileFailedBulkTaskPersistence();
        assertEquals("paused", fixture.service.status(runId).get("status"));
        fixture.broker.setStatus(runId, "cancelled");
        fixture.service.reconcileInterruptedRuns();
        verify(fixture.downloader, times(2)).reconcileFailedBulkTaskPersistence();
        assertEquals("cancelled", fixture.service.status(runId).get("status"));
        assertEquals(0, fixture.gateway.queueCalls.get());
    }

    /** One malformed legacy run must not block later jobs or make subsequent recovery passes unusable. */
    @Test
    void malformedLegacyRunDoesNotStopThisOrLaterRecoveryPasses() throws Exception {
        Fixture fixture = fixture();
        String malformedId = fixture.create(Map.of("start", false));
        Map<String, Object> malformed = fixture.broker.job(malformedId);
        Map<String, Object> payload = map(malformed.get("payload"));
        payload.put("type", "unsupported-legacy-type");
        malformed.put("payload", payload);
        malformed.put("status", "running");
        fixture.broker.putJob(malformedId, malformed);
        String firstHealthy = fixture.create(Map.of("start", false));
        fixture.broker.setStatus(firstHealthy, "running");

        assertDoesNotThrow(fixture.service::reconcileInterruptedRuns);
        awaitStatus(fixture.service, firstHealthy, "completed");
        assertEquals("running", fixture.broker.job(malformedId).get("status"));

        String laterHealthy = fixture.create(Map.of("start", false));
        fixture.broker.setStatus(laterHealthy, "running");
        assertDoesNotThrow(fixture.service::reconcileInterruptedRuns);
        awaitStatus(fixture.service, laterHealthy, "completed");
        assertEquals(2, fixture.gateway.discoveryCalls.get());
    }

    /** Terminal restoration errors are visible and paused, never successful. */
    @Test
    void failedRestorationPausesStartedRunsWithDiagnostic() {
        Fixture fixture = fixture();
        fixture.gateway.restored = CompletableFuture.failedFuture(new IllegalStateException("broker restoration failed"));
        String runId = fixture.create(Map.of());
        fixture.service.reconcileInterruptedRuns();
        Map<String, Object> status = fixture.service.status(runId);
        assertEquals("paused", status.get("status"));
        assertTrue(String.valueOf(status.get("recoveryError")).contains("restoration failed"));
        assertEquals(0, fixture.gateway.queueCalls.get());
    }

    /** An eight-hour legitimate queue wait does not become a stale failure. */
    @Test
    void healthyQueuedWorkNeverExpiresByTimestamp() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.statusFactory = index -> "queued";
        fixture.gateway.progressAt = NOW.minus(Duration.ofHours(8));
        String runId = fixture.create(Map.of());
        await(() -> fixture.gateway.ownedCalls.get() >= 2);
        assertEquals("running", fixture.service.status(runId).get("status"));
        verify(fixture.downloader, never()).removeTask(anyString());
        verify(fixture.downloader, never()).cancelTask(anyString());
        fixture.service.cancelRun(runId);
    }

    /** Genuine progress and encoder wait protect a worker; a stalled encoding pauses. */
    @Test
    void staleDetectionUsesActualProgressAndPreservesEncoderWait() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.statusFactory = index -> "running";
        String runId = fixture.create(Map.of());
        await(() -> fixture.gateway.ownedCalls.get() >= 2);
        String taskId = fixture.gateway.ids().getFirst();
        fixture.gateway.update(taskId, Map.of("updatedAt", NOW.minus(Duration.ofHours(3)).toString(), "actualProgressAt", NOW.toString()));
        await(() -> fixture.gateway.ownedCalls.get() >= 4);
        assertEquals("running", fixture.service.status(runId).get("status"));
        fixture.gateway.update(taskId, Map.of("actualProgressAt", NOW.minus(Duration.ofHours(3)).toString(), "stage", "waiting-for-encoder"));
        await(() -> fixture.gateway.ownedCalls.get() >= 6);
        assertEquals("running", fixture.service.status(runId).get("status"));
        fixture.gateway.update(taskId, Map.of("stage", "encoding"));
        Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
        assertEquals(List.of(taskId), map(maps(paused.get("batches")).getFirst().get("result")).get("failedTaskIds"));
        verify(fixture.downloader, times(1)).cancelTask(taskId);
        verify(fixture.downloader, never()).removeTask(anyString());
        fixture.gateway.update(taskId, Map.of("status", "completed", "updatedAt", NOW.toString()));
        fixture.service.resumeRun(runId);
        Map<String, Object> finished = awaitStatus(fixture.service, runId, "completed");
        assertEquals(0, number(map(finished.get("counts")).get("staleTitleTaskCount")));
        assertEquals(List.of(), map(maps(finished.get("batches")).getFirst().get("result")).get("staleTaskIds"));
    }

    /** Completion evidence survives UI pruning and is counted only once. */
    @Test
    void moreThanTwoHundredTerminalOutcomesRemainOwned() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.taskCount = 251;
        fixture.gateway.statusFactory = index -> index == 250 ? "queued" : "completed";
        String runId = fixture.create(Map.of());
        await(() -> number(map(fixture.service.status(runId).get("summary")).get("completedTitleTaskCount")) == 250);
        String last = fixture.gateway.idsInCreationOrder().getLast();
        fixture.gateway.tasks.keySet().removeIf(id -> !id.equals(last));
        fixture.gateway.update(last, Map.of("status", "completed"));
        Map<String, Object> status = awaitStatus(fixture.service, runId, "completed");
        Map<String, Object> result = map(maps(status.get("batches")).getFirst().get("result"));
        assertEquals(251, number(map(status.get("summary")).get("completedTitleTaskCount")));
        assertEquals(List.of(), result.get("missingTaskIds"));
        assertEquals(251, map(result.get("terminalOutcomes")).size());
    }

    /** Missing owned work requires recovery, not a completed batch. */
    @Test
    void missingOwnedTaskPausesWithDurableIdentity() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.hideOwned = true;
        String runId = fixture.create(Map.of());
        Map<String, Object> status = awaitStatus(fixture.service, runId, "paused");
        Map<String, Object> result = map(maps(status.get("batches")).getFirst().get("result"));
        assertEquals(fixture.gateway.idsInCreationOrder(), result.get("missingTaskIds"));
        assertEquals(fixture.gateway.idsInCreationOrder(), map(result.get("recoveryAction")).get("taskIds"));
        verify(fixture.downloader, never()).removeTask(anyString());
    }

    /** Each approval gets bounded retries while total attempts and successful work persist. */
    @Test
    void threeAttemptsPerApprovalRetryOnlyUnresolvedWork() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.taskCount = 2;
        fixture.gateway.statusFactory = index -> index == 0 ? "failed" : "completed";
        fixture.retryCompletes = false;
        String runId = fixture.create(Map.of());
        Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
        String failedId = fixture.gateway.idsInCreationOrder().getFirst();
        Map<String, Object> before = map(maps(paused.get("batches")).getFirst().get("result"));
        assertEquals(3, number(map(before.get("attempts")).get(failedId)));
        assertEquals(List.of(failedId), before.get("failedTaskIds"));
        assertEquals(1, number(map(paused.get("summary")).get("completedTitleTaskCount")));
        fixture.retryCompletes = true;
        fixture.service.resumeRun(runId, String.valueOf(paused.get("approvalId")), "discord:decision:retry");
        Map<String, Object> completed = awaitStatus(fixture.service, runId, "completed");
        Map<String, Object> after = map(maps(completed.get("batches")).getFirst().get("result"));
        assertEquals(4, number(map(after.get("attempts")).get(failedId)));
        assertEquals(1, number(map(after.get("approvalAttempts")).get(failedId)));
        verify(fixture.downloader, times(3)).retryBulkTask(eq(failedId), anyString(), anyString(), anyString(), anyInt(), anyInt(), anyInt());
        verify(fixture.downloader, never()).retryBulkTask(eq(fixture.gateway.idsInCreationOrder().getLast()), anyString(), anyString(), anyString(), anyInt(), anyInt(), anyInt());
        verify(fixture.downloader, never()).removeTask(anyString());
        assertEquals(1, fixture.gateway.discoveryCalls.get());
    }

    /** A durable accepted retry must restore its budget even when the parent checkpoint predates a crash. */
    @Test
    void durableChildAttemptPreventsFourthExecutionAfterParentCheckpointLoss() throws Exception {
        Fixture fixture = fixture();
        fixture.retryCompletes = false;
        String runId = fixture.create(Map.of("start", false));
        Map<String, Object> batch = map(fixture.broker.listJobTasks(runId, "").get(0));
        String batchId = String.valueOf(batch.get("taskId"));
        String taskId = "restored-owned-title";
        fixture.gateway.addOwned(runId, batchId, taskId, "failed");
        fixture.gateway.update(taskId, Map.of("details", Map.of("bulkRetryAttempt", Map.of(
            "attemptId", "accepted-before-crash", "cumulativeAttempt", 2, "approvalGeneration", 0, "approvalAttempt", 2))));
        Map<String, Object> result = map(batch.get("result"));
        result.put("taskIds", List.of(taskId));
        result.put("attempts", Map.of(taskId, 1));
        result.put("approvalAttempts", Map.of(taskId, 1));
        result.put("approvalGeneration", 0);
        batch.put("result", result);
        fixture.broker.putJobTask(runId, batchId, batch);

        fixture.service.startRun(runId);
        Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
        Map<String, Object> after = map(maps(paused.get("batches")).getFirst().get("result"));
        assertEquals(3, number(map(after.get("attempts")).get(taskId)));
        assertEquals(3, number(map(after.get("approvalAttempts")).get(taskId)));
        assertEquals(1, fixture.executedRetryIds.size());
        verify(fixture.downloader).retryBulkTask(eq(taskId), eq(runId), eq(batchId), anyString(), eq(3), eq(0), eq(3));
    }

    /** A lost retry response after execution cannot leave an uncounted extra execution allowance. */
    @Test
    void acceptedRetryWithLostResponseStillStopsAtThreeAttempts() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.statusFactory = index -> "failed";
        fixture.retryCompletes = false;
        fixture.loseNextRetryResponse = true;
        String runId = fixture.create(Map.of());

        Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
        String taskId = fixture.gateway.idsInCreationOrder().getFirst();
        Map<String, Object> result = map(maps(paused.get("batches")).getFirst().get("result"));
        assertEquals(3, number(map(result.get("attempts")).get(taskId)));
        assertEquals(3, number(map(result.get("approvalAttempts")).get(taskId)));
        assertEquals(2, fixture.executedRetryIds.size());
    }

    /** A persisted queued retry whose response was lost before dispatch is reattached with the same identity. */
    @Test
    void acceptedRetryBeforeSubmitIsReattachedWithoutSpendingAnotherAttempt() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.statusFactory = index -> "failed";
        fixture.retryCompletes = false;
        fixture.loseBeforeSubmit = true;
        String runId = fixture.create(Map.of());

        Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
        String taskId = fixture.gateway.idsInCreationOrder().getFirst();
        Map<String, Object> result = map(maps(paused.get("batches")).getFirst().get("result"));
        assertEquals(3, number(map(result.get("attempts")).get(taskId)));
        assertEquals(2, fixture.executedRetryIds.size());
        assertEquals(3, fixture.requestedRetryIds.size());
        assertEquals(fixture.requestedRetryIds.get(0), fixture.requestedRetryIds.get(1));
        assertNotEquals(fixture.requestedRetryIds.get(1), fixture.requestedRetryIds.get(2));
    }

    /** Lifecycle recovery must attach an accepted queued retry even when the previous worker saved no failure marker. */
    @Test
    void newlyObservedQueuedReceiptReattachesWithoutPriorFailureMarker() throws Exception {
        Fixture fixture = fixture();
        fixture.retryCompletes = false;
        String runId = seedQueuedRetryBeforeDispatch(fixture);

        fixture.service.startRun(runId);
        Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
        Map<String, Object> result = map(maps(paused.get("batches")).getFirst().get("result"));
        assertEquals(3, number(map(result.get("attempts")).get("queued-owned-title")));
        assertEquals(3, number(map(result.get("approvalAttempts")).get("queued-owned-title")));
        assertEquals(2, fixture.executedRetryIds.size());
        assertEquals("accepted-before-submit", fixture.requestedRetryIds.getFirst());
        assertEquals(2, fixture.requestedRetryIds.size());
    }

    /** A failed orphan reattachment remains actionable after its counters were reconciled and the owner continues. */
    @Test
    void failedQueuedReceiptReattachmentKeepsRecoveryEvidenceForContinue() throws Exception {
        Fixture fixture = fixture();
        fixture.rejectNextRetry = true;
        String runId = seedQueuedRetryBeforeDispatch(fixture);

        fixture.service.startRun(runId);
        Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
        Map<String, Object> result = map(maps(paused.get("batches")).getFirst().get("result"));
        assertEquals(2, number(map(result.get("attempts")).get("queued-owned-title")));
        assertTrue(map(result.get("retryBlockedSince")).containsKey("queued-owned-title"));
        assertEquals(0, fixture.executedRetryIds.size());

        fixture.service.resumeRun(runId, String.valueOf(paused.get("approvalId")), "discord:decision:reattach");
        awaitStatus(fixture.service, runId, "completed");
        assertEquals(1, fixture.executedRetryIds.size());
        assertEquals(List.of("accepted-before-submit", "accepted-before-submit"), fixture.requestedRetryIds);
    }

    /** A definite winding-down rejection spends no execution allowance and keeps the proposed attempt stable. */
    @Test
    void definiteRetryRejectionDoesNotConsumeAnAttempt() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.statusFactory = index -> "failed";
        fixture.retryCompletes = false;
        fixture.rejectNextRetry = true;
        String runId = fixture.create(Map.of());

        Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
        String taskId = fixture.gateway.idsInCreationOrder().getFirst();
        Map<String, Object> result = map(maps(paused.get("batches")).getFirst().get("result"));
        assertEquals(3, number(map(result.get("attempts")).get(taskId)));
        assertEquals(2, fixture.executedRetryIds.size());
        assertEquals(3, fixture.requestedRetryIds.size());
        assertEquals(fixture.requestedRetryIds.get(0), fixture.requestedRetryIds.get(1));
    }

    /** Seeing an unchanged old receipt cannot reset the bounded wait for a rejected later retry. */
    @Test
    void priorAcceptedReceiptDoesNotResetExpiredWindingDownDeadline() throws Exception {
        Fixture fixture = fixture();
        fixture.retryCompletes = false;
        fixture.rejectNextRetry = true;
        String runId = fixture.create(Map.of("start", false));
        Map<String, Object> batch = map(fixture.broker.listJobTasks(runId, "").get(0));
        String batchId = String.valueOf(batch.get("taskId"));
        String taskId = "winding-down-owned-title";
        fixture.gateway.addOwned(runId, batchId, taskId, "failed");
        fixture.gateway.update(taskId, Map.of("details", Map.of("bulkRetryAttempt", Map.of(
            "attemptId", "prior-accepted-attempt", "cumulativeAttempt", 2, "approvalGeneration", 0, "approvalAttempt", 2))));
        Map<String, Object> result = map(batch.get("result"));
        result.put("taskIds", List.of(taskId));
        result.put("attempts", Map.of(taskId, 2));
        result.put("approvalAttempts", Map.of(taskId, 2));
        result.put("approvalGeneration", 0);
        result.put("retryBlockedSince", Map.of(taskId, NOW.minus(Duration.ofDays(1)).toString()));
        batch.put("result", result);
        fixture.broker.putJobTask(runId, batchId, batch);

        fixture.service.startRun(runId);
        Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
        Map<String, Object> after = map(maps(paused.get("batches")).getFirst().get("result"));
        assertEquals(2, number(map(after.get("attempts")).get(taskId)));
        assertEquals(2, number(map(after.get("approvalAttempts")).get(taskId)));
        assertEquals(0, fixture.executedRetryIds.size());
        assertEquals(1, fixture.requestedRetryIds.size());
    }

    /** A browse error after a successful page remains explicitly incomplete. */
    @Test
    void partialBrowseFailureCannotBecomeEmptyCompletion() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.queueAction = (runId, batchId, cancelled, checkpoint) -> {
            throw new BulkDiscoveryException("browse_failed", "Second browse page failed.", 1, null);
        };
        String runId = fixture.create(Map.of());
        Map<String, Object> status = awaitStatus(fixture.service, runId, "paused");
        Map<String, Object> result = map(maps(status.get("batches")).getFirst().get("result"));
        assertEquals(false, result.get("discoveryComplete"));
        assertEquals(1, number(result.get("pagesScanned")));
        assertEquals("browse_failed", result.get("errorCode"));
        assertEquals(0, number(map(status.get("summary")).get("completedBatches")));
    }

    /** A title failing before queue creation retains its stable plan identity. */
    @Test
    void prequeueFailurePausesWithItsPlanIdentity() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.queueAction = (runId, batchId, cancelled, checkpoint) -> {
            checkpoint.accept(Map.of("unresolvedPlanIds", List.of("plan_failed"), "discoveryComplete", true));
            return result("Manhua", false, "T", List.of(), 1);
        };
        String runId = fixture.create(Map.of());
        Map<String, Object> status = awaitStatus(fixture.service, runId, "paused");
        Map<String, Object> batch = maps(status.get("batches")).getFirst();
        assertEquals(List.of("plan_failed"), map(map(batch.get("result")).get("recoveryAction")).get("planIds"));
        assertTrue(number(batch.get("percent")) < 100);
    }

    /** A genuinely complete scan without matching titles is valid completion. */
    @Test
    void genuineEmptyDiscoveryCompletesWithoutOwnedWork() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.taskCount = 0;
        String runId = fixture.create(Map.of());
        Map<String, Object> status = awaitStatus(fixture.service, runId, "completed");
        assertEquals(0, number(map(status.get("summary")).get("queuedCount")));
        assertEquals(1, number(map(status.get("summary")).get("completedBatches")));
    }

    /** Generic plans cannot inflate batch counts or consume approval allowances. */
    @Test
    void ownedPlanTasksAreExcludedFromTheBatchManifest() {
        Fixture fixture = fixture();
        String runId = fixture.create(Map.of("start", false));
        fixture.broker.putJobTask(runId, "plan1", Map.of("taskId", "plan1", "status", "queued", "payload", Map.of("kind", "bulk-title-plan")));
        fixture.broker.putJobTask(runId, "discovery1", Map.of("taskId", "discovery1", "status", "running", "payload", Map.of("kind", "bulk-discovery-plan")));
        assertEquals(1, maps(fixture.service.status(runId).get("batches")).size());
        assertEquals(1, number(map(fixture.service.status(runId).get("summary")).get("totalBatches")));
    }

    /** Same-action replays return their original receipt even after a newer pause. */
    @Test
    void consumedApprovalReceiptSurvivesLaterWindows() throws Exception {
        Fixture fixture = fixture();
        String runId = fixture.create(Map.of("type", "all", "groupsize", 1));
        Map<String, Object> first = awaitStatus(fixture.service, runId, "paused");
        String token = String.valueOf(first.get("approvalId"));
        Map<String, Object> accepted = fixture.service.resumeRun(runId, token, "discord:decision:once");
        Map<String, Object> second = awaitStatus(fixture.service, runId, "paused");
        assertNotEquals(token, second.get("approvalId"));
        int calls = fixture.gateway.queueCalls.get();
        assertEquals(JSON.writeValueAsString(accepted), JSON.writeValueAsString(
            fixture.service.resumeRun(runId, token, "discord:decision:once")));
        assertThrows(BulkRunConflictException.class, () -> fixture.service.cancelRun(runId, token, "discord:decision:opposite"));
        assertThrows(BulkRunConflictException.class, () -> fixture.service.resumeRun(runId, "approval_unknown", "discord:decision:stale"));
        assertEquals(calls, fixture.gateway.queueCalls.get());
        assertFalse(map(accepted.get("filters")).containsKey("decisionReceipts"));
        assertFalse(accepted.containsKey("batches"));
        assertFalse(map(accepted.get("summary")).containsKey("queuedTaskIds"));
        assertFalse(map(accepted.get("summary")).containsKey("recoveryActions"));
        assertEquals(1, number(map(accepted.get("summary")).get("completedTitleTaskCount")));
        assertTrue(map(fixture.service.status(runId).get("summary")).containsKey("queuedTaskIds"));
        fixture.service.shutdown();
        Fixture restarted = fixture(fixture.broker, new TestGateway());
        assertEquals(JSON.writeValueAsString(accepted), JSON.writeValueAsString(
            restarted.service.resumeRun(runId, token, "discord:decision:once")));
        assertEquals(0, restarted.gateway.queueCalls.get());
    }

    /** Fresh active cancellation works without accepting a delayed opposite reaction. */
    @Test
    void activeCancelUsesTheNewStateToken() throws Exception {
        Fixture fixture = fixture();
        String runId = fixture.create(Map.of("type", "all", "groupsize", 1));
        Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
        fixture.gateway.hold = true;
        String old = String.valueOf(paused.get("approvalId"));
        Map<String, Object> accepted = fixture.service.resumeRun(runId, old, "discord:decision:continue");
        assertThrows(BulkRunConflictException.class, () -> fixture.service.cancelRun(runId, old, "discord:decision:late-cancel"));
        Map<String, Object> cancelled = fixture.service.cancelRun(runId, String.valueOf(accepted.get("approvalId")), "discord:decision:stop");
        assertEquals("cancelled", cancelled.get("status"));
        assertEquals(JSON.writeValueAsString(accepted), JSON.writeValueAsString(
            fixture.service.resumeRun(runId, old, "discord:decision:continue")));
    }

    /** Concurrent opposite reactions consume one token exactly once. */
    @Test
    void concurrentOppositeDecisionsHaveOneWinner() throws Exception {
        Fixture fixture = fixture();
        String runId = fixture.create(Map.of("type", "all", "groupsize", 1));
        String token = String.valueOf(awaitStatus(fixture.service, runId, "paused").get("approvalId"));
        fixture.gateway.hold = true;
        AtomicInteger accepted = new AtomicInteger();
        AtomicInteger conflicts = new AtomicInteger();
        CompletableFuture<Void> yes = CompletableFuture.runAsync(() -> decide(fixture, runId, token, true, accepted, conflicts));
        CompletableFuture<Void> no = CompletableFuture.runAsync(() -> decide(fixture, runId, token, false, accepted, conflicts));
        CompletableFuture.allOf(yes, no).get(5, TimeUnit.SECONDS);
        assertEquals(1, accepted.get());
        assertEquals(1, conflicts.get());
        fixture.service.cancelRun(runId);
    }

    /** A cancelled worker awaiting another run cannot resurrect when its turn arrives. */
    @Test
    void cancellationBeforeWorkerStartsIsTerminal() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.hold = true;
        String first = fixture.create(Map.of("requestId", "first"));
        await(() -> fixture.gateway.queueCalls.get() == 1);
        String second = fixture.create(Map.of("requestId", "second"));
        fixture.service.cancelRun(second);
        fixture.gateway.hold = false;
        awaitStatus(fixture.service, first, "completed");
        await(() -> !(Boolean) fixture.service.status(second).get("active"));
        assertEquals("cancelled", fixture.service.status(second).get("status"));
        assertEquals(1, fixture.gateway.queueCalls.get());
    }

    /** Cancellation reaches plans whose summary checkpoint never completed. */
    @Test
    void partialDiscoveryCancellationUsesDurableOwnership() throws Exception {
        Fixture fixture = fixture();
        CountDownLatch planned = new CountDownLatch(1);
        fixture.gateway.queueAction = (runId, batchId, cancelled, checkpoint) -> {
            fixture.gateway.addOwned(runId, batchId, "uncheckpointed", "queued");
            planned.countDown();
            while (!cancelled.getAsBoolean()) {
                Thread.onSpinWait();
            }
            throw new CancellationException();
        };
        String runId = fixture.create(Map.of());
        assertTrue(planned.await(5, TimeUnit.SECONDS));
        fixture.service.cancelRun(runId);
        await(() -> !(Boolean) fixture.service.status(runId).get("active"));
        assertTrue(fixture.gateway.cancelledTasks.contains("uncheckpointed"));
        assertEquals("cancelled", fixture.service.status(runId).get("status"));
    }

    /** Restarting a worker cannot grant another batch in the same approval window. */
    @Test
    void approvalBatchBudgetSurvivesRestart() throws Exception {
        Fixture fixture = fixture();
        String runId = fixture.create(Map.of("type", "all", "groupsize", 1));
        awaitStatus(fixture.service, runId, "paused");
        fixture.service.shutdown();
        fixture.broker.setStatus(runId, "running");
        Map<String, Object> interruptedJob = fixture.broker.job(runId);
        Map<String, Object> interruptedPayload = map(interruptedJob.get("payload"));
        interruptedPayload.put("approvalBatchCount", 0);
        interruptedJob.put("payload", interruptedPayload);
        fixture.broker.putJob(runId, interruptedJob);
        Fixture restarted = fixture(fixture.broker, new TestGateway());
        restarted.service.reconcileInterruptedRuns();
        awaitStatus(restarted.service, runId, "paused");
        assertEquals(0, restarted.gateway.queueCalls.get());
    }

    /** Existing explicit internal callers need not add a new decision body. */
    @Test
    void legacyManualMethodsRemainCompatible() throws Exception {
        Fixture fixture = fixture();
        String runId = fixture.create(Map.of("type", "all", "groupsize", 1));
        awaitStatus(fixture.service, runId, "paused");
        fixture.service.resumeRun(runId);
        awaitStatus(fixture.service, runId, "paused");
        fixture.service.cancelRun(runId);
        assertEquals("cancelled", fixture.service.status(runId).get("status"));
    }

    /** Start intent survives a creation crash before all batch rows are durable. */
    @Test
    void recoveryRepairsPartiallyCreatedStartedRunBeforeDispatch() throws Exception {
        Fixture fixture = fixture();
        fixture.broker.writesUntilFailure = 1;
        assertThrows(IllegalStateException.class, () -> fixture.create(Map.of("requestId", "partial-start", "type", "all")));
        String runId = BulkRunIdentity.runId("partial-start");
        assertEquals(true, map(fixture.broker.job(runId).get("payload")).get("startRequested"));
        assertEquals(0, fixture.gateway.queueCalls.get());
        fixture.service.shutdown();
        Fixture restarted = fixture(fixture.broker, new TestGateway());
        restarted.service.reconcileInterruptedRuns();
        Map<String, Object> completed = awaitStatus(restarted.service, runId, "completed");
        assertEquals(4, number(map(completed.get("summary")).get("completedBatches")));
        assertEquals(4, restarted.gateway.queueCalls.get());
    }

    /** Failed terminal checkpointing pauses without discarding successfully owned work. */
    @Test
    void brokerCheckpointFailurePausesAndContinuesWithoutRedownloadingSuccess() throws Exception {
        Fixture fixture = fixture();
        fixture.broker.failCompletedWrite = true;
        String runId = fixture.create(Map.of());
        Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
        assertTrue(String.valueOf(paused.get("message")).contains("persist a durable bulk-run batch"));
        assertEquals(1, fixture.gateway.idsInCreationOrder().size());
        fixture.service.resumeRun(runId, String.valueOf(paused.get("approvalId")), "checkpoint-retry");
        awaitStatus(fixture.service, runId, "completed");
        assertEquals(1, fixture.gateway.discoveryCalls.get());
        verify(fixture.downloader, never()).removeTask(anyString());
        verify(fixture.downloader, never()).retryTask(anyString());
    }

    /** Concurrent HTTP creation replays cannot create multiple jobs or workers. */
    @Test
    void concurrentCreationKeyReplaysHaveOneDurableIdentity() throws Exception {
        Fixture fixture = fixture();
        Map<String, Object> request = Map.of("requestId", "concurrent-create", "start", false);
        CompletableFuture<String> first = CompletableFuture.supplyAsync(() -> fixture.create(request));
        CompletableFuture<String> second = CompletableFuture.supplyAsync(() -> fixture.create(request));
        assertEquals(first.get(5, TimeUnit.SECONDS), second.get(5, TimeUnit.SECONDS));
        assertEquals(1, fixture.broker.jobs.size());
        assertEquals(1, fixture.broker.batches.values().stream().mapToInt(Map::size).sum());
        assertEquals(0, fixture.gateway.queueCalls.get());
    }

    /** A late checkpoint cannot leave a running batch under a cancelled parent. */
    @Test
    void cancelledWorkerFinalizesCheckpointThatCrossedItsCancellation() throws Exception {
        Fixture fixture = fixture();
        CountDownLatch blocked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        fixture.broker.checkpointBlocked = blocked;
        fixture.broker.checkpointRelease = release;
        fixture.gateway.queueAction = (runId, batchId, cancelled, checkpoint) -> {
            fixture.gateway.addOwned(runId, batchId, "racy-owned", "queued");
            checkpoint.accept(Map.of("stage", "racy", "taskIds", List.of("racy-owned"), "discoveryComplete", true));
            return result("Manhua", false, "T", List.of("racy-owned"), 0);
        };
        String runId = fixture.create(Map.of());
        assertTrue(blocked.await(5, TimeUnit.SECONDS));
        fixture.service.cancelRun(runId);
        release.countDown();
        await(() -> !(Boolean) fixture.service.status(runId).get("active")
            && "cancelled".equals(maps(fixture.service.status(runId).get("batches")).getFirst().get("status"))
            && Boolean.FALSE.equals(map(fixture.broker.job(runId).get("payload")).get("cancellationPending")));
        assertEquals("cancelled", fixture.service.status(runId).get("status"));
    }

    /** Uncommitted task persistence is not completion or ordinary queue wait. */
    @Test
    void taskPersistenceDiagnosticPausesBeforeTrustingItsStatus() throws Exception {
        Fixture fixture = fixture();
        fixture.gateway.queueAction = (runId, batchId, cancelled, checkpoint) -> {
            fixture.gateway.addOwned(runId, batchId, "write-failed", "completed");
            fixture.gateway.update("write-failed", Map.of("persistenceError", "Durable write failed."));
            checkpoint.accept(Map.of("taskIds", List.of("write-failed"), "discoveryComplete", true));
            return result("Manhua", false, "T", List.of("write-failed"), 0);
        };
        String runId = fixture.create(Map.of());
        Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
        assertEquals(0, number(map(paused.get("summary")).get("completedTitleTaskCount")));
        assertEquals(List.of("write-failed"), map(maps(paused.get("batches")).getFirst().get("result")).get("failedTaskIds"));
    }

    /** Unexpected terminal identities cannot be ignored indefinitely or counted as success. */
    @Test
    void cancelledSupersededAndUnknownStatusesPauseForReconciliation() throws Exception {
        for (String status : List.of("cancelled", "superseded", "unknown", "")) {
            Fixture fixture = fixture();
            fixture.gateway.statusFactory = index -> status;
            String runId = fixture.create(Map.of());
            Map<String, Object> paused = awaitStatus(fixture.service, runId, "paused");
            assertEquals(1, number(map(paused.get("summary")).get("failedTitleTaskCount")));
            verify(fixture.downloader, never()).removeTask(anyString());
        }
    }

    private void decide(Fixture fixture, String runId, String token, boolean yes, AtomicInteger accepted, AtomicInteger conflicts) {
        try {
            if (yes) {
                fixture.service.resumeRun(runId, token, "concurrent-yes");
            } else {
                fixture.service.cancelRun(runId, token, "concurrent-no");
            }
            accepted.incrementAndGet();
        } catch (BulkRunConflictException conflict) {
            conflicts.incrementAndGet();
        }
    }

    private Fixture fixture() {
        return fixture(new TestBroker(), new TestGateway());
    }

    private String seedQueuedRetryBeforeDispatch(Fixture fixture) {
        String runId = fixture.create(Map.of("start", false));
        Map<String, Object> batch = map(fixture.broker.listJobTasks(runId, "").get(0));
        String batchId = String.valueOf(batch.get("taskId"));
        String taskId = "queued-owned-title";
        fixture.gateway.addOwned(runId, batchId, taskId, "queued");
        fixture.gateway.update(taskId, Map.of("details", Map.of("bulkRetryAttempt", Map.of(
            "attemptId", "accepted-before-submit", "cumulativeAttempt", 2, "approvalGeneration", 0, "approvalAttempt", 2))));
        Map<String, Object> result = map(batch.get("result"));
        result.put("taskIds", List.of(taskId));
        result.put("attempts", Map.of(taskId, 1));
        result.put("approvalAttempts", Map.of(taskId, 1));
        result.put("approvalGeneration", 0);
        batch.put("result", result);
        fixture.broker.putJobTask(runId, batchId, batch);
        return runId;
    }

    private Fixture fixture(TestBroker broker, TestGateway gateway) {
        Fixture fixture = new Fixture(broker, gateway);
        services.add(fixture.service);
        return fixture;
    }

    private static Map<String, Object> awaitStatus(BulkRunService service, String runId, String status) throws Exception {
        await(() -> status.equals(service.status(runId).get("status")));
        return service.status(runId);
    }

    private static void await(BooleanSupplier ready) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(8).toNanos();
        while (System.nanoTime() < deadline) {
            if (ready.getAsBoolean()) {
                return;
            }
            TimeUnit.MILLISECONDS.sleep(5);
        }
        assertTrue(ready.getAsBoolean(), "Expected durable state was not reached.");
    }

    private static Map<String, Object> map(Object value) {
        return JSON.convertValue(value, new TypeReference<LinkedHashMap<String, Object>>() { });
    }

    private static List<Map<String, Object>> maps(Object value) {
        return JSON.convertValue(value, new TypeReference<List<Map<String, Object>>>() { });
    }

    private static int number(Object value) {
        return value == null ? 0 : ((Number) value).intValue();
    }

    private static BulkQueueDownloadResult result(String type, boolean nsfw, String prefix, List<String> ids, int failures) {
        return new BulkQueueDownloadResult(failures > 0 ? "partial" : "queued", "Fixture discovery.",
            new BulkQueueDownloadResult.Filters(type, nsfw, prefix), 1, ids.size() + failures, ids.size(), 0, 0, 0, 0, failures,
            ids, ids, List.of(), List.of(), List.of(), List.of(), failures > 0 ? List.of("Failed title") : List.of());
    }

    /** Fixture keeps durable maps independent from the downloader's UI history. */
    private static final class Fixture {
        private final TestBroker broker;
        private final TestGateway gateway;
        private final DownloaderService downloader = mock(DownloaderService.class);
        private final BulkRunService service;
        private volatile boolean retryCompletes = true;
        private volatile boolean loseNextRetryResponse;
        private volatile boolean loseBeforeSubmit;
        private volatile boolean rejectNextRetry;
        private final Set<String> executedRetryIds = ConcurrentHashMap.newKeySet();
        private final List<String> requestedRetryIds = new ArrayList<>();

        private Fixture(TestBroker broker, TestGateway gateway) {
            this.broker = broker;
            this.gateway = gateway;
            service = new BulkRunService(downloader, broker, mock(ScriptarrLogger.class), gateway,
                Clock.fixed(NOW, ZoneOffset.UTC), Duration.ofMillis(5));
            doAnswer(invocation -> {
                String id = invocation.getArgument(0);
                String attemptId = invocation.getArgument(3);
                requestedRetryIds.add(attemptId);
                if (rejectNextRetry) {
                    rejectNextRetry = false;
                    throw new BulkRetryBlockedException("The prior execution is still winding down.");
                }
                Map<String, Object> previous = gateway.tasks.get(id);
                Map<String, Object> receipt = previous != null && previous.containsKey("details")
                    ? map(map(previous.get("details")).getOrDefault("bulkRetryAttempt", Map.of())) : Map.of();
                if (!attemptId.equals(receipt.get("attemptId"))) {
                    receipt = Map.of("attemptId", attemptId, "cumulativeAttempt", invocation.getArgument(4),
                        "approvalGeneration", invocation.getArgument(5), "approvalAttempt", invocation.getArgument(6));
                    gateway.update(id, Map.of("status", "queued", "details", Map.of("bulkRetryAttempt", receipt)));
                    if (loseBeforeSubmit) {
                        loseBeforeSubmit = false;
                        throw new IllegalStateException("Accepted durable retry, but its response was lost before submit.");
                    }
                }
                if ("queued".equals(gateway.tasks.get(id).get("status")) && executedRetryIds.add(attemptId)) {
                    gateway.update(id, Map.of("status", retryCompletes ? "completed" : "failed", "updatedAt", NOW.toString()));
                }
                if (loseNextRetryResponse) {
                    loseNextRetryResponse = false;
                    throw new IllegalStateException("Accepted retry response was lost.");
                }
                return gateway.tasks.get(id);
            }).when(downloader).retryBulkTask(anyString(), anyString(), anyString(), anyString(), anyInt(), anyInt(), anyInt());
            doAnswer(invocation -> {
                String id = invocation.getArgument(0);
                gateway.update(id, Map.of("status", "failed", "message", "Cancelled by admin."));
                return gateway.tasks.get(id);
            }).when(downloader).cancelTask(anyString());
        }

        private String create(Map<String, Object> overrides) {
            Map<String, Object> request = new LinkedHashMap<>(Map.of("type", "Manhua", "titlegroup", "T", "nsfw", false,
                "groupsize", 20, "requestedBy", "owner-1"));
            request.putAll(overrides);
            return String.valueOf(service.createRun(request).get("runId"));
        }
    }

    /** Thread-safe broker supports concurrent worker and HTTP-request observations. */
    private static final class TestBroker extends FakeRavenBrokerClient {
        private final Map<String, JsonNode> jobs = new LinkedHashMap<>();
        private final Map<String, Map<String, JsonNode>> batches = new LinkedHashMap<>();
        private int jobWrites;
        private int taskWrites;
        private int writesUntilFailure = -1;
        private boolean failCompletedWrite;
        private volatile CountDownLatch checkpointBlocked;
        private CountDownLatch checkpointRelease;

        @Override
        public synchronized JsonNode listJobs(String owner, String kind, String status) {
            return JSON.valueToTree(jobs.values().stream().filter(job -> status == null || status.isBlank()
                || status.equals(job.path("status").asText())).toList());
        }

        @Override
        public synchronized JsonNode putJob(String id, Map<String, Object> value) {
            jobWrites++;
            jobs.put(id, JSON.valueToTree(value));
            return jobs.get(id);
        }

        @Override
        public synchronized JsonNode listJobTasks(String id, String status) {
            return JSON.valueToTree(batches.getOrDefault(id, Map.of()).values().stream()
                .filter(task -> status == null || status.isBlank() || status.equals(task.path("status").asText())).toList());
        }

        @Override
        public JsonNode putJobTask(String id, String taskId, Map<String, Object> value) {
            if (checkpointBlocked != null && "running".equals(value.get("status"))
                && value.get("result") instanceof Map<?, ?> result && "racy".equals(result.get("stage"))) {
                CountDownLatch blocked = checkpointBlocked;
                checkpointBlocked = null;
                blocked.countDown();
                try {
                    if (!checkpointRelease.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("Checkpoint race test did not release its worker.");
                    }
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
            }
            synchronized (this) {
            if (writesUntilFailure == 0 || (failCompletedWrite && "completed".equals(value.get("status")))) {
                writesUntilFailure = -1;
                failCompletedWrite = false;
                throw new IllegalStateException("Simulated durable checkpoint failure.");
            }
            if (writesUntilFailure > 0) {
                writesUntilFailure--;
            }
            taskWrites++;
            batches.computeIfAbsent(id, ignored -> new LinkedHashMap<>()).put(taskId, JSON.valueToTree(value));
            return batches.get(id).get(taskId);
            }
        }

        private synchronized Map<String, Object> job(String id) {
            return map(jobs.get(id));
        }

        private synchronized void setStatus(String id, String status) {
            Map<String, Object> value = job(id);
            value.put("status", status);
            putJob(id, value);
        }

        private synchronized void deleteBatch(String runId, String batchId) {
            batches.get(runId).remove(batchId);
        }
    }

    /** Minimal durable gateway with controllable discovery and task outcomes. */
    private static final class TestGateway implements BulkRunGateway {
        private CompletableFuture<Void> restored = CompletableFuture.completedFuture(null);
        private final Map<String, Map<String, Object>> tasks = new ConcurrentHashMap<>();
        private final Map<String, List<String>> batchIds = new ConcurrentHashMap<>();
        private final Map<String, String> batchRuns = new ConcurrentHashMap<>();
        private final Set<String> cancelledTasks = ConcurrentHashMap.newKeySet();
        private final AtomicInteger queueCalls = new AtomicInteger();
        private final AtomicInteger ownedCalls = new AtomicInteger();
        private final AtomicInteger discoveryCalls = new AtomicInteger();
        private int taskCount = 1;
        private IntFunction<String> statusFactory = index -> "completed";
        private Instant progressAt = NOW;
        private volatile boolean hold;
        private boolean hideOwned;
        private QueueAction queueAction;

        @Override
        public CompletableFuture<Void> restoreCompletion() {
            return restored;
        }

        @Override
        public BulkQueueDownloadResult queueBatch(String runId, String batchId, String provider, String type,
            boolean nsfw, String prefix, String actor, BooleanSupplier cancelled, Consumer<Map<String, Object>> checkpoint) {
            queueCalls.incrementAndGet();
            while (hold) {
                if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) {
                    throw new CancellationException();
                }
                java.util.concurrent.locks.LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
            }
            if (queueAction != null) {
                return queueAction.queue(runId, batchId, cancelled, checkpoint);
            }
            if (!batchIds.containsKey(batchId)) {
                discoveryCalls.incrementAndGet();
                batchRuns.put(batchId, runId);
                List<String> ids = new ArrayList<>();
                for (int index = 0; index < taskCount; index++) {
                    String id = batchId + "_title_" + index;
                    ids.add(id);
                    tasks.put(id, Map.of("taskId", id, "status", statusFactory.apply(index), "queuedAt", progressAt.toString(),
                        "updatedAt", progressAt.toString(), "actualProgressAt", progressAt.toString(), "stage", "downloading"));
                }
                batchIds.put(batchId, ids);
            }
            List<String> ids = batchIds.get(batchId);
            checkpoint.accept(Map.of("taskIds", ids, "discoveryComplete", true, "unresolvedPlanIds", List.of()));
            return result(type, nsfw, prefix, ids, 0);
        }

        @Override
        public List<Map<String, Object>> ownedTasks(String runId, String batchId) {
            ownedCalls.incrementAndGet();
            if (hideOwned) {
                return List.of();
            }
            if (batchId.isBlank()) return batchRuns.entrySet().stream().filter(entry -> runId.equals(entry.getValue()))
                .flatMap(entry -> batchIds.getOrDefault(entry.getKey(), List.of()).stream()).map(tasks::get).filter(java.util.Objects::nonNull).toList();
            return batchIds.getOrDefault(batchId, List.of()).stream().map(tasks::get).filter(java.util.Objects::nonNull).toList();
        }

        @Override
        public void cancelRun(String runId) {
            batchRuns.forEach((batch, owner) -> {
                if (owner.equals(runId)) {
                    cancelledTasks.addAll(batchIds.getOrDefault(batch, List.of()));
                }
            });
        }

        private List<String> idsInCreationOrder() {
            return batchIds.values().stream().flatMap(List::stream).toList();
        }

        private List<String> ids() {
            return idsInCreationOrder();
        }

        private void update(String id, Map<String, Object> changes) {
            tasks.computeIfPresent(id, (key, current) -> {
                Map<String, Object> next = new LinkedHashMap<>(current);
                next.putAll(changes);
                return next;
            });
        }

        private void addOwned(String runId, String batchId, String id, String status) {
            batchRuns.put(batchId, runId);
            batchIds.put(batchId, List.of(id));
            tasks.put(id, Map.of("taskId", id, "status", status, "bulkBatchId", batchId));
        }
    }

    /** Custom discovery barrier for cancellation and transport-failure tests. */
    private interface QueueAction {
        /**
         * Execute one controlled test discovery.
         *
         * @param runId owner run
         * @param batchId owner batch
         * @param cancelled cancellation predicate
         * @param checkpoint durable checkpoint callback
         * @return queue result
         */
        BulkQueueDownloadResult queue(String runId, String batchId, BooleanSupplier cancelled,
                                     Consumer<Map<String, Object>> checkpoint);
    }
}
