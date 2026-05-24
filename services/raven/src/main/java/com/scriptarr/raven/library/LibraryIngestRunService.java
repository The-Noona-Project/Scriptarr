package com.scriptarr.raven.library;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.stream.Collectors;

/**
 * Durable reader-page rebuild runs for Raven library types.
 */
@Service
public final class LibraryIngestRunService {
    private static final String OWNER_SERVICE = "scriptarr-raven";
    private static final String RUN_JOB_KIND = "raven-library-ingest";
    private static final String STATUS_QUEUED = "queued";
    private static final String STATUS_RUNNING = "running";
    private static final String STATUS_COMPLETED = "completed";
    private static final String STATUS_FAILED = "failed";
    private static final String STATUS_CANCELLED = "cancelled";
    private static final String STATUS_SUPERSEDED = "superseded";
    private static final String INGEST_FORMAT = "avif";
    private static final String INGEST_MODE = "avif-force-rebuild";
    private static final int RECENT_RUN_LIMIT = 6;
    private static final int MIN_ETA_PERCENT = 1;
    private static final int MAX_ETA_PERCENT = 99;
    private static final long MIN_ETA_ELAPSED_MILLIS = 30_000;
    private static final long MAX_ETA_MILLIS = 7L * 24L * 60L * 60L * 1000L;
    private static final List<String> ALLOWED_TYPE_SLUGS = List.of(
        "manga",
        "manhwa",
        "manhua",
        "webtoon",
        "comic",
        "oel"
    );

    private final LibraryService libraryService;
    private final RavenBrokerClient brokerClient;
    private final ScriptarrLogger logger;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ExecutorService worker = Executors.newFixedThreadPool(2, (runnable) -> {
        Thread thread = new Thread(runnable, "raven-library-ingest-runner");
        thread.setDaemon(true);
        return thread;
    });
    private final Set<String> activeRunIds = ConcurrentHashMap.newKeySet();
    private final Map<String, Map<String, Object>> cachedRunJobs = new ConcurrentHashMap<>();

    /**
     * Create the durable Raven library ingest-run service.
     *
     * @param libraryService existing title-level reader-page ingest service
     * @param brokerClient Sage-backed durable job broker
     * @param logger shared Raven logger
     */
    public LibraryIngestRunService(
        LibraryService libraryService,
        RavenBrokerClient brokerClient,
        ScriptarrLogger logger
    ) {
        this.libraryService = libraryService;
        this.brokerClient = brokerClient;
        this.logger = logger;
    }

    /**
     * Create and start an AVIF rebuild run for one library type slug.
     *
     * @param body caller payload with libraryTypeSlug/type and requestedBy
     * @return durable run status payload
     */
    public synchronized Map<String, Object> createRun(Map<String, Object> body) {
        Map<String, Object> request = body == null ? Map.of() : body;
        String libraryTypeSlug = resolveLibraryTypeSlug(request);
        String requestedBy = firstNonBlank(stringValue(request.get("requestedBy")), "scriptarr-admin");
        supersedeLegacyRuns(libraryTypeSlug);
        List<LibraryTitle> titles = titlesForType(libraryTypeSlug);
        Map<String, Object> activeRun = activeRunForType(libraryTypeSlug);
        if (!activeRun.isEmpty()) {
            if (activeRunNeedsCanonicalRestart(activeRun, titles)) {
                supersedeRun(activeRun, "Superseded after catalog duplicate merge changed the canonical title set.");
            } else {
                reconcileRun(activeRun);
                Map<String, Object> existingStatus = status(stringValue(activeRun.get("jobId")));
                existingStatus.put("reused", true);
                existingStatus.put("message", "Raven already has an active library ingest run for " + libraryTypeSlug + ".");
                return existingStatus;
            }
        }

        String runId = "ingestrun_" + UUID.randomUUID().toString().replace("-", "");
        String now = Instant.now().toString();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("libraryTypeSlug", libraryTypeSlug);
        payload.put("libraryTypeLabel", typeLabelForSlug(libraryTypeSlug));
        payload.put("mode", INGEST_MODE);
        payload.put("format", INGEST_FORMAT);
        payload.put("titleCount", titles.size());

        Map<String, Object> job = new LinkedHashMap<>();
        job.put("jobId", runId);
        job.put("kind", RUN_JOB_KIND);
        job.put("ownerService", OWNER_SERVICE);
        job.put("status", STATUS_QUEUED);
        job.put("label", "Raven AVIF rebuild");
        job.put("message", "Queued AVIF rebuild from existing canonical CBZ archives.");
        job.put("requestedBy", requestedBy);
        job.put("payload", payload);
        job.put("result", runSummary(titles.size(), 0, 0, List.of(), List.of()));
        job.put("createdAt", now);
        job.put("startedAt", null);
        job.put("finishedAt", null);
        job.put("updatedAt", now);
        putJob(runId, job);

        for (int index = 0; index < titles.size(); index++) {
            putTitleTask(runId, buildTitleTask(runId, titles.get(index), requestedBy, index, now));
        }

        tryScheduleRunWorker(runId);
        return status(runId);
    }

