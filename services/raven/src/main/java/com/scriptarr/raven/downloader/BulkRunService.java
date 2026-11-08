package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Durable owner-only bulk downloadall run orchestration for Raven.
 */
@Service
public class BulkRunService {
    private static final String OWNER_SERVICE = "scriptarr-raven";
    private static final String RUN_JOB_KIND = "raven-bulk-downloadall";
    private static final String PROVIDER_ID = "weebcentral";
    private static final String STATUS_QUEUED = "queued";
    private static final String STATUS_RUNNING = "running";
    private static final String STATUS_PAUSED = "paused";
    private static final String STATUS_COMPLETED = "completed";
    private static final String STATUS_FAILED = "failed";
    private static final String STATUS_CANCELLED = "cancelled";
    private static final int MAX_TITLE_ATTEMPTS = 3;
    private static final int DEFAULT_BATCHES_PER_APPROVAL = 1;
    private static final int MAX_BATCHES_PER_APPROVAL = 25;
    private static final Duration POLL_DELAY = Duration.ofSeconds(2);
    private static final Duration TITLE_PROGRESS_TIMEOUT = Duration.ofMinutes(45);
    private static final Duration RETRY_WIND_DOWN_TIMEOUT = Duration.ofMinutes(2);
    private static final List<String> BULK_TYPES = List.of("Manga", "Manhwa", "Manhua", "OEL");
    private static final List<String> TITLE_GROUPS = List.of(
        "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
        "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"
    );

    private final DownloaderService downloaderService;
    private final RavenBrokerClient brokerClient;
    private final ScriptarrLogger logger;
    private final BulkRunGateway gateway;
    private final Clock clock;
    private final Duration pollDelay;
    private final ScheduledExecutorService recoveryWorker = Executors.newSingleThreadScheduledExecutor((runnable) -> {
        Thread thread = new Thread(runnable, "raven-bulk-recovery");
        thread.setDaemon(true);
        return thread;
    });
    private final AtomicBoolean recoveryStarted = new AtomicBoolean();
    private final ExecutorService worker = Executors.newSingleThreadExecutor((runnable) -> {
        Thread thread = new Thread(runnable, "raven-bulk-downloadall-runner");
        thread.setDaemon(true);
        return thread;
    });
    private final Set<String> activeRunIds = ConcurrentHashMap.newKeySet();
    private final Set<String> cancelledRunIds = ConcurrentHashMap.newKeySet();
    private final Set<String> pendingRunIds = ConcurrentHashMap.newKeySet();

    /**
     * Create the durable Raven bulk-run orchestrator.
     *
     * @param downloaderService existing Raven download queue service
     * @param brokerClient Sage-backed broker client for durable jobs
     * @param logger shared Raven logger
     */
    @Autowired
    public BulkRunService(DownloaderService downloaderService, RavenBrokerClient brokerClient, ScriptarrLogger logger) {
        this(downloaderService, brokerClient, logger, downloaderService.bulkRunGateway(), Clock.systemUTC(), POLL_DELAY);
    }

    /**
     * Supply deterministic time and a bulk gateway for isolated orchestration tests.
     *
     * @param downloaderService title retry and cancellation controls
     * @param brokerClient durable job storage
     * @param logger service logger
     * @param gateway durable discovery and ownership boundary
     * @param clock progress clock
     * @param pollDelay delay between title polls
     */
    BulkRunService(DownloaderService downloaderService, RavenBrokerClient brokerClient, ScriptarrLogger logger,
                   BulkRunGateway gateway, Clock clock, Duration pollDelay) {
        this.downloaderService = downloaderService;
        this.brokerClient = brokerClient;
        this.logger = logger;
        this.gateway = gateway;
        this.clock = clock;
        this.pollDelay = pollDelay;
    }

    /**
     * Create a durable bulk run and optionally start it immediately.
     *
     * @param body caller payload with type, titlegroup, requestedBy, and optional start
     * @return durable run status payload
     */
    public synchronized Map<String, Object> createRun(Map<String, Object> body) {
        Map<String, Object> request = body == null ? Map.of() : body;
        String requestedBy = firstNonBlank(stringValue(request.get("requestedBy")), "scriptarr-portal");
        String typeFilter = firstNonBlank(stringValue(request.get("type")), "all");
        String groupFilter = firstNonBlank(
            stringValue(request.get("titlegroup")),
            stringValue(request.get("titleGroup")),
            stringValue(request.get("group")),
            stringValue(request.get("titlePrefix")),
            "all"
        );
        List<String> types = resolveTypes(typeFilter);
        List<String> groups = resolveTitleGroups(groupFilter);
        boolean nsfw = booleanValue(request.get("nsfw"));
        int batchesPerApproval = resolveBatchesPerApproval(request.get("batchesPerApproval"), request.get("groupsize"));
        String requestId = BulkRunIdentity.requestId(request.get("requestId"));
        String fingerprint = BulkRunIdentity.fingerprint(normalizeRunTypeFilter(typeFilter), normalizeRunGroupFilter(groupFilter),
            nsfw, batchesPerApproval, requestedBy);
        String runId = BulkRunIdentity.runId(requestId);
        String now = now();
        Map<String, Object> existing = findRun(runId);
        if (existing != null) {
            if (!fingerprint.equals(stringValue(normalizeMap(existing.get("payload")).get("fingerprint")))) {
                throw new BulkRunConflictException("requestId was already used for different downloadall options or owner.");
            }
            repairManifest(existing);
            return status(runId);
        }

        Map<String, Object> runPayload = new LinkedHashMap<>();
        runPayload.put("providerId", PROVIDER_ID);
        runPayload.put("type", normalizeRunTypeFilter(typeFilter));
        runPayload.put("titlegroup", normalizeRunGroupFilter(groupFilter));
        runPayload.put("nsfw", nsfw);
        runPayload.put("batchCount", groups.size() * types.size());
        runPayload.put("batchesPerApproval", batchesPerApproval);
        runPayload.put("requestId", requestId);
        runPayload.put("fingerprint", fingerprint);
        runPayload.put("schemaVersion", 2);
        runPayload.put("startRequested", !Boolean.FALSE.equals(request.get("start")));
        runPayload.put("manifestComplete", false);
        runPayload.put("approvalId", newApprovalId());
        runPayload.put("approvalGeneration", 0);
        runPayload.put("approvalBatchCount", 0);
        runPayload.put("decisionReceipts", Map.of());

        Map<String, Object> job = new LinkedHashMap<>();
        job.put("jobId", runId);
        job.put("kind", RUN_JOB_KIND);
        job.put("ownerService", OWNER_SERVICE);
        job.put("status", STATUS_QUEUED);
        job.put("label", "Raven mega downloadall");
        job.put("requestedBy", requestedBy);
        job.put("payload", runPayload);
        job.put("result", emptyRunSummary(groups.size() * types.size()));
        job.put("createdAt", now);
        job.put("startedAt", null);
        job.put("finishedAt", null);
        job.put("updatedAt", now);
        putJob(runId, job);

        repairManifest(job);

        if (Boolean.FALSE.equals(request.get("start"))) {
            return status(runId);
        }
        return startRun(runId);
    }

    /**
     * Start a queued durable bulk run.
     *
     * @param runId durable bulk run id
     * @return durable run status payload
     */
    public synchronized Map<String, Object> startRun(String runId) {
        Map<String, Object> job = requireRun(runId);
        if (STATUS_PAUSED.equals(stringValue(job.get("status")))) {
            return resumeRun(runId);
        }
        if (isRunTerminal(stringValue(job.get("status")))) {
            return status(runId);
        }
        Map<String, Object> payload = new LinkedHashMap<>(normalizeMap(job.get("payload")));
        payload.put("startRequested", true);
        job.put("payload", payload);
        putJob(runId, job);
        repairManifest(job);
        tryScheduleRunWorker(runId);
        return status(runId);
    }

    /**
     * Resume or continue a non-terminal durable bulk run.
     *
     * @param runId durable bulk run id
     * @return durable run status payload
     */
    public synchronized Map<String, Object> resumeRun(String runId) {
        return decide(runId, "continue", "", "", false);
    }

    /**
     * Continue one captured approval window, idempotently across HTTP retries.
     *
     * @param runId durable run id
     * @param expectedApprovalId captured state token
     * @param requestId stable caller decision id
     * @return stable accepted receipt, or the full snapshot for legacy callers
     */
    public synchronized Map<String, Object> resumeRun(String runId, String expectedApprovalId, String requestId) {
        return decide(runId, "continue", expectedApprovalId, requestId, !stringValue(expectedApprovalId).isBlank());
    }

