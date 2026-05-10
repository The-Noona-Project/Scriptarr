package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Service;

import java.time.Duration;
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
import java.util.concurrent.TimeUnit;

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
    private static final Duration BATCH_PROGRESS_TIMEOUT = Duration.ofMinutes(90);
    private static final List<String> BULK_TYPES = List.of("Manga", "Manhwa", "Manhua", "OEL");
    private static final List<String> TITLE_GROUPS = List.of(
        "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
        "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"
    );

    private final DownloaderService downloaderService;
    private final RavenBrokerClient brokerClient;
    private final ScriptarrLogger logger;
    private final ExecutorService worker = Executors.newSingleThreadExecutor((runnable) -> {
        Thread thread = new Thread(runnable, "raven-bulk-downloadall-runner");
        thread.setDaemon(true);
        return thread;
    });
    private final Set<String> activeRunIds = ConcurrentHashMap.newKeySet();
    private final Set<String> cancelledRunIds = ConcurrentHashMap.newKeySet();

    /**
     * Create the durable Raven bulk-run orchestrator.
     *
     * @param downloaderService existing Raven download queue service
     * @param brokerClient Sage-backed broker client for durable jobs
     * @param logger shared Raven logger
     */
    public BulkRunService(DownloaderService downloaderService, RavenBrokerClient brokerClient, ScriptarrLogger logger) {
        this.downloaderService = downloaderService;
        this.brokerClient = brokerClient;
        this.logger = logger;
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
        String runId = "bulkrun_" + UUID.randomUUID().toString().replace("-", "");
        String now = Instant.now().toString();

        Map<String, Object> runPayload = new LinkedHashMap<>();
        runPayload.put("providerId", PROVIDER_ID);
        runPayload.put("type", normalizeRunTypeFilter(typeFilter));
        runPayload.put("titlegroup", normalizeRunGroupFilter(groupFilter));
        runPayload.put("nsfw", nsfw);
        runPayload.put("batchCount", groups.size() * types.size());
        runPayload.put("batchesPerApproval", resolveBatchesPerApproval(request.get("batchesPerApproval"), request.get("groupsize")));

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

        int sortOrder = 0;
        for (String group : groups) {
            for (String type : types) {
                putBatchTask(runId, buildBatchTask(runId, requestedBy, type, group, nsfw, sortOrder, now));
                sortOrder++;
            }
        }

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
        return scheduleRun(runId);
    }

    /**
     * Resume or continue a non-terminal durable bulk run.
     *
     * @param runId durable bulk run id
     * @return durable run status payload
     */
    public synchronized Map<String, Object> resumeRun(String runId) {
        return scheduleRun(runId);
    }

    /**
     * Load a deterministic durable bulk-run status response.
     *
     * @param runId durable bulk run id
     * @return durable run status payload
     */
    public Map<String, Object> status(String runId) {
        Map<String, Object> job = requireRun(runId);
        List<Map<String, Object>> batches = loadBatchTasks(normalizeRunId(runId));
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("runId", normalizeRunId(runId));
        response.put("status", stringValue(job.get("status")));
        response.put("message", stringValue(job.get("message")));
        response.put("requestedBy", stringValue(job.get("requestedBy")));
        response.put("active", activeRunIds.contains(normalizeRunId(runId)));
        response.put("filters", normalizeMap(job.get("payload")));
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
        String normalizedRunId = normalizeRunId(runId);
        Map<String, Object> job = requireRun(normalizedRunId);
        cancelledRunIds.add(normalizedRunId);
        updateRunStatus(job, STATUS_CANCELLED, "Cancelled by owner.", buildRunSummary(loadBatchTasks(normalizedRunId)));

        Map<String, Map<String, Object>> snapshotsByTaskId = titleTasksById();
        for (Map<String, Object> batch : loadBatchTasks(normalizedRunId)) {
            for (String taskId : stringList(normalizeMap(batch.get("result")).get("taskIds"))) {
                Map<String, Object> task = snapshotsByTaskId.get(taskId);
                String status = stringValue(task == null ? "" : task.get("status")).toLowerCase(Locale.ROOT);
                if ("queued".equals(status) || "running".equals(status)) {
                    try {
                        downloaderService.cancelTask(taskId);
                    } catch (IllegalStateException ignored) {
                        logger.warn("DOWNLOAD", "Bulk run could not cancel an owned title task.", "taskId=" + taskId);
                    }
                }
            }
            if (!isBatchTerminal(stringValue(batch.get("status")))) {
                putBatchTask(normalizedRunId, withBatchStatus(batch, STATUS_CANCELLED, "Cancelled by owner.", 100));
            }
        }
        activeRunIds.remove(normalizedRunId);
        return status(normalizedRunId);
    }

    /**
     * Resume interrupted runs after Raven restarts. Paused runs intentionally
     * stay paused until the owner explicitly continues them.
     */
    @PostConstruct
    public void resumeInterruptedRuns() {
        try {
            for (Map<String, Object> job : loadRunJobs()) {
                String runId = stringValue(job.get("jobId"));
                String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
                if (STATUS_RUNNING.equals(status)) {
                    scheduleRun(runId);
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
        worker.shutdownNow();
    }

    private Map<String, Object> scheduleRun(String runId) {
        String normalizedRunId = normalizeRunId(runId);
        Map<String, Object> job = requireRun(normalizedRunId);
        String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
        if (STATUS_CANCELLED.equals(status) || STATUS_COMPLETED.equals(status) || STATUS_FAILED.equals(status)) {
            return status(normalizedRunId);
        }
        if (activeRunIds.add(normalizedRunId)) {
            cancelledRunIds.remove(normalizedRunId);
            worker.execute(() -> {
                try {
                    processRun(normalizedRunId);
                } finally {
                    activeRunIds.remove(normalizedRunId);
                }
            });
        }
        return status(normalizedRunId);
    }

    private void processRun(String runId) {
        try {
            Map<String, Object> job = requireRun(runId);
            updateRunStatus(job, STATUS_RUNNING, "Raven mega downloadall is running.", buildRunSummary(loadBatchTasks(runId)));
            int batchesPerApproval = resolveBatchesPerApproval(normalizeMap(job.get("payload")).get("batchesPerApproval"));
            int processedBatches = 0;
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
        } catch (BulkRunCancelledException ignored) {
            safelyUpdateRunAfterFailure(runId, STATUS_CANCELLED, "Cancelled by owner.", null);
        } catch (Exception error) {
            logger.error("DOWNLOAD", "Raven mega downloadall run failed.", error);
            boolean brokerFailure = isDurableBrokerFailure(error);
            safelyUpdateRunAfterFailure(
                runId,
                brokerFailure ? STATUS_PAUSED : STATUS_FAILED,
                brokerFailure
                    ? firstNonBlank(error.getMessage(), "Raven paused downloadall after a durable broker error. Continue to retry.")
                    : firstNonBlank(error.getMessage(), "Raven mega downloadall failed."),
                error
            );
        }
    }

    private Map<String, Object> nextRunnableBatch(String runId) {
        for (Map<String, Object> batch : loadBatchTasks(runId)) {
            String status = stringValue(batch.get("status")).toLowerCase(Locale.ROOT);
            if (!isBatchTerminal(status)) {
                return batch;
            }
        }
        return null;
    }

    private void processBatch(String runId, Map<String, Object> batch) throws InterruptedException {
        Map<String, Object> currentBatch = new LinkedHashMap<>(batch);
        Map<String, Object> result = normalizeMap(currentBatch.get("result"));
        List<String> taskIds = stringList(result.get("taskIds"));
        if (taskIds.isEmpty()) {
            currentBatch = queueBatch(runId, currentBatch);
            result = normalizeMap(currentBatch.get("result"));
            taskIds = stringList(result.get("taskIds"));
            if (taskIds.isEmpty() || STATUS_COMPLETED.equals(stringValue(currentBatch.get("status")))) {
                return;
            }
        } else {
            currentBatch = withBatchStatus(currentBatch, STATUS_RUNNING, "Waiting for run-owned title tasks.", 25);
            putBatchTask(runId, currentBatch);
        }
        waitForBatchTasks(runId, currentBatch, taskIds);
    }

    private Map<String, Object> queueBatch(String runId, Map<String, Object> batch) {
        Map<String, Object> payload = normalizeMap(batch.get("payload"));
        String type = stringValue(payload.get("type"));
        String titleGroup = stringValue(payload.get("titleGroup"));
        boolean nsfw = booleanValue(payload.get("nsfw"));
        batch = withBatchStatus(batch, STATUS_RUNNING, "Queueing " + titleGroup + " " + type + ".", 5);
        putBatchTask(runId, batch);

        BulkQueueDownloadResult bulkResult = downloaderService.bulkQueueDownload(
            PROVIDER_ID,
            type,
            nsfw,
            titleGroup,
            stringValue(payload.get("requestedBy"))
        );
        Map<String, Object> result = bulkResultToMap(bulkResult);
        if (BulkQueueDownloadResult.STATUS_INVALID_REQUEST.equals(bulkResult.status())) {
            batch.put("result", result);
            batch = withBatchStatus(batch, STATUS_FAILED, bulkResult.message(), 100);
            putBatchTask(runId, batch);
            throw new IllegalStateException(bulkResult.message());
        }

        if (bulkResult.queuedTaskIds().isEmpty()) {
            batch.put("result", result);
            batch = withBatchStatus(batch, STATUS_COMPLETED, bulkResult.message(), 100);
            putBatchTask(runId, batch);
            return batch;
        }

        Map<String, Object> attempts = new LinkedHashMap<>();
        for (String taskId : bulkResult.queuedTaskIds()) {
            attempts.put(taskId, 1);
        }
        result.put("attempts", attempts);
        batch.put("result", result);
        batch = withBatchStatus(batch, STATUS_RUNNING, "Waiting for run-owned title tasks.", 25);
        putBatchTask(runId, batch);
        return batch;
    }

    private void waitForBatchTasks(String runId, Map<String, Object> batch, List<String> taskIds) throws InterruptedException {
        Map<String, Object> mutableBatch = new LinkedHashMap<>(batch);
        while (true) {
            throwIfRunCancelled(runId);
            Map<String, Object> result = new LinkedHashMap<>(normalizeMap(mutableBatch.get("result")));
            Map<String, Object> attempts = new LinkedHashMap<>(normalizeMap(result.get("attempts")));
            Map<String, Object> observedStatuses = new LinkedHashMap<>();
            Set<String> completedTaskIds = new LinkedHashSet<>(stringList(result.get("completedTaskIds")));
            Set<String> failedTaskIds = new LinkedHashSet<>(stringList(result.get("failedTaskIds")));
            Set<String> removedTaskIds = new LinkedHashSet<>(stringList(result.get("removedTaskIds")));
            Set<String> missingTaskIds = new LinkedHashSet<>(stringList(result.get("missingTaskIds")));
            Set<String> staleTaskIds = new LinkedHashSet<>(stringList(result.get("staleTaskIds")));
            boolean allDone = true;
            boolean changed = false;
            boolean anyRunning = false;
            Map<String, Map<String, Object>> snapshotsByTaskId = titleTasksById();

            for (String taskId : taskIds) {
                if (removedTaskIds.contains(taskId) || missingTaskIds.contains(taskId)) {
                    continue;
                }
                Map<String, Object> task = snapshotsByTaskId.get(taskId);
                String status = stringValue(task == null ? "" : task.get("status")).toLowerCase(Locale.ROOT);
                observedStatuses.put(taskId, status.isBlank() ? "missing" : status);
                if (task == null) {
                    missingTaskIds.add(taskId);
                    changed = true;
                    continue;
                }
                if (STATUS_RUNNING.equals(status)) {
                    anyRunning = true;
                }
                if (STATUS_RUNNING.equals(status) && isTitleTaskStale(task)) {
                    safeCancelTask(taskId);
                    task = titleTasksById().get(taskId);
                    status = stringValue(task == null ? "" : task.get("status")).toLowerCase(Locale.ROOT);
                    staleTaskIds.add(taskId);
                    changed = true;
                }
                if (STATUS_COMPLETED.equals(status)) {
                    changed = completedTaskIds.add(taskId) || changed;
                    continue;
                }
                if (STATUS_CANCELLED.equals(status)) {
                    safeRemoveTask(taskId);
                    removedTaskIds.add(taskId);
                    failedTaskIds.add(taskId);
                    staleTaskIds.add(taskId);
                    changed = true;
                    continue;
                }
                if (STATUS_FAILED.equals(status)) {
                    int attemptsUsed = Math.max(1, toInt(attempts.get(taskId), 1));
                    if (attemptsUsed < MAX_TITLE_ATTEMPTS) {
                        safeRetryTask(taskId);
                        attempts.put(taskId, attemptsUsed + 1);
                        allDone = false;
                        changed = true;
                    } else {
                        safeRemoveTask(taskId);
                        removedTaskIds.add(taskId);
                        failedTaskIds.add(taskId);
                        changed = true;
                    }
                    continue;
                }
                if (isNonProgressingQueuedTask(status) && isTitleTaskStale(task)) {
                    safeRemoveTask(taskId);
                    removedTaskIds.add(taskId);
                    failedTaskIds.add(taskId);
                    staleTaskIds.add(taskId);
                    changed = true;
                    continue;
                }
                allDone = false;
            }

            int finishedCount = completedTaskIds.size() + removedTaskIds.size() + missingTaskIds.size();
            int previousFinishedCount = toInt(result.get("lastFinishedCount"), 0);
            if (changed || finishedCount > previousFinishedCount || stringValue(result.get("lastProgressAt")).isBlank()) {
                result.put("lastProgressAt", Instant.now().toString());
            }
            result.put("attempts", attempts);
            result.put("observedStatuses", observedStatuses);
            result.put("completedTaskIds", List.copyOf(completedTaskIds));
            result.put("failedTaskIds", List.copyOf(failedTaskIds));
            result.put("removedTaskIds", List.copyOf(removedTaskIds));
            result.put("missingTaskIds", List.copyOf(missingTaskIds));
            result.put("staleTaskIds", List.copyOf(staleTaskIds));
            result.put("lastFinishedCount", finishedCount);
            result.put("terminalCounts", Map.of(
                "completed", completedTaskIds.size(),
                "failed", failedTaskIds.size(),
                "removed", removedTaskIds.size(),
                "missing", missingTaskIds.size(),
                "stale", staleTaskIds.size()
            ));
            mutableBatch.put("result", result);
            int percent = taskIds.isEmpty() ? 100 : Math.min(99, 25 + (int) Math.floor((finishedCount / (double) taskIds.size()) * 70));
            if (allDone) {
                mutableBatch = withBatchStatus(mutableBatch, STATUS_COMPLETED, "Batch completed.", 100);
                putBatchTask(runId, mutableBatch);
                return;
            }
            if (!anyRunning && isBatchProgressStale(result)) {
                for (String taskId : taskIds) {
                    if (completedTaskIds.contains(taskId) || removedTaskIds.contains(taskId) || missingTaskIds.contains(taskId)) {
                        continue;
                    }
                    safeRemoveTask(taskId);
                    removedTaskIds.add(taskId);
                    failedTaskIds.add(taskId);
                    staleTaskIds.add(taskId);
                }
                result.put("failedTaskIds", List.copyOf(failedTaskIds));
                result.put("removedTaskIds", List.copyOf(removedTaskIds));
                result.put("staleTaskIds", List.copyOf(staleTaskIds));
                result.put("lastFinishedCount", completedTaskIds.size() + removedTaskIds.size() + missingTaskIds.size());
                result.put("lastProgressAt", Instant.now().toString());
                mutableBatch.put("result", result);
                mutableBatch = withBatchStatus(mutableBatch, STATUS_COMPLETED, "Batch completed with stale title task failures.", 100);
                putBatchTask(runId, mutableBatch);
                return;
            }
            if (changed) {
                mutableBatch = withBatchStatus(mutableBatch, STATUS_RUNNING, "Waiting for run-owned title tasks.", percent);
                putBatchTask(runId, mutableBatch);
                continue;
            }
            mutableBatch = withBatchStatus(mutableBatch, STATUS_RUNNING, "Waiting for run-owned title tasks.", percent);
            putBatchTask(runId, mutableBatch);
            sleepBeforeNextPoll();
        }
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
        summary.put("lastCompletedBatch", Map.of());
        summary.put("nextBatch", Map.of());
        summary.put("queuedTaskIds", List.of());
        return summary;
    }

    private Map<String, Object> buildRunSummary(List<Map<String, Object>> batches) {
        Map<String, Object> summary = emptyRunSummary(batches.size());
        List<String> queuedTaskIds = new ArrayList<>();
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
            queuedTaskIds.addAll(stringList(result.get("taskIds")));
        }
        int completedBatches = toInt(summary.get("completedBatches"), 0);
        summary.put("remainingBatches", Math.max(0, batches.size() - completedBatches));
        summary.put("lastCompletedBatch", lastCompletedBatch);
        summary.put("nextBatch", nextBatch);
        summary.put("queuedTaskIds", List.copyOf(queuedTaskIds));
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

    private void updateRunStatus(Map<String, Object> job, String status, String message, Map<String, Object> summary) {
        Map<String, Object> updated = new LinkedHashMap<>(job);
        String previousStatus = stringValue(updated.get("status"));
        String now = Instant.now().toString();
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
        putJob(stringValue(updated.get("jobId")), updated);
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

    private Map<String, Map<String, Object>> titleTasksById() {
        Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
        for (Map<String, Object> task : downloaderService.snapshot()) {
            byId.put(stringValue(task.get("taskId")), task);
        }
        return byId;
    }

    private boolean isTitleTaskStale(Map<String, Object> task) {
        String updatedAt = firstNonBlank(stringValue(task.get("updatedAt")), stringValue(task.get("queuedAt")));
        if (updatedAt.isBlank()) {
            return false;
        }
        try {
            return Instant.parse(updatedAt).isBefore(Instant.now().minus(TITLE_PROGRESS_TIMEOUT));
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean isBatchProgressStale(Map<String, Object> result) {
        String lastProgressAt = stringValue(result.get("lastProgressAt"));
        if (lastProgressAt.isBlank()) {
            return false;
        }
        try {
            return Instant.parse(lastProgressAt).isBefore(Instant.now().minus(BATCH_PROGRESS_TIMEOUT));
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean isNonProgressingQueuedTask(String status) {
        return STATUS_QUEUED.equals(status) || status.isBlank() || "pending".equals(status);
    }

    private void safeCancelTask(String taskId) {
        try {
            downloaderService.cancelTask(taskId);
        } catch (Exception error) {
            logger.warn("DOWNLOAD", "Bulk run could not cancel a stale title task.", "taskId=" + taskId + " error=" + error.getMessage());
        }
    }

    private void safeRetryTask(String taskId) {
        try {
            downloaderService.retryTask(taskId);
        } catch (Exception error) {
            logger.warn("DOWNLOAD", "Bulk run could not retry a failed title task.", "taskId=" + taskId + " error=" + error.getMessage());
        }
    }

    private void safeRemoveTask(String taskId) {
        try {
            downloaderService.removeTask(taskId);
        } catch (Exception error) {
            logger.warn("DOWNLOAD", "Bulk run could not remove a failed title task.", "taskId=" + taskId + " error=" + error.getMessage());
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
        for (Map<String, Object> job : loadRunJobs()) {
            if (normalizedRunId.equals(stringValue(job.get("jobId")))) {
                return job;
            }
        }
        throw new IllegalStateException("Bulk run not found.");
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
            payload.forEach((node) -> batches.add(jsonToMap(node)));
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
        TimeUnit.MILLISECONDS.sleep(POLL_DELAY.toMillis());
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
}