    /**
     * Load a durable library ingest-run status response.
     *
     * @param runId durable run id
     * @return run status payload
     */
    public Map<String, Object> status(String runId) {
        String normalizedRunId = normalizeRunId(runId);
        Map<String, Object> job = requireRun(normalizedRunId);
        List<Map<String, Object>> tasks = loadTitleTasks(normalizedRunId);
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("runId", normalizedRunId);
        response.put("status", stringValue(job.get("status")));
        response.put("message", stringValue(job.get("message")));
        response.put("requestedBy", stringValue(job.get("requestedBy")));
        response.put("active", activeRunIds.contains(normalizedRunId));
        response.put("filters", normalizeMap(job.get("payload")));
        response.put("result", normalizeMap(job.get("result")));
        response.put("counts", normalizeMap(job.get("result")));
        response.put("tasks", tasks);
        response.put("createdAt", stringValue(job.get("createdAt")));
        response.put("startedAt", stringValue(job.get("startedAt")));
        response.put("finishedAt", stringValue(job.get("finishedAt")));
        response.put("updatedAt", stringValue(job.get("updatedAt")));
        return response;
    }

    /**
     * List bounded durable ingest-run summaries for admin surfaces.
     *
     * @param statusFilter active, recent, all, or an exact run status
     * @return summarized durable run rows without child title task payloads
     */
    public List<Map<String, Object>> listRunSummaries(String statusFilter) {
        String filter = firstNonBlank(statusFilter, "active").toLowerCase(Locale.ROOT);
        return summarizeRunJobs(loadRunJobsForSummaries(), filter);
    }

    private List<Map<String, Object>> summarizeRunJobs(List<Map<String, Object>> jobs, String filter) {
        List<Map<String, Object>> summaries = jobs.stream()
            .filter((job) -> matchesSummaryFilter(job, filter))
            .map(this::runSummaryRow)
            .sorted((left, right) -> Long.compare(summaryTimestamp(right), summaryTimestamp(left)))
            .toList();
        if ("recent".equals(filter)) {
            return summaries.stream().limit(RECENT_RUN_LIMIT).toList();
        }
        return summaries;
    }

    /**
     * Build grouped active and recent ingest-run summaries for the ingest
     * backlog payload.
     *
     * @return grouped durable run summaries
     */
    public Map<String, Object> groupedRunSummaries() {
        List<Map<String, Object>> jobs = loadRunJobsForSummaries();
        return Map.of(
            "active", summarizeRunJobs(jobs, "active"),
            "recent", summarizeRunJobs(jobs, "recent")
        );
    }

    /**
     * Resume queued or running library ingest runs after Raven restarts.
     */
    @PostConstruct
    public void resumeInterruptedRuns() {
        try {
            for (Map<String, Object> job : loadRunJobs()) {
                if (isLegacyActiveRun(job)) {
                    supersedeRun(job, "Superseded by AVIF reader-page migration.");
                    continue;
                }
                reconcileRun(job);
            }
        } catch (IllegalStateException error) {
            logger.warn("LIBRARY", "Raven could not inspect durable library ingest runs during startup.", error.getMessage());
        }
    }

    /**
     * Stop the ingest-run worker on Spring shutdown.
     */
    @PreDestroy
    public void shutdown() {
        worker.shutdownNow();
    }