    /**
     * Load a deterministic durable bulk-run status response.
     *
     * @param runId durable bulk run id
     * @return durable run status payload
     */
    public Map<String, Object> status(String runId) {
        String normalizedRunId = normalizeRunId(runId);
        Map<String, Object> job = requireRun(normalizedRunId);
        List<Map<String, Object>> batches = loadBatchTasks(normalizedRunId);
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("runId", normalizedRunId);
        response.put("status", stringValue(job.get("status")));
        response.put("message", stringValue(job.get("message")));
        response.put("requestedBy", stringValue(job.get("requestedBy")));
        response.put("active", activeRunIds.contains(normalizedRunId));
        response.put("filters", publicFilters(job));
        response.put("approvalId", approvalId(job));
        response.put("recoveryReady", restoreReady());
        response.put("recoveryError", restoreFailure());
        Map<String, Object> summary = buildRunSummary(batches);
        response.put("summary", summary);
        response.put("counts", summary);
        response.put("currentBatch", currentBatchPayload(batches));
        response.put("batches", batches.stream().map(this::batchStatusPayload).toList());
        response.put("createdAt", stringValue(job.get("createdAt")));
        response.put("startedAt", stringValue(job.get("startedAt")));
        response.put("finishedAt", stringValue(job.get("finishedAt")));
        response.put("updatedAt", stringValue(job.get("updatedAt")));
        return response;
    }

    /**
     * Cancel a durable run and any queued or running run-owned title tasks.
     *
     * @param runId durable bulk run id
     * @return durable run status payload
     */
    public synchronized Map<String, Object> cancelRun(String runId) {
        return decide(runId, "cancel", "", "", false);
    }

    /**
     * Cancel a captured state without allowing an older reaction to cancel a newer window.
     *
     * @param runId durable run id
     * @param expectedApprovalId captured state token
     * @param requestId stable caller decision id
     * @return stable accepted receipt, or the full snapshot for legacy callers
     */
    public synchronized Map<String, Object> cancelRun(String runId, String expectedApprovalId, String requestId) {
        return decide(runId, "cancel", expectedApprovalId, requestId, !stringValue(expectedApprovalId).isBlank());
    }

    /**
     * Resume interrupted runs after Raven restarts. Paused runs intentionally
     * stay paused until the owner explicitly continues them.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void resumeInterruptedRuns() {
        if (recoveryStarted.compareAndSet(false, true)) {
            recoveryWorker.scheduleWithFixedDelay(this::reconcileInterruptedRuns, 0, 30, TimeUnit.SECONDS);
        }
    }

    /**
     * Reconcile only explicitly started runs after the complete downloader restore barrier.
     * Status reads never call this lifecycle operation.
     */
    public synchronized void reconcileInterruptedRuns() {
        if (!restoreReady()) {
            if (!restoreFailure().isBlank()) {
                try {
                    for (Map<String, Object> job : loadRunJobs()) {
                        String status = stringValue(job.get("status"));
                        if (STATUS_RUNNING.equals(status) || (STATUS_QUEUED.equals(status)
                            && booleanValue(normalizeMap(job.get("payload")).get("startRequested")))) {
                            updateRunStatus(job, STATUS_PAUSED, "Downloader restoration failed: " + restoreFailure(),
                                buildRunSummary(loadBatchTasks(stringValue(job.get("jobId")))));
                        }
                    }
                } catch (Exception error) {
                    logger.warn("DOWNLOAD", "Bulk recovery could not persist a restore failure.", error.getMessage());
                }
            }
            return;
        }
        try {
            for (Map<String, Object> job : loadRunJobs()) {
                String runId = stringValue(job.get("jobId"));
                String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
                Map<String, Object> payload = normalizeMap(job.get("payload"));
                if (STATUS_CANCELLED.equals(status) && booleanValue(payload.get("cancellationPending"))) {
                    finishCancellation(runId);
                } else if (STATUS_RUNNING.equals(status)
                    || (STATUS_QUEUED.equals(status) && booleanValue(payload.get("startRequested")))) {
                    repairManifest(job);
                    tryScheduleRunWorker(runId);
                }
            }
        } catch (IllegalStateException error) {
            logger.warn("DOWNLOAD", "Raven could not inspect durable bulk runs during startup.", error.getMessage());
        }
    }

    /**
     * Stop the bulk-run worker on Spring shutdown.
     */
    @PreDestroy
    public void shutdown() {
        recoveryWorker.shutdownNow();
        worker.shutdownNow();
    }

    private Map<String, Object> decide(String runId, String action, String expectedApprovalId,
                                      String decisionRequestId, boolean tokened) {
        String normalizedRunId = normalizeRunId(runId);
        Map<String, Object> job = requireRun(normalizedRunId);
        Map<String, Object> payload = new LinkedHashMap<>(normalizeMap(job.get("payload")));
        String requestId = BulkRunIdentity.requestId(decisionRequestId);
        String expected = stringValue(expectedApprovalId);
        Map<String, Object> receipts = new LinkedHashMap<>(normalizeMap(payload.get("decisionReceipts")));
        for (Map.Entry<String, Object> entry : receipts.entrySet()) {
            Map<String, Object> receipt = normalizeMap(entry.getValue());
            if ((!expected.isBlank() && expected.equals(entry.getKey()))
                || (!requestId.isBlank() && requestId.equals(stringValue(receipt.get("requestId"))))) {
                if (!action.equals(stringValue(receipt.get("action")))
                    || (!expected.isBlank() && !expected.equals(entry.getKey()))) {
                    throw new BulkRunConflictException("This decision was already accepted for a different action or approval window.");
                }
                return new LinkedHashMap<>(normalizeMap(receipt.get("response")));
            }
        }
        String currentToken = approvalId(job);
        if (!expected.isBlank() && !expected.equals(currentToken)) {
            throw new BulkRunConflictException("This approval window is no longer current. Refresh the run before deciding again.");
        }
        String currentStatus = stringValue(job.get("status"));
        if (STATUS_COMPLETED.equals(currentStatus) || STATUS_CANCELLED.equals(currentStatus)) {
            if (tokened) {
                throw new BulkRunConflictException("The bulk run is already " + currentStatus + ".");
            }
            return status(normalizedRunId);
        }
        if ("continue".equals(action) && STATUS_RUNNING.equals(currentStatus)) {
            if (tokened) {
                throw new BulkRunConflictException("The bulk run is already running.");
            }
            tryScheduleRunWorker(normalizedRunId);
            return status(normalizedRunId);
        }
        payload.put("approvalId", newApprovalId());
        payload.put("startRequested", true);
        if ("continue".equals(action)) {
            payload.put("approvalGeneration", toInt(payload.get("approvalGeneration"), 0) + 1);
            payload.put("approvalBatchCount", 0);
            job.put("status", STATUS_RUNNING);
            job.put("message", "Owner approved unresolved work and the next batch window.");
        } else {
            cancelledRunIds.add(normalizedRunId);
            payload.put("cancellationPending", true);
            job.put("status", STATUS_CANCELLED);
            job.put("message", "Cancelled by owner.");
            job.put("finishedAt", now());
        }
        job.put("updatedAt", now());
        job.put("payload", payload);
        Map<String, Object> accepted = decisionReceipt(job, action, requestId, currentToken);
        receipts.put(currentToken, Map.of("action", action, "requestId", requestId, "response", accepted));
        payload.put("decisionReceipts", receipts);
        putJob(normalizedRunId, job);
        if ("continue".equals(action)) {
            repairManifest(job);
            if (activeRunIds.contains(normalizedRunId)) {
                pendingRunIds.add(normalizedRunId);
            } else {
                tryScheduleRunWorker(normalizedRunId);
            }
        } else {
            finishCancellation(normalizedRunId);
        }
        return tokened || !requestId.isBlank() ? accepted : status(normalizedRunId);
    }

    private Map<String, Object> decisionReceipt(Map<String, Object> job, String action, String requestId, String consumedToken) {
        String runId = stringValue(job.get("jobId"));
        List<Map<String, Object>> batches = loadBatchTasks(runId);
        Map<String, Object> receipt = new LinkedHashMap<>();
        receipt.put("runId", runId);
        receipt.put("status", stringValue(job.get("status")));
        receipt.put("message", stringValue(job.get("message")));
        receipt.put("requestedBy", stringValue(job.get("requestedBy")));
        receipt.put("filters", publicFilters(job));
        Map<String, Object> summary = compactReceiptSummary(buildRunSummary(batches));
        receipt.put("summary", summary);
        receipt.put("counts", summary);
        receipt.put("currentBatch", currentBatchPayload(batches));
        receipt.put("approvalId", approvalId(job));
        receipt.put("acceptedApprovalId", consumedToken);
        receipt.put("decision", action);
        receipt.put("requestId", requestId);
        receipt.put("accepted", true);
        for (String field : List.of("createdAt", "startedAt", "finishedAt", "updatedAt")) {
            receipt.put(field, stringValue(job.get(field)));
        }
        return receipt;
    }

    /**
     * Keep replay receipts bounded instead of duplicating every owned task id per approval.
     *
     * @param fullSummary current run counters and ownership projection
     * @return numeric counters and bounded batch metadata only
     */
    private Map<String, Object> compactReceiptSummary(Map<String, Object> fullSummary) {
        Map<String, Object> compact = new LinkedHashMap<>();
        fullSummary.forEach((key, value) -> {
            if (value instanceof Number || "lastCompletedBatch".equals(key) || "nextBatch".equals(key)) {
                compact.put(key, value);
            }
        });
        return compact;
    }

    private synchronized void finishCancellation(String runId) {
        pendingRunIds.remove(runId);
        try {
            gateway.cancelRun(runId);
            for (Map<String, Object> batch : loadBatchTasks(runId)) {
                if (!STATUS_COMPLETED.equals(stringValue(batch.get("status")))) {
                    putBatchTask(runId, withBatchStatus(batch, STATUS_CANCELLED, "Cancelled by owner.", toInt(batch.get("percent"), 0)));
                }
            }
            Map<String, Object> job = requireRun(runId);
            Map<String, Object> payload = new LinkedHashMap<>(normalizeMap(job.get("payload")));
            payload.put("cancellationPending", activeRunIds.contains(runId));
            job.put("payload", payload);
            putJob(runId, job);
            if (!activeRunIds.contains(runId)) {
                cancelledRunIds.remove(runId);
            }
        } catch (Exception error) {
            logger.warn("DOWNLOAD", "Bulk cancellation will retry owned-task cleanup.", error.getMessage());
        }
    }

    private void processRun(String runId) {
        try {
            Map<String, Object> job = beginWorker(runId);
            if (job == null) {
                return;
            }
            Map<String, Object> payload = normalizeMap(job.get("payload"));
            int generation = toInt(payload.get("approvalGeneration"), 0);
            int batchesPerApproval = resolveBatchesPerApproval(payload.get("batchesPerApproval"));
            int completedInGeneration = (int) loadBatchTasks(runId).stream()
                .filter(batch -> STATUS_COMPLETED.equals(stringValue(batch.get("status"))))
                .filter(batch -> toInt(normalizeMap(batch.get("result")).get("approvalGeneration"), -1) == generation)
                .count();
            // A batch checkpoint can survive a crash before the separate parent counter write.
            int processedBatches = Math.max(toInt(payload.get("approvalBatchCount"), 0), completedInGeneration);
            while (processedBatches < batchesPerApproval) {
                Map<String, Object> batch = nextRunnableBatch(runId);
                if (batch == null) {
                    Map<String, Object> completedJob = requireRun(runId);
                    updateRunStatus(completedJob, STATUS_COMPLETED, "Raven mega downloadall completed.", buildRunSummary(loadBatchTasks(runId)));
                    return;
                }
                throwIfRunCancelled(runId);
                processBatch(runId, batch);
                processedBatches++;
                checkpointApprovalBudget(runId, generation, processedBatches);
            }
            Map<String, Object> refreshedJob = requireRun(runId);
            if (nextRunnableBatch(runId) == null) {
                updateRunStatus(refreshedJob, STATUS_COMPLETED, "Raven mega downloadall completed.", buildRunSummary(loadBatchTasks(runId)));
                return;
            }
            updateRunStatus(
                refreshedJob,
                STATUS_PAUSED,
                "Batch completed. Waiting for owner permission to continue.",
                buildRunSummary(loadBatchTasks(runId))
            );
        } catch (BulkRunNeedsAdminRecoveryException recovery) {
            safelyUpdateRunAfterFailure(runId, STATUS_PAUSED, recovery.getMessage(), null);
        } catch (BulkRunCancelledException ignored) {
            safelyUpdateRunAfterFailure(runId, STATUS_CANCELLED, "Cancelled by owner.", null);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            logger.warn("DOWNLOAD", "Raven mega downloadall worker was interrupted.", interrupted.getMessage());
            safelyUpdateRunAfterFailure(
                runId,
                STATUS_RUNNING,
                "Raven interrupted downloadall before completion. It will resume when Raven is ready.",
                interrupted
            );
        } catch (Exception error) {
            logger.error("DOWNLOAD", "Raven mega downloadall run failed.", error);
            safelyUpdateRunAfterFailure(
                runId,
                STATUS_PAUSED,
                firstNonBlank(error.getMessage(), "Raven paused downloadall. Continue after resolving the reported failure."),
                error
            );
        }
    }

    private Map<String, Object> nextRunnableBatch(String runId) {
        for (Map<String, Object> batch : loadBatchTasks(runId)) {
            String status = stringValue(batch.get("status")).toLowerCase(Locale.ROOT);
            if (!STATUS_COMPLETED.equals(status) || hasUnresolvedBatch(normalizeMap(batch.get("result")))) {
                return batch;
            }
        }
        return null;
    }

    private boolean tryScheduleRunWorker(String runId) {
        if (worker.isShutdown() || !restoreReady() || !activeRunIds.add(runId)) {
            return false;
        }
        cancelledRunIds.remove(runId);
        try {
            worker.execute(() -> {
                try {
                    processRun(runId);
                } finally {
                    activeRunIds.remove(runId);
                    try {
                        if (runCancelled(runId)) {
                            // Reconcile a checkpoint that crossed the cancellation write before its callback returned.
                            finishCancellation(runId);
                        }
                    } catch (Exception error) {
                        logger.warn("DOWNLOAD", "Bulk worker could not finish cancellation cleanup.", error.getMessage());
                    }
                    cancelledRunIds.remove(runId);
                    if (pendingRunIds.remove(runId)) {
                        tryScheduleRunWorker(runId);
                    }
                }
            });
            return true;
        } catch (RuntimeException error) {
            activeRunIds.remove(runId);
            logger.warn("DOWNLOAD", "Raven bulk-run worker could not accept a durable run.", "runId=" + runId + " error=" + error.getMessage());
            return false;
        }
    }

    private synchronized Map<String, Object> beginWorker(String runId) {
        Map<String, Object> job = requireRun(runId);
        String status = stringValue(job.get("status"));
        if (!restoreReady() || isRunTerminal(status) || STATUS_PAUSED.equals(status)
            || (STATUS_QUEUED.equals(status) && !booleanValue(normalizeMap(job.get("payload")).get("startRequested")))) {
            return null;
        }
        updateRunStatus(job, STATUS_RUNNING, "Raven mega downloadall is running.", buildRunSummary(loadBatchTasks(runId)));
        return requireRun(runId);
    }

    private synchronized void checkpointApprovalBudget(String runId, int generation, int completedBatches) {
        throwIfRunCancelled(runId);
        Map<String, Object> job = requireRun(runId);
        Map<String, Object> payload = new LinkedHashMap<>(normalizeMap(job.get("payload")));
        if (toInt(payload.get("approvalGeneration"), 0) != generation) {
            throw new BulkRunNeedsAdminRecoveryException("The approval window changed while its worker was finishing.");
        }
        payload.put("approvalBatchCount", completedBatches);
        job.put("payload", payload);
        putJob(runId, job);
    }

    private void processBatch(String runId, Map<String, Object> batch) throws InterruptedException {
        Map<String, Object> current = new LinkedHashMap<>(batch);
        Map<String, Object> result = new LinkedHashMap<>(normalizeMap(current.get("result")));
        int generation = toInt(normalizeMap(requireRun(runId).get("payload")).get("approvalGeneration"), 0);
        if (toInt(result.get("approvalGeneration"), -1) != generation) {
            result.put("approvalAttempts", Map.of());
            Map<String, Object> retryBlockedSince = new LinkedHashMap<>();
            normalizeMap(result.get("retryBlockedSince")).keySet().forEach(taskId -> retryBlockedSince.put(taskId, now()));
            result.put("retryBlockedSince", retryBlockedSince);
            result.put("approvalGeneration", generation);
        }
        current.put("result", result);
        current = withBatchStatus(current, STATUS_RUNNING, "Discovering or reconciling owned title work.", 5);
        putBatchTask(runId, current);
        current = queueBatch(runId, current);
        waitForBatchTasks(runId, current);
    }