    private void processRun(String runId) {
        List<String> completedTitleIds = new ArrayList<>();
        List<String> failedTitleIds = new ArrayList<>();
        try {
            Map<String, Object> job = requireRun(runId);
            List<Map<String, Object>> tasks = loadTitleTasks(runId);
            completedTitleIds.addAll(titleIdsWithStatus(tasks, STATUS_COMPLETED));
            failedTitleIds.addAll(titleIdsWithStatus(tasks, STATUS_FAILED));
            failedTitleIds.addAll(titleIdsWithStatus(tasks, STATUS_CANCELLED));
            updateJob(
                job,
                STATUS_RUNNING,
                "Rebuilding AVIF pages from existing canonical CBZ archives.",
                runSummary(tasks.size(), completedTitleIds.size(), failedTitleIds.size(), completedTitleIds, failedTitleIds),
                false
            );

            for (Map<String, Object> task : tasks) {
                if (isTaskTerminal(task)) {
                    continue;
                }
                String titleId = stringValue(normalizeMap(task.get("payload")).get("titleId"));
                Map<String, Object> runningTask = withTaskStatus(task, STATUS_RUNNING, "Rebuilding title AVIF pages.", 5, Map.of());
                putTitleTask(runId, runningTask);
                try {
                    LibraryTitle title = libraryService.ingestTitle(titleId, stringValue(task.get("requestedBy")));
                    completedTitleIds.add(titleId);
                    putTitleTask(runId, withTaskStatus(
                        runningTask,
                        STATUS_COMPLETED,
                        "Title AVIF rebuild completed.",
                        100,
                        Map.of(
                            "titleId", title.id(),
                            "ingestStatus", title.ingestStatus(),
                            "ingestedChapterCount", title.ingestedChapterCount()
                        )
                    ));
                } catch (Exception error) {
                    failedTitleIds.add(titleId);
                    putTitleTask(runId, withTaskStatus(
                        runningTask,
                        STATUS_FAILED,
                        sanitizeError(error.getMessage()),
                        100,
                        Map.of(
                            "titleId", titleId,
                            "error", sanitizeError(error.getMessage())
                        )
                    ));
                    logger.warn("LIBRARY", "Raven library ingest run failed a title.", "titleId=" + titleId + " error=" + error.getMessage());
                }
                Map<String, Object> refreshed = requireRun(runId);
                int finished = completedTitleIds.size() + failedTitleIds.size();
                updateJob(
                    refreshed,
                    STATUS_RUNNING,
                    "Rebuilt " + finished + " of " + tasks.size() + " title(s).",
                    runSummary(tasks.size(), completedTitleIds.size(), failedTitleIds.size(), completedTitleIds, failedTitleIds),
                    false
                );
            }

            Map<String, Object> completedJob = requireRun(runId);
            boolean failed = !failedTitleIds.isEmpty();
            updateJob(
                completedJob,
                failed ? STATUS_FAILED : STATUS_COMPLETED,
                failed ? "Raven AVIF rebuild completed with failed title(s)." : "Raven AVIF rebuild completed.",
                runSummary(tasks.size(), completedTitleIds.size(), failedTitleIds.size(), completedTitleIds, failedTitleIds),
                true
            );
        } catch (Exception error) {
            logger.error("LIBRARY", "Raven library ingest run failed.", error);
            try {
                Map<String, Object> job = requireRun(runId);
                List<Map<String, Object>> tasks = loadTitleTasks(runId);
                updateJob(
                    job,
                    STATUS_FAILED,
                    firstNonBlank(error.getMessage(), "Raven AVIF rebuild failed."),
                    runSummary(tasks.size(), completedTitleIds.size(), failedTitleIds.size(), completedTitleIds, failedTitleIds),
                    true
                );
            } catch (Exception updateError) {
                logger.warn("LIBRARY", "Raven could not persist failed library ingest run state.", updateError.getMessage());
            }
        }
    }