    private Map<String, Object> queueBatch(String runId, Map<String, Object> batch) throws InterruptedException {
        Map<String, Object> payload = normalizeMap(batch.get("payload"));
        Map<String, Object> current = new LinkedHashMap<>(batch);
        try {
            BulkQueueDownloadResult bulkResult = gateway.queueBatch(
                runId, stringValue(batch.get("taskId")), PROVIDER_ID,
                stringValue(payload.get("type")), booleanValue(payload.get("nsfw")),
                stringValue(payload.get("titleGroup")), stringValue(payload.get("requestedBy")),
                () -> runCancelled(runId), (checkpoint) -> {
                    throwIfRunCancelled(runId);
                    current.put("result", mergeCheckpoint(normalizeMap(current.get("result")), checkpoint));
                    putBatchTask(runId, current);
                });
            throwIfRunCancelled(runId);
            Map<String, Object> result = mergeCheckpoint(normalizeMap(current.get("result")), bulkResultToMap(bulkResult));
            result.put("discoveryComplete", !BulkQueueDownloadResult.STATUS_INVALID_REQUEST.equals(bulkResult.status()));
            if (BulkQueueDownloadResult.STATUS_INVALID_REQUEST.equals(bulkResult.status())) {
                result.put("discoveryError", bulkResult.message());
            } else {
                result.remove("discoveryError");
            }
            Map<String, Object> attempts = new LinkedHashMap<>(normalizeMap(result.get("attempts")));
            Map<String, Object> approvalAttempts = new LinkedHashMap<>(normalizeMap(result.get("approvalAttempts")));
            for (String taskId : stringList(result.get("taskIds"))) {
                if (!attempts.containsKey(taskId)) {
                    attempts.put(taskId, 1);
                    approvalAttempts.put(taskId, 1);
                }
            }
            result.put("attempts", attempts);
            result.put("approvalAttempts", approvalAttempts);
            current.put("result", result);
            Map<String, Object> waiting = withBatchStatus(current, STATUS_RUNNING, "Waiting for owned title tasks.", 25);
            putBatchTask(runId, waiting);
            return waiting;
        } catch (BulkRunCancelledException | java.util.concurrent.CancellationException cancelled) {
            throw new BulkRunCancelledException();
        } catch (Exception error) {
            if (Thread.currentThread().isInterrupted()) {
                throw new InterruptedException("Raven interrupted bulk discovery.");
            }
            throwIfRunCancelled(runId);
            Map<String, Object> result = new LinkedHashMap<>(normalizeMap(current.get("result")));
            result.put("discoveryComplete", false);
            result.put("discoveryError", firstNonBlank(error.getMessage(), "Bulk discovery could not finish."));
            if (error instanceof BulkDiscoveryException discovery) {
                result.put("errorCode", discovery.code());
                result.put("pagesScanned", discovery.pagesScanned());
            }
            current.put("result", result);
            pauseBatch(runId, current, "Bulk discovery did not finish. Continue to retry unresolved discovery.", List.of());
            throw new IllegalStateException("Unreachable discovery recovery path.");
        }
    }

    private Map<String, Object> mergeCheckpoint(Map<String, Object> previous, Map<String, Object> checkpoint) {
        Map<String, Object> result = new LinkedHashMap<>(previous);
        Set<String> protectedFields = Set.of("attempts", "approvalAttempts", "approvalGeneration", "terminalOutcomes",
            "completedTaskIds", "failedTaskIds", "removedTaskIds", "missingTaskIds", "staleTaskIds", "retryBlockedSince");
        for (Map.Entry<String, Object> entry : checkpoint.entrySet()) {
            if (!protectedFields.contains(entry.getKey()) && !"taskIds".equals(entry.getKey()) && !"queuedTaskIds".equals(entry.getKey())) {
                result.put(entry.getKey(), entry.getValue());
            }
        }
        Set<String> taskIds = new LinkedHashSet<>(stringList(previous.get("taskIds")));
        taskIds.addAll(stringList(checkpoint.get("taskIds")));
        taskIds.addAll(stringList(checkpoint.get("queuedTaskIds")));
        result.put("taskIds", List.copyOf(taskIds));
        result.put("queuedTaskIds", List.copyOf(taskIds));
        return result;
    }

    private void waitForBatchTasks(String runId, Map<String, Object> batch) throws InterruptedException {
        Map<String, Object> current = new LinkedHashMap<>(batch);
        while (true) {
            throwIfRunCancelled(runId);
            Map<String, Object> result = new LinkedHashMap<>(normalizeMap(current.get("result")));
            Map<String, Object> attempts = new LinkedHashMap<>(normalizeMap(result.get("attempts")));
            Map<String, Object> approvalAttempts = new LinkedHashMap<>(normalizeMap(result.get("approvalAttempts")));
            Map<String, Object> blockedSince = new LinkedHashMap<>(normalizeMap(result.get("retryBlockedSince")));
            Map<String, Object> terminals = new LinkedHashMap<>(normalizeMap(result.get("terminalOutcomes")));
            Set<String> completed = new LinkedHashSet<>(stringList(result.get("completedTaskIds")));
            Set<String> failed = new LinkedHashSet<>();
            Set<String> missing = new LinkedHashSet<>();
            Set<String> stale = new LinkedHashSet<>(stringList(result.get("staleTaskIds")));
            Map<String, Map<String, Object>> snapshots = new LinkedHashMap<>();
            for (Map<String, Object> task : gateway.ownedTasks(runId, stringValue(batch.get("taskId")))) {
                snapshots.put(stringValue(task.get("taskId")), task);
            }
            Set<String> taskIds = new LinkedHashSet<>(stringList(result.get("taskIds")));
            taskIds.addAll(snapshots.keySet());
            taskIds.addAll(terminals.keySet());
            Map<String, Object> observed = new LinkedHashMap<>();
            boolean pending = false;
            for (String taskId : taskIds) {
                if (completed.contains(taskId) || STATUS_COMPLETED.equals(stringValue(normalizeMap(terminals.get(taskId)).get("status")))) {
                    completed.add(taskId);
                    observed.put(taskId, STATUS_COMPLETED);
                    continue;
                }
                Map<String, Object> task = snapshots.get(taskId);
                if (task == null) {
                    missing.add(taskId);
                    observed.put(taskId, "missing");
                    continue;
                }
                String status = stringValue(task.get("status")).toLowerCase(Locale.ROOT);
                observed.put(taskId, status);
                Map<String, Object> acceptedRetry = acceptedRetry(task);
                if (!attempts.containsKey(taskId)) {
                    attempts.put(taskId, 1);
                    if (acceptedRetry.isEmpty()
                        || toInt(acceptedRetry.get("approvalGeneration"), -1) == toInt(result.get("approvalGeneration"), 0)) {
                        approvalAttempts.put(taskId, 1);
                    }
                }
                if (!acceptedRetry.isEmpty()) {
                    int acceptedCumulative = toInt(acceptedRetry.get("cumulativeAttempt"), 0);
                    boolean newlyAccepted = acceptedCumulative > toInt(attempts.get(taskId), 0);
                    attempts.put(taskId, Math.max(toInt(attempts.get(taskId), 0), acceptedCumulative));
                    if (toInt(acceptedRetry.get("approvalGeneration"), -1) == toInt(result.get("approvalGeneration"), 0)) {
                        newlyAccepted |= toInt(acceptedRetry.get("approvalAttempt"), 0) > toInt(approvalAttempts.get(taskId), 0);
                        approvalAttempts.put(taskId, Math.max(toInt(approvalAttempts.get(taskId), 0), toInt(acceptedRetry.get("approvalAttempt"), 0)));
                    }
                    if (isNonProgressingQueuedTask(status) && (blockedSince.containsKey(taskId) || newlyAccepted)) {
                        // A durable acceptance can survive a lost response before a local executor was attached.
                        if (!safeRetryTask(runId, stringValue(batch.get("taskId")), taskId, acceptedRetry)) {
                            blockedSince.putIfAbsent(taskId, now());
                            failed.add(taskId);
                            continue;
                        }
                        blockedSince.remove(taskId);
                        pending = true;
                        continue;
                    }
                    if (newlyAccepted) blockedSince.remove(taskId);
                }
                if (!stringValue(task.get("persistenceError")).isBlank()) {
                    failed.add(taskId);
                    continue;
                }
                if (STATUS_COMPLETED.equals(status)) {
                    completed.add(taskId);
                    stale.remove(taskId);
                    terminals.put(taskId, Map.of("status", STATUS_COMPLETED, "observedAt", now(),
                        "titleId", stringValue(task.get("titleId"))));
                    continue;
                }
                if (STATUS_RUNNING.equals(status)) {
                    if (isTitleTaskStale(task)) {
                        safeCancelTask(taskId);
                        stale.add(taskId);
                        failed.add(taskId);
                    } else {
                        pending = true;
                    }
                    continue;
                }
                if (isNonProgressingQueuedTask(status)) {
                    pending = true;
                    continue;
                }
                if (STATUS_FAILED.equals(status)) {
                    int used = toInt(approvalAttempts.get(taskId), 0);
                    boolean explicitlyCancelled = stringValue(task.get("message")).toLowerCase(Locale.ROOT).startsWith("cancelled")
                        || "cancelled".equals(stringValue(task.get("failureCode")));
                    if (used >= MAX_TITLE_ATTEMPTS || (explicitlyCancelled && used > 0)) {
                        failed.add(taskId);
                    } else if (safeRetryTask(runId, stringValue(batch.get("taskId")), taskId,
                        retryAttempt(runId, stringValue(batch.get("taskId")), taskId, toInt(attempts.get(taskId), 0) + 1,
                            toInt(result.get("approvalGeneration"), 0), used + 1))) {
                        attempts.put(taskId, toInt(attempts.get(taskId), 0) + 1);
                        approvalAttempts.put(taskId, used + 1);
                        blockedSince.remove(taskId);
                        pending = true;
                    } else {
                        blockedSince.putIfAbsent(taskId, now());
                        if (olderThan(stringValue(blockedSince.get(taskId)), RETRY_WIND_DOWN_TIMEOUT)) {
                            failed.add(taskId);
                        } else {
                            pending = true;
                        }
                    }
                    continue;
                }
                // Unknown, cancelled and superseded identities need explicit reconciliation, never silent success.
                failed.add(taskId);
            }
            result.put("taskIds", List.copyOf(taskIds));
            result.put("queuedTaskIds", List.copyOf(taskIds));
            result.put("attempts", attempts);
            result.put("approvalAttempts", approvalAttempts);
            result.put("retryBlockedSince", blockedSince);
            result.put("terminalOutcomes", terminals);
            result.put("observedStatuses", observed);
            result.put("completedTaskIds", List.copyOf(completed));
            result.put("failedTaskIds", List.copyOf(failed));
            result.put("missingTaskIds", List.copyOf(missing));
            result.put("removedTaskIds", List.of());
            result.put("staleTaskIds", List.copyOf(stale));
            result.put("lastFinishedCount", completed.size());
            result.put("terminalCounts", Map.of("completed", completed.size(), "failed", failed.size(), "missing", missing.size(),
                "removed", 0, "stale", stale.size()));
            current.put("result", result);
            if (!failed.isEmpty() || !missing.isEmpty() || hasUnresolvedDiscovery(result)) {
                Set<String> unresolved = new LinkedHashSet<>(failed);
                unresolved.addAll(missing);
                pauseBatch(runId, current, "Some owned title work needs recovery. Continue retries only unresolved work.", List.copyOf(unresolved));
            }
            if (!pending && completed.size() == taskIds.size()) {
                result.remove("recoveryAction");
                current.put("result", result);
                putBatchTask(runId, withBatchStatus(current, STATUS_COMPLETED, "Batch completed.", 100));
                return;
            }
            int percent = taskIds.isEmpty() ? 25 : Math.min(98, 25 + (int) Math.floor(completed.size() * 70.0 / taskIds.size()));
            current = withBatchStatus(current, STATUS_RUNNING, "Waiting for owned title tasks.", percent);
            putBatchTask(runId, current);
            sleepBeforeNextPoll();
        }
    }

    private boolean hasUnresolvedDiscovery(Map<String, Object> result) {
        return Boolean.FALSE.equals(result.get("discoveryComplete"))
            || toInt(result.get("failedCount"), 0) > 0 || toInt(result.get("invalidSourceCount"), 0) > 0
            || !stringList(result.get("unresolvedPlanIds")).isEmpty();
    }

    private boolean hasUnresolvedBatch(Map<String, Object> result) {
        return hasUnresolvedDiscovery(result) || !stringList(result.get("failedTaskIds")).isEmpty()
            || !stringList(result.get("missingTaskIds")).isEmpty() || !stringList(result.get("removedTaskIds")).isEmpty();
    }

    private void pauseBatch(String runId, Map<String, Object> batch, String message, List<String> taskIds) {
        Map<String, Object> result = new LinkedHashMap<>(normalizeMap(batch.get("result")));
        result.put("recoveryAction", Map.of("type", "unresolved-bulk-work", "runId", runId,
            "batchId", stringValue(batch.get("taskId")), "taskIds", taskIds,
            "planIds", stringList(result.get("unresolvedPlanIds")), "adminPath", "/admin/activity/queue",
            "followUp", "Resolve the reported source or task error, then continue this run.", "message", message));
        batch.put("result", result);
        putBatchTask(runId, withBatchStatus(batch, STATUS_PAUSED, message, Math.min(98, toInt(batch.get("percent"), 25))));
        throw new BulkRunNeedsAdminRecoveryException(message);
    }

    private Map<String, Object> buildBatchTask(String runId, String requestedBy, String type, String titleGroup, boolean nsfw, int sortOrder, String now) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("providerId", PROVIDER_ID);
        payload.put("type", type);
        payload.put("titleGroup", titleGroup);
        payload.put("titlePrefix", titleGroup);
        payload.put("nsfw", nsfw);
        payload.put("requestedBy", requestedBy);