    private void reconcileRun(Map<String, Object> job) {
        String runId = stringValue(job.get("jobId"));
        String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
        if (runId.isBlank() || (!STATUS_QUEUED.equals(status) && !STATUS_RUNNING.equals(status))) {
            return;
        }
        if (activeRunIds.contains(runId)) {
            return;
        }

        List<Map<String, Object>> tasks = loadTitleTasks(runId);
        if (tasks.stream().allMatch(this::isTaskTerminal)) {
            finalizeRunFromTasks(job, tasks);
            return;
        }

        logger.warn(
            "LIBRARY",
            "Raven recovered a detached library ingest run.",
            "runId=" + runId + " status=" + status + " unfinishedTasks=" + tasks.stream().filter((task) -> !isTaskTerminal(task)).count()
        );
        tryScheduleRunWorker(runId);
    }

    private void finalizeRunFromTasks(Map<String, Object> job, List<Map<String, Object>> tasks) {
        List<String> completedTitleIds = titleIdsWithStatus(tasks, STATUS_COMPLETED);
        List<String> failedTitleIds = new ArrayList<>(titleIdsWithStatus(tasks, STATUS_FAILED));
        failedTitleIds.addAll(titleIdsWithStatus(tasks, STATUS_CANCELLED));
        boolean failed = !failedTitleIds.isEmpty();
        updateJob(
            job,
            failed ? STATUS_FAILED : STATUS_COMPLETED,
            failed ? "Raven AVIF rebuild completed with failed title(s)." : "Raven AVIF rebuild completed.",
            runSummary(tasks.size(), completedTitleIds.size(), failedTitleIds.size(), completedTitleIds, failedTitleIds),
            true
        );
    }

    private boolean tryScheduleRunWorker(String runId) {
        String normalizedRunId = normalizeRunId(runId);
        if (worker.isShutdown() || !activeRunIds.add(normalizedRunId)) {
            return false;
        }
        try {
            worker.execute(() -> {
                try {
                    processRun(normalizedRunId);
                } finally {
                    activeRunIds.remove(normalizedRunId);
                }
            });
            return true;
        } catch (RuntimeException error) {
            activeRunIds.remove(normalizedRunId);
            logger.warn("LIBRARY", "Raven library ingest-run worker could not accept a durable run.", error.getMessage());
            return false;
        }
    }

    private Map<String, Object> buildTitleTask(
        String runId,
        LibraryTitle title,
        String requestedBy,
        int sortOrder,
        String now
    ) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("runId", runId);
        payload.put("titleId", title.id());
        payload.put("titleName", title.title());
        payload.put("libraryTypeSlug", title.libraryTypeSlug());
        payload.put("libraryTypeLabel", title.libraryTypeLabel());
        payload.put("downloadRoot", firstNonBlank(title.downloadRoot(), ""));
        payload.put("mode", INGEST_MODE);
        payload.put("format", INGEST_FORMAT);