        Map<String, Object> task = new LinkedHashMap<>();
        task.put("taskId", batchTaskId(runId, type, titleGroup));
        task.put("jobId", runId);
        task.put("taskKey", "bulk-batch");
        task.put("label", titleGroup + " " + type);
        task.put("status", STATUS_QUEUED);
        task.put("message", "Queued.");
        task.put("percent", 0);
        task.put("sortOrder", sortOrder);
        task.put("payload", payload);
        task.put("result", emptyBatchResult(type, titleGroup, nsfw));
        task.put("createdAt", now);
        task.put("startedAt", null);
        task.put("finishedAt", null);
        task.put("updatedAt", now);
        return task;
    }

    private Map<String, Object> withBatchStatus(Map<String, Object> batch, String status, String message, int percent) {
        Map<String, Object> updated = new LinkedHashMap<>(batch);
        String previousStatus = stringValue(updated.get("status"));
        String now = Instant.now().toString();
        updated.put("status", status);
        updated.put("message", firstNonBlank(message, status));
        updated.put("percent", Math.max(0, Math.min(100, percent)));
        if (STATUS_RUNNING.equals(status) && !STATUS_RUNNING.equals(previousStatus) && stringValue(updated.get("startedAt")).isBlank()) {
            updated.put("startedAt", now);
        }
        if (isBatchTerminal(status)) {
            updated.put("finishedAt", now);
        }
        updated.put("updatedAt", now);
        return updated;
    }

    private Map<String, Object> batchStatusPayload(Map<String, Object> batch) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("batchId", stringValue(batch.get("taskId")));
        payload.put("status", stringValue(batch.get("status")));
        payload.put("message", stringValue(batch.get("message")));
        payload.put("percent", toInt(batch.get("percent"), 0));
        payload.put("sortOrder", toInt(batch.get("sortOrder"), 0));
        payload.put("filters", normalizeMap(batch.get("payload")));
        payload.put("result", normalizeMap(batch.get("result")));
        payload.put("createdAt", stringValue(batch.get("createdAt")));
        payload.put("startedAt", stringValue(batch.get("startedAt")));
        payload.put("finishedAt", stringValue(batch.get("finishedAt")));
        payload.put("updatedAt", stringValue(batch.get("updatedAt")));
        return payload;
    }

    private Map<String, Object> currentBatchPayload(List<Map<String, Object>> batches) {
        Map<String, Object> selected = batches.stream()
            .filter((batch) -> STATUS_RUNNING.equals(stringValue(batch.get("status")).toLowerCase(Locale.ROOT)))
            .findFirst()
            .orElseGet(() -> batches.stream()
                .filter((batch) -> !isBatchTerminal(stringValue(batch.get("status")).toLowerCase(Locale.ROOT)))
                .findFirst()
                .orElse(null));
        if (selected == null) {
            return Map.of();
        }
        Map<String, Object> filters = normalizeMap(selected.get("payload"));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("batchId", stringValue(selected.get("taskId")));
        payload.put("status", stringValue(selected.get("status")));
        payload.put("type", stringValue(filters.get("type")));
        payload.put("titlegroup", stringValue(filters.get("titleGroup")));
        payload.put("titlePrefix", stringValue(filters.get("titlePrefix")));
        return payload;
    }

    private Map<String, Object> bulkResultToMap(BulkQueueDownloadResult result) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("status", result.status());
        payload.put("message", result.message());
        payload.put("filters", Map.of(
            "type", result.filters().type(),
            "nsfw", result.filters().nsfw(),
            "titlePrefix", result.filters().titlePrefix()
        ));
        payload.put("pagesScanned", result.pagesScanned());
        payload.put("matchedCount", result.matchedCount());
        payload.put("queuedCount", result.queuedCount());
        payload.put("skippedActiveCount", result.skippedActiveCount());
        payload.put("skippedAdultContentCount", result.skippedAdultContentCount());
        payload.put("skippedNoMetadataCount", result.skippedNoMetadataCount());
        payload.put("skippedAmbiguousMetadataCount", result.skippedAmbiguousMetadataCount());
        payload.put("skippedCompletedCount", result.skippedCompletedCount());
        payload.put("skippedCurrentCount", result.skippedCurrentCount());
        payload.put("appendedCount", result.appendedCount());
        payload.put("invalidSourceCount", result.invalidSourceCount());
        payload.put("failedCount", result.failedCount());
        payload.put("taskIds", result.queuedTaskIds());
        payload.put("queuedTaskIds", result.queuedTaskIds());
        payload.put("queuedTitles", result.queuedTitles());
        payload.put("skippedActiveTitles", result.skippedActiveTitles());
        payload.put("skippedAdultContentTitles", result.skippedAdultContentTitles());
        payload.put("skippedNoMetadataTitles", result.skippedNoMetadataTitles());
        payload.put("skippedAmbiguousMetadataTitles", result.skippedAmbiguousMetadataTitles());
        payload.put("skippedCompletedTitles", result.skippedCompletedTitles());
        payload.put("skippedCurrentTitles", result.skippedCurrentTitles());
        payload.put("appendedTitles", result.appendedTitles());
        payload.put("invalidSourceTitles", result.invalidSourceTitles());
        payload.put("failedTitles", result.failedTitles());
        payload.put("completedTaskIds", List.of());
        payload.put("failedTaskIds", List.of());
        payload.put("removedTaskIds", List.of());
        payload.put("missingTaskIds", List.of());
        payload.put("staleTaskIds", List.of());
        payload.put("lastProgressAt", "");
        payload.put("lastFinishedCount", 0);
        payload.put("observedStatuses", Map.of());
        return payload;
    }

    private Map<String, Object> emptyBatchResult(String type, String titleGroup, boolean nsfw) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("status", STATUS_QUEUED);
        result.put("message", "");
        result.put("filters", Map.of("type", type, "nsfw", nsfw, "titlePrefix", titleGroup));
        result.put("taskIds", List.of());
        result.put("queuedTaskIds", List.of());
        result.put("skippedCompletedTitles", List.of());
        result.put("skippedCurrentTitles", List.of());
        result.put("appendedTitles", List.of());
        result.put("invalidSourceTitles", List.of());
        result.put("completedTaskIds", List.of());
        result.put("failedTaskIds", List.of());
        result.put("removedTaskIds", List.of());
        result.put("missingTaskIds", List.of());
        result.put("staleTaskIds", List.of());
        result.put("lastProgressAt", "");
        result.put("lastFinishedCount", 0);
        result.put("observedStatuses", Map.of());
        result.put("attempts", Map.of());
        result.put("approvalAttempts", Map.of());
        result.put("terminalOutcomes", Map.of());
        result.put("discoveryComplete", false);
        return result;
    }

    private Map<String, Object> emptyRunSummary(int totalBatches) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("totalBatches", totalBatches);
        summary.put("completedBatches", 0);
        summary.put("remainingBatches", totalBatches);
        summary.put("runningBatches", 0);
        summary.put("pausedBatches", 0);
        summary.put("queuedBatches", 0);
        summary.put("failedBatches", 0);
        summary.put("cancelledBatches", 0);
        summary.put("pagesScanned", 0);
        summary.put("matchedCount", 0);
        summary.put("queuedCount", 0);
        summary.put("skippedActiveCount", 0);
        summary.put("skippedAdultContentCount", 0);
        summary.put("skippedNoMetadataCount", 0);
        summary.put("skippedAmbiguousMetadataCount", 0);
        summary.put("skippedCompletedCount", 0);
        summary.put("skippedCurrentCount", 0);
        summary.put("appendedCount", 0);
        summary.put("invalidSourceCount", 0);
        summary.put("failedCount", 0);
        summary.put("completedTitleTaskCount", 0);
        summary.put("failedTitleTaskCount", 0);
        summary.put("removedFailedTaskCount", 0);
        summary.put("staleTitleTaskCount", 0);
        summary.put("recoveryActions", List.of());
        summary.put("lastCompletedBatch", Map.of());
        summary.put("nextBatch", Map.of());
        summary.put("queuedTaskIds", List.of());
        return summary;
    }

    private Map<String, Object> buildRunSummary(List<Map<String, Object>> batches) {
        Map<String, Object> summary = emptyRunSummary(batches.size());
        List<String> queuedTaskIds = new ArrayList<>();
        List<Map<String, Object>> recoveryActions = new ArrayList<>();
        Map<String, Object> lastCompletedBatch = Map.of();
        Map<String, Object> nextBatch = Map.of();
        for (Map<String, Object> batch : batches) {
            String status = stringValue(batch.get("status")).toLowerCase(Locale.ROOT);
            increment(summary, status + "Batches", 1);
            if (STATUS_COMPLETED.equals(status)) {
                lastCompletedBatch = compactBatchWindow(batch);
            } else if (nextBatch.isEmpty() && !isBatchTerminal(status)) {
                nextBatch = compactBatchWindow(batch);
            }
            Map<String, Object> result = normalizeMap(batch.get("result"));
            increment(summary, "pagesScanned", toInt(result.get("pagesScanned"), 0));
            increment(summary, "matchedCount", toInt(result.get("matchedCount"), 0));
            increment(summary, "queuedCount", toInt(result.get("queuedCount"), 0));
            increment(summary, "skippedActiveCount", toInt(result.get("skippedActiveCount"), 0));
            increment(summary, "skippedAdultContentCount", toInt(result.get("skippedAdultContentCount"), 0));
            increment(summary, "skippedNoMetadataCount", toInt(result.get("skippedNoMetadataCount"), 0));
            increment(summary, "skippedAmbiguousMetadataCount", toInt(result.get("skippedAmbiguousMetadataCount"), 0));
            increment(summary, "skippedCompletedCount", toInt(result.get("skippedCompletedCount"), 0));
            increment(summary, "skippedCurrentCount", toInt(result.get("skippedCurrentCount"), 0));
            increment(summary, "appendedCount", toInt(result.get("appendedCount"), 0));
            increment(summary, "invalidSourceCount", toInt(result.get("invalidSourceCount"), 0));
            increment(summary, "failedCount", toInt(result.get("failedCount"), 0));
            increment(summary, "completedTitleTaskCount", stringList(result.get("completedTaskIds")).size());
            increment(summary, "failedTitleTaskCount", stringList(result.get("failedTaskIds")).size());
            increment(summary, "removedFailedTaskCount", stringList(result.get("removedTaskIds")).size());
            increment(summary, "staleTitleTaskCount", stringList(result.get("staleTaskIds")).size());
            Map<String, Object> recoveryAction = normalizeMap(result.get("recoveryAction"));
            if (!recoveryAction.isEmpty()) {
                recoveryActions.add(recoveryAction);
            }
            queuedTaskIds.addAll(stringList(result.get("taskIds")));
        }
        int completedBatches = toInt(summary.get("completedBatches"), 0);
        summary.put("remainingBatches", Math.max(0, batches.size() - completedBatches));
        summary.put("lastCompletedBatch", lastCompletedBatch);
        summary.put("nextBatch", nextBatch);
        summary.put("queuedTaskIds", List.copyOf(queuedTaskIds));
        summary.put("recoveryActions", List.copyOf(recoveryActions));
        return summary;
    }

    private Map<String, Object> compactBatchWindow(Map<String, Object> batch) {
        Map<String, Object> filters = normalizeMap(batch.get("payload"));
        return Map.of(
            "batchId", stringValue(batch.get("taskId")),
            "label", stringValue(batch.get("label")),
            "status", stringValue(batch.get("status")),
            "type", stringValue(filters.get("type")),
            "titlegroup", stringValue(filters.get("titleGroup")),
            "sortOrder", toInt(batch.get("sortOrder"), 0)
        );
    }

    private void increment(Map<String, Object> values, String key, int amount) {
        values.put(key, toInt(values.get(key), 0) + amount);
    }

    private synchronized void updateRunStatus(Map<String, Object> job, String status, String message, Map<String, Object> summary) {
        Map<String, Object> updated = new LinkedHashMap<>(requireRun(stringValue(job.get("jobId"))));
        String previousStatus = stringValue(updated.get("status"));
        String runId = stringValue(updated.get("jobId"));
        if (STATUS_CANCELLED.equals(previousStatus) && !STATUS_CANCELLED.equals(status)) {
            throw new BulkRunCancelledException();
        }
        String now = now();
        if (STATUS_PAUSED.equals(status) && !STATUS_PAUSED.equals(previousStatus)) {
            Map<String, Object> payload = new LinkedHashMap<>(normalizeMap(updated.get("payload")));
            payload.put("approvalId", newApprovalId());
            updated.put("payload", payload);
        }
        updated.put("status", status);
        updated.put("message", firstNonBlank(message, status));
        updated.put("result", summary == null ? Map.of() : summary);
        if (STATUS_RUNNING.equals(status) && !STATUS_RUNNING.equals(previousStatus) && stringValue(updated.get("startedAt")).isBlank()) {
            updated.put("startedAt", now);
        }
        if (isRunTerminal(status)) {
            updated.put("finishedAt", now);
        }
        updated.put("updatedAt", now);
        putJob(runId, updated);
        if (STATUS_COMPLETED.equals(status) || STATUS_FAILED.equals(status)) {
            cancelledRunIds.remove(runId);
        }
    }

    private void safelyUpdateRunAfterFailure(String runId, String status, String message, Exception originalError) {
        try {
            Map<String, Object> job = requireRun(runId);
            updateRunStatus(job, status, message, safeRunSummary(runId, originalError));
        } catch (Exception statusError) {
            logger.error("DOWNLOAD", "Raven could not persist bulk-run failure state.", statusError);
        }
    }

    private Map<String, Object> safeRunSummary(String runId, Exception originalError) {
        try {
            return buildRunSummary(loadBatchTasks(runId));
        } catch (Exception summaryError) {
            logger.warn(
                "DOWNLOAD",
                "Raven could not load bulk-run batches while handling a run failure.",
                "runId=" + runId + " error=" + summaryError.getMessage()
            );
            Map<String, Object> fallback = new LinkedHashMap<>();
            fallback.put("summaryUnavailable", true);
            fallback.put("error", firstNonBlank(
                originalError == null ? "" : originalError.getMessage(),
                summaryError.getMessage(),
                "Raven could not load durable bulk-run batches."
            ));
            return fallback;
        }
    }

    private boolean isDurableBrokerFailure(Exception error) {
        String message = stringValue(error == null ? "" : error.getMessage());
        return message.startsWith("Raven could not persist the durable bulk run.")
            || message.startsWith("Raven could not persist a durable bulk-run batch.")
            || message.startsWith("Raven could not load durable bulk runs.")
            || message.startsWith("Raven could not load durable bulk-run batches.");
    }

    private void throwIfRunCancelled(String runId) {
        if (cancelledRunIds.contains(runId)) {
            throw new BulkRunCancelledException();
        }
        Map<String, Object> job = requireRun(runId);
        if (STATUS_CANCELLED.equals(stringValue(job.get("status")).toLowerCase(Locale.ROOT))) {
            throw new BulkRunCancelledException();
        }
    }

    private boolean runCancelled(String runId) {
        return cancelledRunIds.contains(runId) || STATUS_CANCELLED.equals(stringValue(requireRun(runId).get("status")));
    }

    private boolean restoreReady() {
        return gateway.restoreCompletion().isDone() && !gateway.restoreCompletion().isCompletedExceptionally()
            && !gateway.restoreCompletion().isCancelled();
    }

    private String restoreFailure() {
        if (!gateway.restoreCompletion().isCompletedExceptionally()) {
            return "";
        }
        try {
            gateway.restoreCompletion().join();
            return "";
        } catch (RuntimeException error) {
            Throwable cause = error.getCause() == null ? error : error.getCause();
            String message = firstNonBlank(cause.getMessage(), cause.getClass().getSimpleName());
            return message.substring(0, Math.min(500, message.length()));
        }
    }

    private String now() {
        return clock.instant().toString();
    }

    private String newApprovalId() {
        return "approval_" + UUID.randomUUID().toString().replace("-", "");
    }

    private String approvalId(Map<String, Object> job) {
        String saved = stringValue(normalizeMap(job.get("payload")).get("approvalId"));
        return saved.isBlank() ? "approval_legacy_" + BulkRunIdentity.digest(List.of(stringValue(job.get("jobId")),
            stringValue(job.get("status")), stringValue(job.get("updatedAt")))) : saved;
    }

    private Map<String, Object> publicFilters(Map<String, Object> job) {
        Map<String, Object> payload = normalizeMap(job.get("payload"));
        Map<String, Object> filters = new LinkedHashMap<>();
        for (String key : List.of("providerId", "type", "titlegroup", "nsfw", "batchCount", "batchesPerApproval")) {
            if (payload.containsKey(key)) {
                filters.put(key, payload.get(key));
            }
        }
        return filters;
    }

    private synchronized void repairManifest(Map<String, Object> job) {
        String runId = stringValue(job.get("jobId"));
        Map<String, Object> payload = normalizeMap(job.get("payload"));
        Set<String> existingIds = new LinkedHashSet<>();
        loadBatchTasks(runId).forEach((batch) -> existingIds.add(stringValue(batch.get("taskId"))));
        int sortOrder = 0;
        for (String group : resolveTitleGroups(stringValue(payload.get("titlegroup")))) {
            for (String type : resolveTypes(stringValue(payload.get("type")))) {
                String taskId = batchTaskId(runId, type, group);
                if (!existingIds.contains(taskId)) {
                    putBatchTask(runId, buildBatchTask(runId, stringValue(job.get("requestedBy")), type, group,
                        booleanValue(payload.get("nsfw")), sortOrder, now()));
                }
                sortOrder++;
            }
        }
        if (!booleanValue(payload.get("manifestComplete"))) {
            Map<String, Object> current = requireRun(runId);
            Map<String, Object> updatedPayload = new LinkedHashMap<>(normalizeMap(current.get("payload")));
            updatedPayload.put("manifestComplete", true);
            current.put("payload", updatedPayload);
            putJob(runId, current);
        }
    }

    private List<String> resolveTypes(String value) {
        String normalized = stringValue(value).toLowerCase(Locale.ROOT);
        if (normalized.isBlank() || "all".equals(normalized)) {
            return BULK_TYPES;
        }
        String type = switch (normalized) {
            case "manga", "managa" -> "Manga";
            case "manhwa" -> "Manhwa";
            case "manhua" -> "Manhua";
            case "oel" -> "OEL";
            default -> "";
        };
        if (type.isBlank()) {
            throw new IllegalArgumentException("type must be one of all, Manga, Manhwa, Manhua, or OEL.");
        }
        return List.of(type);
    }

    private List<String> resolveTitleGroups(String value) {
        String normalized = stringValue(value).toUpperCase(Locale.ROOT);
        if (normalized.isBlank() || "ALL".equals(normalized)) {
            return TITLE_GROUPS;
        }
        if (normalized.length() == 1 && normalized.charAt(0) >= 'A' && normalized.charAt(0) <= 'Z') {
            return List.of(normalized);
        }
        throw new IllegalArgumentException("titlegroup must be all or a single A-Z letter.");
    }

    private String normalizeRunTypeFilter(String value) {
        return "all".equalsIgnoreCase(stringValue(value)) || stringValue(value).isBlank()
            ? "all"
            : resolveTypes(value).getFirst();
    }

    private String normalizeRunGroupFilter(String value) {
        return "all".equalsIgnoreCase(stringValue(value)) || stringValue(value).isBlank()
            ? "all"
            : resolveTitleGroups(value).getFirst();
    }

    private boolean isTitleTaskStale(Map<String, Object> task) {
        if ("waiting-for-encoder".equals(stringValue(task.get("stage")))) {
            return false;
        }
        return olderThan(firstNonBlank(stringValue(task.get("actualProgressAt")),
            stringValue(task.get("updatedAt")), stringValue(task.get("queuedAt"))), TITLE_PROGRESS_TIMEOUT);
    }

    private boolean olderThan(String timestamp, Duration duration) {
        if (timestamp.isBlank()) {
            return false;
        }
        try {
            return Instant.parse(timestamp).isBefore(clock.instant().minus(duration));
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean isNonProgressingQueuedTask(String status) {
        return STATUS_QUEUED.equals(status) || "pending".equals(status);
    }

    private void safeCancelTask(String taskId) {
        try {
            downloaderService.cancelTask(taskId);
        } catch (Exception error) {
            logger.warn("DOWNLOAD", "Bulk run could not cancel a stale title task.", "taskId=" + taskId + " error=" + error.getMessage());
        }
    }

    private Map<String, Object> acceptedRetry(Map<String, Object> task) {
        BulkRetryAttemptReceipt receipt = BulkRetryAttemptReceipt.from(task);
        return receipt == null ? Map.of() : receipt.payload();
    }

    private Map<String, Object> retryAttempt(String runId, String batchId, String taskId, int cumulativeAttempt,
                                           int approvalGeneration, int approvalAttempt) {
        String id = "bulk_retry_" + BulkRunIdentity.digest(List.of(runId, batchId, taskId,
            String.valueOf(cumulativeAttempt), String.valueOf(approvalGeneration), String.valueOf(approvalAttempt)));
        return Map.of("attemptId", id, "cumulativeAttempt", cumulativeAttempt,
            "approvalGeneration", approvalGeneration, "approvalAttempt", approvalAttempt);
    }

    private boolean safeRetryTask(String runId, String batchId, String taskId, Map<String, Object> attempt) {
        try {
            downloaderService.retryBulkTask(taskId, runId, batchId, stringValue(attempt.get("attemptId")),
                toInt(attempt.get("cumulativeAttempt"), 0), toInt(attempt.get("approvalGeneration"), 0),
                toInt(attempt.get("approvalAttempt"), 0));
            return true;
        } catch (Exception error) {
            logger.warn("DOWNLOAD", "Bulk run could not retry a failed title task.", "taskId=" + taskId + " error=" + error.getMessage());
            return false;
        }
    }

    private int resolveBatchesPerApproval(Object... values) {
        for (Object value : values) {
            int parsed = toInt(value, 0);
            if (parsed > 0) {
                return Math.min(MAX_BATCHES_PER_APPROVAL, Math.max(DEFAULT_BATCHES_PER_APPROVAL, parsed));
            }
        }
        return DEFAULT_BATCHES_PER_APPROVAL;
    }

    private Map<String, Object> requireRun(String runId) {
        String normalizedRunId = normalizeRunId(runId);
        Map<String, Object> found = findRun(normalizedRunId);
        if (found != null) {
            return found;
        }
        throw new IllegalStateException("Bulk run not found.");
    }

    private Map<String, Object> findRun(String normalizedRunId) {
        for (Map<String, Object> job : loadRunJobs()) {
            if (normalizedRunId.equals(stringValue(job.get("jobId")))) {
                return job;
            }
        }
        return null;
    }

    private List<Map<String, Object>> loadRunJobs() {
        try {
            JsonNode payload = brokerClient.listJobs(OWNER_SERVICE, RUN_JOB_KIND, "");
            if (payload == null || !payload.isArray()) {
                return List.of();
            }
            List<Map<String, Object>> jobs = new ArrayList<>();
            payload.forEach((node) -> jobs.add(jsonToMap(node)));
            return jobs;
        } catch (Exception error) {
            throw new IllegalStateException("Raven could not load durable bulk runs.", error);
        }
    }

    private List<Map<String, Object>> loadBatchTasks(String runId) {
        try {
            JsonNode payload = brokerClient.listJobTasks(runId, "");
            if (payload == null || !payload.isArray()) {
                return List.of();
            }
            List<Map<String, Object>> batches = new ArrayList<>();
            payload.forEach((node) -> {
                String kind = node.path("payload").path("kind").asText("");
                if (!"bulk-title-plan".equals(kind) && !"bulk-discovery-plan".equals(kind)) {
                    batches.add(jsonToMap(node));
                }
            });
            batches.sort(Comparator
                .comparingInt((Map<String, Object> batch) -> toInt(batch.get("sortOrder"), Integer.MAX_VALUE))
                .thenComparing((batch) -> stringValue(batch.get("taskId"))));
            return List.copyOf(batches);
        } catch (Exception error) {
            throw new IllegalStateException("Raven could not load durable bulk-run batches.", error);
        }
    }

    private void putJob(String runId, Map<String, Object> payload) {
        try {
            brokerClient.putJob(runId, payload);
        } catch (Exception error) {
            throw new IllegalStateException("Raven could not persist the durable bulk run.", error);
        }
    }

    private void putBatchTask(String runId, Map<String, Object> payload) {
        try {
            brokerClient.putJobTask(runId, stringValue(payload.get("taskId")), payload);
        } catch (Exception error) {
            throw new IllegalStateException("Raven could not persist a durable bulk-run batch.", error);
        }
    }

    private void sleepBeforeNextPoll() throws InterruptedException {
        TimeUnit.MILLISECONDS.sleep(Math.max(1, pollDelay.toMillis()));
    }

    private String batchTaskId(String runId, String type, String titleGroup) {
        return runId + "_batch_" + titleGroup.toLowerCase(Locale.ROOT) + "_" + type.toLowerCase(Locale.ROOT);
    }

    private boolean isRunTerminal(String status) {
        return STATUS_COMPLETED.equals(status) || STATUS_FAILED.equals(status) || STATUS_CANCELLED.equals(status);
    }

    private boolean isBatchTerminal(String status) {
        return STATUS_COMPLETED.equals(status) || STATUS_FAILED.equals(status) || STATUS_CANCELLED.equals(status);
    }

    private String normalizeRunId(String value) {
        String normalized = stringValue(value);
        if (normalized.isBlank()) {
            throw new IllegalArgumentException("runId is required.");
        }
        return normalized;
    }

    private Map<String, Object> normalizeMap(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> normalized = new LinkedHashMap<>();
            map.forEach((key, entryValue) -> normalized.put(String.valueOf(key), entryValue));
            return normalized;
        }
        return Map.of();
    }

    private List<String> stringList(Object value) {
        if (value instanceof Iterable<?> iterable) {
            List<String> values = new ArrayList<>();
            for (Object entry : iterable) {
                String normalized = stringValue(entry);
                if (!normalized.isBlank()) {
                    values.add(normalized);
                }
            }
            return List.copyOf(values);
        }
        return List.of();
    }

    private Map<String, Object> jsonToMap(JsonNode node) {
        Map<String, Object> output = new LinkedHashMap<>();
        if (node == null || !node.isObject()) {
            return output;
        }
        node.fields().forEachRemaining((entry) -> output.put(entry.getKey(), jsonValue(entry.getValue())));
        return output;
    }

    private Object jsonValue(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        if (node.isObject()) {
            return jsonToMap(node);
        }
        if (node.isArray()) {
            List<Object> values = new ArrayList<>();
            node.forEach((child) -> values.add(jsonValue(child)));
            return values;
        }
        if (node.isIntegralNumber()) {
            return node.asLong();
        }
        if (node.isFloatingPointNumber()) {
            return node.asDouble();
        }
        if (node.isBoolean()) {
            return node.asBoolean();
        }
        return node.asText("");
    }

    private int toInt(Object value, int fallback) {
        if (value instanceof Number number) {
            return number.intValue();
        }
        try {
            return Integer.parseInt(stringValue(value));
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private boolean booleanValue(Object value) {
        if (value instanceof Boolean bool) {
            return bool;
        }
        String normalized = stringValue(value).toLowerCase(Locale.ROOT);
        return "true".equals(normalized) || "yes".equals(normalized) || "1".equals(normalized);
    }

    private String stringValue(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value.trim();
            }
        }
        return "";
    }

    private static final class BulkRunCancelledException extends RuntimeException {
    }

    private static final class BulkRunNeedsAdminRecoveryException extends RuntimeException {
        private BulkRunNeedsAdminRecoveryException(String message) {
            super(message);
        }
    }
}