        Map<String, Object> task = new LinkedHashMap<>();
        task.put("taskId", titleTaskId(runId, title.id()));
        task.put("taskKey", title.id());
        task.put("status", STATUS_QUEUED);
        task.put("label", title.title());
        task.put("message", "Queued title AVIF rebuild.");
        task.put("requestedBy", requestedBy);
        task.put("sortOrder", sortOrder);
        task.put("percent", 0);
        task.put("payload", payload);
        task.put("result", Map.of());
        task.put("createdAt", now);
        task.put("startedAt", null);
        task.put("finishedAt", null);
        task.put("updatedAt", now);
        return task;
    }

    private Map<String, Object> withTaskStatus(
        Map<String, Object> task,
        String status,
        String message,
        int percent,
        Map<String, Object> result
    ) {
        Map<String, Object> updated = new LinkedHashMap<>(task);
        String now = Instant.now().toString();
        updated.put("status", status);
        updated.put("message", message);
        updated.put("percent", Math.max(0, Math.min(100, percent)));
        updated.put("result", result == null ? Map.of() : result);
        updated.put("updatedAt", now);
        if (STATUS_RUNNING.equals(status) && stringValue(updated.get("startedAt")).isBlank()) {
            updated.put("startedAt", now);
        }
        if (STATUS_COMPLETED.equals(status) || STATUS_FAILED.equals(status) || STATUS_SUPERSEDED.equals(status)) {
            updated.put("finishedAt", now);
        }
        return updated;
    }

    private void updateJob(
        Map<String, Object> job,
        String status,
        String message,
        Map<String, Object> result,
        boolean finished
    ) {
        Map<String, Object> updated = new LinkedHashMap<>(job);
        String now = Instant.now().toString();
        updated.put("status", status);
        updated.put("message", message);
        updated.put("result", result);
        updated.put("updatedAt", now);
        if (STATUS_RUNNING.equals(status) && stringValue(updated.get("startedAt")).isBlank()) {
            updated.put("startedAt", now);
        }
        if (finished) {
            updated.put("finishedAt", now);
        }
        putJob(stringValue(updated.get("jobId")), updated);
    }

    private Map<String, Object> runSummary(
        int totalTitles,
        int completedTitles,
        int failedTitles,
        List<String> completedTitleIds,
        List<String> failedTitleIds
    ) {
        int finishedTitles = completedTitles + failedTitles;
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("totalTitles", Math.max(0, totalTitles));
        summary.put("completedTitles", Math.max(0, completedTitles));
        summary.put("failedTitles", Math.max(0, failedTitles));
        summary.put("remainingTitles", Math.max(0, totalTitles - finishedTitles));
        summary.put("completedTitleIds", List.copyOf(completedTitleIds));
        summary.put("failedTitleIds", List.copyOf(failedTitleIds));
        return summary;
    }

    private boolean isTaskTerminal(Map<String, Object> task) {
        String status = stringValue(task.get("status")).toLowerCase(Locale.ROOT);
        return STATUS_COMPLETED.equals(status) || STATUS_FAILED.equals(status) || STATUS_CANCELLED.equals(status) || STATUS_SUPERSEDED.equals(status);
    }

    private List<String> titleIdsWithStatus(List<Map<String, Object>> tasks, String expectedStatus) {
        return tasks.stream()
            .filter((task) -> expectedStatus.equals(stringValue(task.get("status")).toLowerCase(Locale.ROOT)))
            .map(this::titleIdForTask)
            .filter((titleId) -> !titleId.isBlank())
            .distinct()
            .toList();
    }

    private String titleIdForTask(Map<String, Object> task) {
        return firstNonBlank(
            stringValue(normalizeMap(task.get("payload")).get("titleId")),
            stringValue(task.get("taskKey"))
        );
    }

    private List<LibraryTitle> titlesForType(String libraryTypeSlug) {
        return libraryService.listCompactTitleRows(Map.of("type", libraryTypeSlug)).stream()
            .sorted(Comparator.comparing((row) -> stringValue(row.get("title")).toLowerCase(Locale.ROOT)))
            .map((row) -> stringValue(row.get("id")))
            .filter((titleId) -> !titleId.isBlank())
            .map(libraryService::findTitleById)
            .filter((title) -> title != null)
            .toList();
    }

    private Map<String, Object> activeRunForType(String libraryTypeSlug) {
        for (Map<String, Object> job : loadRunJobs()) {
            String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
            String jobType = stringValue(normalizeMap(job.get("payload")).get("libraryTypeSlug")).toLowerCase(Locale.ROOT);
            if (libraryTypeSlug.equals(jobType) && (STATUS_QUEUED.equals(status) || STATUS_RUNNING.equals(status))) {
                return job;
            }
        }
        return Map.of();
    }

    private boolean activeRunNeedsCanonicalRestart(Map<String, Object> job, List<LibraryTitle> currentTitles) {
        Set<String> currentTitleIds = Optional.ofNullable(currentTitles).orElse(List.of()).stream()
            .map(LibraryTitle::id)
            .filter((titleId) -> titleId != null && !titleId.isBlank())
            .collect(Collectors.toCollection(LinkedHashSet::new));
        List<Map<String, Object>> tasks = loadTitleTasks(stringValue(job.get("jobId")));
        Set<String> taskTitleIds = tasks.stream()
            .map(this::titleIdForTask)
            .filter((titleId) -> !titleId.isBlank())
            .collect(Collectors.toCollection(LinkedHashSet::new));
        return taskTitleIds.size() != currentTitleIds.size() || !taskTitleIds.equals(currentTitleIds);
    }

    private void supersedeLegacyRuns(String libraryTypeSlug) {
        for (Map<String, Object> job : loadRunJobs()) {
            String jobType = stringValue(normalizeMap(job.get("payload")).get("libraryTypeSlug")).toLowerCase(Locale.ROOT);
            if (libraryTypeSlug.equals(jobType) && isLegacyActiveRun(job)) {
                supersedeRun(job, "Superseded by AVIF reader-page migration.");
            }
        }
    }

    private boolean isLegacyActiveRun(Map<String, Object> job) {
        String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
        if (!STATUS_QUEUED.equals(status) && !STATUS_RUNNING.equals(status)) {
            return false;
        }
        Map<String, Object> payload = normalizeMap(job.get("payload"));
        String format = stringValue(payload.get("format")).toLowerCase(Locale.ROOT);
        String mode = stringValue(payload.get("mode")).toLowerCase(Locale.ROOT);
        return !INGEST_FORMAT.equals(format) || !INGEST_MODE.equals(mode);
    }

    private void supersedeRun(Map<String, Object> job, String message) {
        String runId = stringValue(job.get("jobId"));
        for (Map<String, Object> task : loadTitleTasks(runId)) {
            if (!isTaskTerminal(task)) {
                putTitleTask(runId, withTaskStatus(
                    task,
                    STATUS_SUPERSEDED,
                    firstNonBlank(message, "Superseded by a newer reader-page ingest format."),
                    100,
                    Map.of(
                        "titleId", titleIdForTask(task),
                        "supersededByFormat", INGEST_FORMAT
                    )
                ));
            }
        }
        updateJob(
            job,
            STATUS_SUPERSEDED,
            firstNonBlank(message, "Superseded by a newer reader-page ingest format."),
            normalizeMap(job.get("result")),
            true
        );
    }

    private boolean matchesSummaryFilter(Map<String, Object> job, String filter) {
        String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
        if ("all".equals(filter)) {
            return true;
        }
        if ("recent".equals(filter)) {
            return STATUS_COMPLETED.equals(status)
                || STATUS_FAILED.equals(status)
                || STATUS_CANCELLED.equals(status)
                || STATUS_SUPERSEDED.equals(status);
        }
        if ("active".equals(filter)) {
            return STATUS_QUEUED.equals(status) || STATUS_RUNNING.equals(status);
        }
        return filter.equals(status);
    }

    private Map<String, Object> runSummaryRow(Map<String, Object> job) {
        Map<String, Object> payload = normalizeMap(job.get("payload"));
        Map<String, Object> result = normalizeMap(job.get("result"));
        String runId = stringValue(job.get("jobId"));
        String status = stringValue(job.get("status"));
        int totalTitles = Math.max(0, toInt(result.get("totalTitles"), toInt(payload.get("titleCount"), 0)));
        int completedTitles = Math.max(0, toInt(result.get("completedTitles"), 0));
        int failedTitles = Math.max(0, toInt(result.get("failedTitles"), 0));
        int remainingTitles = Math.max(0, toInt(result.get("remainingTitles"), totalTitles - completedTitles - failedTitles));
        int percent = totalTitles > 0
            ? Math.max(0, Math.min(100, (int) Math.floor(((completedTitles + failedTitles) / (double) totalTitles) * 100)))
            : 0;
        Map<String, Object> counts = new LinkedHashMap<>();
        counts.put("totalTitles", totalTitles);
        counts.put("completedTitles", completedTitles);
        counts.put("failedTitles", failedTitles);
        counts.put("remainingTitles", remainingTitles);

        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("runId", runId);
        summary.put("status", status);
        summary.put("active", activeRunIds.contains(runId));
        summary.put("requestedBy", stringValue(job.get("requestedBy")));
        summary.put("libraryTypeSlug", stringValue(payload.get("libraryTypeSlug")));
        summary.put("libraryTypeLabel", firstNonBlank(stringValue(payload.get("libraryTypeLabel")), typeLabelForSlug(stringValue(payload.get("libraryTypeSlug")))));
        summary.put("format", firstNonBlank(stringValue(payload.get("format")), INGEST_FORMAT));
        summary.put("mode", firstNonBlank(stringValue(payload.get("mode")), INGEST_MODE));
        summary.put("message", firstNonBlank(stringValue(job.get("message")), messageForRunStatus(status)));
        summary.put("counts", counts);
        summary.put("percent", percent);
        summary.put("etaMinutes", estimateEtaMinutes(job, percent));
        summary.put("createdAt", stringValue(job.get("createdAt")));
        summary.put("startedAt", stringValue(job.get("startedAt")));
        summary.put("finishedAt", stringValue(job.get("finishedAt")));
        summary.put("updatedAt", stringValue(job.get("updatedAt")));
        return summary;
    }

    private String messageForRunStatus(String status) {
        String normalized = stringValue(status).toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case STATUS_QUEUED -> "Queued AVIF rebuild.";
            case STATUS_RUNNING -> "Rebuilding AVIF pages.";
            case STATUS_COMPLETED -> "AVIF rebuild completed.";
            case STATUS_FAILED -> "AVIF rebuild completed with failed title(s).";
            case STATUS_CANCELLED -> "AVIF rebuild cancelled.";
            case STATUS_SUPERSEDED -> "AVIF rebuild superseded.";
            default -> "AVIF rebuild state updated.";
        };
    }

    private Integer estimateEtaMinutes(Map<String, Object> job, int percent) {
        String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
        if (!STATUS_RUNNING.equals(status) || percent < MIN_ETA_PERCENT || percent > MAX_ETA_PERCENT) {
            return null;
        }
        long startedAt = parseInstantMillis(stringValue(job.get("startedAt")));
        long now = Instant.now().toEpochMilli();
        if (startedAt <= 0 || startedAt > now) {
            return null;
        }
        long elapsedMillis = now - startedAt;
        if (elapsedMillis < MIN_ETA_ELAPSED_MILLIS) {
            return null;
        }
        double estimatedTotalMillis = elapsedMillis / (percent / 100.0);
        long remainingMillis = Math.round(estimatedTotalMillis - elapsedMillis);
        if (remainingMillis < 0 || remainingMillis > MAX_ETA_MILLIS) {
            return null;
        }
        return Math.max(1, (int) Math.ceil(remainingMillis / 60000.0));
    }

    private long summaryTimestamp(Map<String, Object> summary) {
        return Math.max(
            parseInstantMillis(stringValue(summary.get("updatedAt"))),
            Math.max(
                parseInstantMillis(stringValue(summary.get("finishedAt"))),
                parseInstantMillis(stringValue(summary.get("createdAt")))
            )
        );
    }

    private long parseInstantMillis(String value) {
        try {
            return value.isBlank() ? 0 : Instant.parse(value).toEpochMilli();
        } catch (RuntimeException ignored) {
            return 0;
        }
    }

    private Map<String, Object> requireRun(String runId) {
        String normalizedRunId = normalizeRunId(runId);
        for (Map<String, Object> job : loadRunJobs()) {
            if (normalizedRunId.equals(stringValue(job.get("jobId")))) {
                return job;
            }
        }
        throw new IllegalStateException("Library ingest run not found.");
    }

    private List<Map<String, Object>> loadRunJobs() {
        try {
            JsonNode payload = brokerClient.listJobs(OWNER_SERVICE, RUN_JOB_KIND, "");
            if (payload == null || !payload.isArray()) {
                return List.of();
            }
            List<Map<String, Object>> jobs = new ArrayList<>();
            payload.forEach((node) -> jobs.add(jsonToMap(node)));
            rememberRunJobs(jobs);
            return jobs;
        } catch (Exception error) {
            throw new IllegalStateException("Raven could not load durable library ingest runs.", error);
        }
    }

    private List<Map<String, Object>> loadRunJobsForSummaries() {
        try {
            return loadRunJobs();
        } catch (IllegalStateException error) {
            List<Map<String, Object>> fallback = cachedRunJobList();
            if (!fallback.isEmpty()) {
                logger.warn(
                    "LIBRARY",
                    "Raven could not refresh durable library ingest run summaries; using cached recovered runs.",
                    rootMessage(error)
                );
                return fallback;
            }
            logger.warn("LIBRARY", "Raven could not refresh durable library ingest run summaries.", rootMessage(error));
            return List.of();
        }
    }

    private void rememberRunJobs(List<Map<String, Object>> jobs) {
        cachedRunJobs.clear();
        jobs.forEach(this::rememberRunJob);
    }

    private void rememberRunJob(Map<String, Object> job) {
        String runId = stringValue(job.get("jobId"));
        if (!runId.isBlank()) {
            cachedRunJobs.put(runId, new LinkedHashMap<>(job));
        }
    }

    private List<Map<String, Object>> cachedRunJobList() {
        return new ArrayList<>(cachedRunJobs.values());
    }

    private List<Map<String, Object>> loadTitleTasks(String runId) {
        try {
            JsonNode payload = brokerClient.listJobTasks(runId, "");
            if (payload == null || !payload.isArray()) {
                return List.of();
            }
            List<Map<String, Object>> tasks = new ArrayList<>();
            payload.forEach((node) -> tasks.add(jsonToMap(node)));
            tasks.sort(Comparator
                .comparingInt((Map<String, Object> task) -> toInt(task.get("sortOrder"), Integer.MAX_VALUE))
                .thenComparing((task) -> stringValue(task.get("taskId"))));
            return List.copyOf(tasks);
        } catch (Exception error) {
            throw new IllegalStateException("Raven could not load durable library ingest title tasks.", error);
        }
    }

    private void putJob(String runId, Map<String, Object> payload) {
        try {
            brokerClient.putJob(runId, payload);
            rememberRunJob(payload);
        } catch (Exception error) {
            throw new IllegalStateException("Raven could not persist the durable library ingest run.", error);
        }
    }

    private void putTitleTask(String runId, Map<String, Object> payload) {
        try {
            brokerClient.putJobTask(runId, stringValue(payload.get("taskId")), payload);
        } catch (Exception error) {
            throw new IllegalStateException("Raven could not persist a durable library ingest title task.", error);
        }
    }

    private String resolveLibraryTypeSlug(Map<String, Object> request) {
        String raw = firstNonBlank(
            stringValue(request.get("libraryTypeSlug")),
            stringValue(request.get("typeSlug")),
            stringValue(request.get("type")),
            stringValue(request.get("libraryType"))
        );
        if (raw.isBlank()) {
            throw new IllegalArgumentException("libraryTypeSlug is required.");
        }
        String slug = LibraryNaming.normalizeTypeSlug(raw);
        if (!ALLOWED_TYPE_SLUGS.contains(slug)) {
            throw new IllegalArgumentException("libraryTypeSlug must be one of " + String.join(", ", ALLOWED_TYPE_SLUGS) + ".");
        }
        return slug;
    }

    private String typeLabelForSlug(String typeSlug) {
        return LibraryNaming.normalizeTypeLabel(firstNonBlank(typeSlug, "manga"));
    }

    private String titleTaskId(String runId, String titleId) {
        return runId + "_title_" + LibraryNaming.slugifySegment(titleId);
    }

    private String normalizeRunId(String value) {
        String normalized = stringValue(value);
        if (normalized.isBlank()) {
            throw new IllegalArgumentException("runId is required.");
        }
        return normalized;
    }

    private Map<String, Object> jsonToMap(JsonNode node) {
        if (node == null || !node.isObject()) {
            return new LinkedHashMap<>();
        }
        return objectMapper.convertValue(node, new TypeReference<LinkedHashMap<String, Object>>() {
        });
    }

    private Map<String, Object> normalizeMap(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> normalized = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (entry.getKey() != null) {
                    normalized.put(String.valueOf(entry.getKey()), entry.getValue());
                }
            }
            return normalized;
        }
        return Map.of();
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

    private String sanitizeError(String value) {
        String normalized = Optional.ofNullable(value).orElse("Raven ingest failed.").replaceAll("[\\r\\n]+", " ").trim();
        return normalized.length() > 240 ? normalized.substring(0, 240) : normalized;
    }

    private String rootMessage(Throwable error) {
        Throwable cursor = error;
        while (cursor != null && cursor.getCause() != null) {
            cursor = cursor.getCause();
        }
        return cursor == null ? "unknown" : sanitizeError(cursor.getMessage());
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return "";
    }

    private String stringValue(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }
}
