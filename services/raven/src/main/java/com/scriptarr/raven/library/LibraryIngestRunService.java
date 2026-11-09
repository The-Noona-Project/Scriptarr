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
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

/**
 * Durable reader-page rebuild runs for Raven library types.
 */
@Service
public final class LibraryIngestRunService {
    private static final String OWNER_SERVICE = "scriptarr-raven";
    private static final String RUN_JOB_KIND = "raven-library-ingest";
    private static final String STATUS_PREPARING = "preparing";
    private static final String STATUS_QUEUED = "queued";
    private static final String STATUS_RUNNING = "running";
    private static final String STATUS_COMPLETED = "completed";
    private static final String STATUS_FAILED = "failed";
    private static final String STATUS_CANCELLED = "cancelled";
    private static final String STATUS_SUPERSEDED = "superseded";
    private static final String INGEST_FORMAT = WebpMigrationControl.webp() ? "webp" : "avif";
    private static final String INGEST_MODE = WebpMigrationControl.webp() ? "webp-migrate" : "avif-force-rebuild";
    private static final int RECENT_RUN_LIMIT = 6;
    private static final int MIN_ETA_PERCENT = 1;
    private static final int MAX_ETA_PERCENT = 99;
    private static final long MIN_ETA_ELAPSED_MILLIS = 30_000;
    private static final long MAX_ETA_MILLIS = 7L * 24L * 60L * 60L * 1000L;
    private static final int PREPARATION_WORKER_COUNT = 4;
    private static final int DEFAULT_TITLE_LANES = 2;
    private static final int MAX_TITLE_LANES = 3;
    private static final long SCHEDULER_STARTUP_STALE_MILLIS = 10L * 60L * 1000L;
    private static final List<String> ALLOWED_TYPE_SLUGS = List.of(
        "manga",
        "manhwa",
        "manhua",
        "webtoon",
        "comic",
        "oel"
    );
    private static final List<String> CLEAN_RESTART_ORDER = List.of(
        "oel",
        "manhua",
        "manhwa",
        "manga",
        "webtoon",
        "comic"
    );

    private final LibraryService libraryService;
    private final RavenBrokerClient brokerClient;
    private final ScriptarrLogger logger;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final WebpMigrationControl migrationControl;
    private final ScheduledExecutorService recovery = Executors.newSingleThreadScheduledExecutor(runnable -> { Thread thread = new Thread(runnable, "raven-migration-recovery"); thread.setDaemon(true); return thread; });
    private final Set<String> pausedRunIds = ConcurrentHashMap.newKeySet();
    private final int titleLaneCount = resolveConfiguredTitleLanes();
    private final ExecutorService worker = Executors.newFixedThreadPool(titleLaneCount, new TitleLaneThreadFactory());
    private final ExecutorService preparationWorker = Executors.newFixedThreadPool(PREPARATION_WORKER_COUNT, (runnable) -> {
        Thread thread = new Thread(runnable, "raven-library-ingest-preparer");
        thread.setDaemon(true);
        return thread;
    });
    private final Set<String> activeRunIds = ConcurrentHashMap.newKeySet();
    private final Set<String> cancellationRequestedRunIds = ConcurrentHashMap.newKeySet();
    private final Map<String, Map<String, Object>> cachedRunJobs = new ConcurrentHashMap<>();
    private volatile boolean schedulerRunning;
    private volatile long schedulerStartedAtMillis;
    private volatile int workerSlotsInUse;

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
        this.migrationControl = new WebpMigrationControl(brokerClient);
    }

    /**
     * Create and start an reader-page rebuild run for one library type slug.
     *
     * @param body caller payload with libraryTypeSlug/type and requestedBy
     * @return durable run status payload
     */
    public synchronized Map<String, Object> createRun(Map<String, Object> body) {
        if (!migrationControl.enabled()) throw new IllegalStateException("WebP migration is paused; explicitly start it after scoped cleanup.");
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
        job.put("label", "Raven reader-page rebuild");
        job.put("message", "Queued reader-page rebuild from existing canonical CBZ archives.");
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

        scheduleRunWorker();
        return status(runId);
    }

    /**
     * Apply an explicit durable migration decision without restarting the coordinator or changing reader state.
     * @param action start, pause, resume, retry or status
     * @param body operator attribution
     * @return scheduler intent and durable migration runs
     */
    public synchronized Map<String, Object> migrationAction(String action, Map<String, Object> body) {
        String actor = firstNonBlank(stringValue(body == null ? null : body.get("requestedBy")), "scriptarr-admin");
        if (!Set.of("start", "pause", "resume", "retry", "status").contains(action)) throw new IllegalArgumentException("Unknown migration action.");
        if ("status".equals(action)) return Map.of("enabled", migrationControl.enabled(), "runs", groupedRunSummaries());
        if ("pause".equals(action)) {
            migrationControl.set(false, actor);
            for (Map<String, Object> job : loadRunJobs()) if (isDurableActive(job)) {
                String id = stringValue(job.get("jobId")); pausedRunIds.add(id);
                updateJob(job, "paused", "Paused; current chapter may finish before the scheduler yields.", runSummaryFromTasks(loadTitleTasks(id)), false);
            }
        } else {
            migrationControl.set(true, actor);
            for (Map<String, Object> job : loadRunJobs()) {
                String id = stringValue(job.get("jobId")), state = stringValue(job.get("status"));
                if (activeRunIds.contains(id) && pausedRunIds.contains(id)) continue;
                if ("paused".equals(state) || "retry".equals(action) && STATUS_FAILED.equals(state)) {
                    pausedRunIds.remove(id);
                    if (Boolean.TRUE.equals(normalizeMap(job.get("payload")).get("preparing"))) {
                        updateJob(job, STATUS_PREPARING, "Resuming durable migration task preparation.", runSummaryFromTasks(loadTitleTasks(id)), false);
                        scheduleRunPreparation(id, stringValue(normalizeMap(job.get("payload")).get("libraryTypeSlug")), actor); continue;
                    }
                    for (Map<String, Object> task : loadTitleTasks(id)) if (STATUS_RUNNING.equals(task.get("status")) || "retry".equals(action) && Set.of(STATUS_FAILED, STATUS_CANCELLED).contains(stringValue(task.get("status"))))
                        putTitleTask(id, withTaskStatus(task, STATUS_QUEUED, "Queued for explicitly approved migration.", 0, Map.of("titleId", titleIdForTask(task))));
                    updateJob(job, STATUS_QUEUED, "Queued for the chapter-fair migration scheduler.", runSummaryFromTasks(loadTitleTasks(id)), false);
                }
            }
            Set<String> types = new LinkedHashSet<>();
            for (Map<String, Object> row : libraryService.listCompactTitleRows(Map.of())) {
                String type = LibraryNaming.normalizeTypeSlug(stringValue(row.get("libraryTypeSlug")));
                if (ALLOWED_TYPE_SLUGS.contains(type) && toInt(row.get("chapterCount"), 0) > 0) types.add(type);
            }
            for (String type : orderedLibraryTypes(types)) if (activeRunForType(type).isEmpty()) createPreparingRun(type, actor);
            scheduleRunWorker();
        }
        return Map.of("enabled", migrationControl.enabled(), "runs", groupedRunSummaries());
    }

    /**
     * Resume a queued or detached durable ingest run.
     *
     * @param runId durable run id
     * @return refreshed run status
     */
    public synchronized Map<String, Object> resumeRun(String runId) {
        String normalizedRunId = normalizeRunId(runId);
        if (!migrationControl.enabled()) throw new IllegalStateException("WebP migration is paused.");
        if (pausedRunIds.contains(normalizedRunId) && activeRunIds.contains(normalizedRunId)) throw new IllegalStateException("Migration is still winding down.");
        pausedRunIds.remove(normalizedRunId);
        Map<String, Object> job = requireRun(normalizedRunId);
        if (isRunTerminal(job)) {
            return status(normalizedRunId);
        }
        if (STATUS_PREPARING.equals(stringValue(job.get("status")).toLowerCase(Locale.ROOT))) {
            Map<String, Object> payload = normalizeMap(job.get("payload"));
            scheduleRunPreparation(
                normalizedRunId,
                stringValue(payload.get("libraryTypeSlug")).toLowerCase(Locale.ROOT),
                firstNonBlank(stringValue(job.get("requestedBy")), "scriptarr-admin")
            );
            return status(normalizedRunId);
        }
        List<Map<String, Object>> tasks = resetRunningTasksToQueued(normalizedRunId, loadTitleTasks(normalizedRunId));
        if (tasks.stream().allMatch(this::isTaskTerminal)) {
            finalizeRunFromTasks(job, tasks);
            return status(normalizedRunId);
        }
        updateJob(
            job,
            STATUS_QUEUED,
            "Queued reader-page rebuild for the fair ingest scheduler.",
            runSummaryFromTasks(tasks),
            false
        );
        scheduleRunWorker();
        return status(normalizedRunId);
    }

    /**
     * Cancel a queued, waiting, or running durable ingest run.
     *
     * @param runId durable run id
     * @return refreshed run status
     */
    public synchronized Map<String, Object> cancelRun(String runId) {
        String normalizedRunId = normalizeRunId(runId);
        Map<String, Object> job = requireRun(normalizedRunId);
        if (isRunTerminal(job)) {
            return status(normalizedRunId);
        }
        cancellationRequestedRunIds.add(normalizedRunId);
        for (Map<String, Object> task : loadTitleTasks(normalizedRunId)) {
            if (!isTaskTerminal(task)) {
                putTitleTask(normalizedRunId, withTaskStatus(
                    task,
                    STATUS_CANCELLED,
                    "reader-page rebuild cancelled by admin.",
                    100,
                    Map.of("titleId", titleIdForTask(task))
                ));
            }
        }
        activeRunIds.remove(normalizedRunId);
        updateJob(
            job,
            STATUS_CANCELLED,
            "reader-page rebuild cancelled by admin.",
            runSummaryFromTasks(loadTitleTasks(normalizedRunId)),
            true
        );
        scheduleRunWorker();
        return status(normalizedRunId);
    }

    /**
     * Supersede active runs and start fresh rebuilds for every type with
     * pending or failed titles.
     *
     * @param body optional body with requestedBy
     * @return rollout restart summary
     */
    public synchronized Map<String, Object> restartActiveRuns(Map<String, Object> body) {
        return cleanRestartRuns(body);
    }

    /**
     * Supersede noisy active reader-page runs, cooperatively stop active title work,
     * and start fresh runs in Scriptarr's preferred library order.
     *
     * @param body optional body with requestedBy
     * @return non-destructive cleanup and restart summary
     */
    public synchronized Map<String, Object> cleanRestartRuns(Map<String, Object> body) {
        Map<String, Object> request = body == null ? Map.of() : body;
        String requestedBy = firstNonBlank(stringValue(request.get("requestedBy")), "scriptarr-admin");
        Set<String> libraryTypes = retryableLibraryTypes();
        int supersededCount = 0;
        int compactedCount = 0;
        for (Map<String, Object> job : loadRunJobs()) {
            if (isDurableActive(job)) {
                String type = stringValue(normalizeMap(job.get("payload")).get("libraryTypeSlug")).toLowerCase(Locale.ROOT);
                if (!type.isBlank()) {
                    libraryTypes.add(type);
                }
                supersedeRunJobOnly(job, "Superseded by clean reader-page ingest restart.");
                supersededCount += 1;
            } else if (STATUS_SUPERSEDED.equals(stringValue(job.get("status")).toLowerCase(Locale.ROOT))) {
                compactedCount += compactSupersededRun(job);
            }
        }
        List<Map<String, Object>> runs = new ArrayList<>();
        for (String libraryType : orderedLibraryTypes(libraryTypes)) {
            runs.add(createPreparingRun(libraryType, requestedBy));
        }
        return Map.of(
            "supersededCount", supersededCount,
            "compactedCount", compactedCount,
            "startedCount", runs.size(),
            "order", runs.stream().map((run) -> stringValue(run.get("libraryTypeSlug"))).toList(),
            "runs", runs,
            "message", "Clean-started durable reader-page ingest runs across " + runs.size() + " library type(s)."
        );
    }

    private Map<String, Object> createPreparingRun(String libraryTypeSlug, String requestedBy) {
        String normalizedType = LibraryNaming.normalizeTypeSlug(libraryTypeSlug);
        if (!ALLOWED_TYPE_SLUGS.contains(normalizedType)) {
            return Map.of(
                "libraryTypeSlug", normalizedType,
                "status", STATUS_FAILED,
                "message", "Unsupported library type."
            );
        }
        Map<String, Object> activeRun = activeRunForType(normalizedType);
        if (!activeRun.isEmpty()) {
            Map<String, Object> existingStatus = runSummaryRow(activeRun, activeRunPositions(loadRunJobsForSummaries()));
            existingStatus.put("reused", true);
            existingStatus.put("message", "Raven already has an active library ingest run for " + normalizedType + ".");
            return existingStatus;
        }

        String runId = "ingestrun_" + UUID.randomUUID().toString().replace("-", "");
        String now = Instant.now().toString();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("libraryTypeSlug", normalizedType);
        payload.put("libraryTypeLabel", typeLabelForSlug(normalizedType));
        payload.put("mode", INGEST_MODE);
        payload.put("format", INGEST_FORMAT);
        payload.put("titleCount", 0);
        payload.put("preparing", true);

        Map<String, Object> job = new LinkedHashMap<>();
        job.put("jobId", runId);
        job.put("kind", RUN_JOB_KIND);
        job.put("ownerService", OWNER_SERVICE);
        job.put("status", STATUS_PREPARING);
        job.put("label", "Raven reader-page rebuild");
        job.put("message", "Preparing title tasks for the fair reader-page scheduler.");
        job.put("requestedBy", requestedBy);
        job.put("payload", payload);
        job.put("result", runSummary(0, 0, 0, List.of(), List.of()));
        job.put("createdAt", now);
        job.put("startedAt", null);
        job.put("finishedAt", null);
        job.put("updatedAt", now);
        putJob(runId, job);
        scheduleRunPreparation(runId, normalizedType, requestedBy);
        return runSummaryRow(requireRun(runId), activeRunPositions(loadRunJobsForSummaries()));
    }

    private void scheduleRunPreparation(String runId, String libraryTypeSlug, String requestedBy) {
        try {
            preparationWorker.execute(() -> prepareRunTasks(runId, libraryTypeSlug, requestedBy));
        } catch (RejectedExecutionException error) {
            try {
                updateJob(
                    requireRun(runId),
                    STATUS_FAILED,
                    "Raven could not prepare title tasks for the reader-page rebuild.",
                    runSummary(0, 0, 1, List.of(), List.of(runId)),
                    true
                );
            } catch (Exception updateError) {
                logger.warn("LIBRARY", "Raven could not persist failed reader-page run preparation state.", updateError.getMessage());
            }
            logger.warn("LIBRARY", "Raven reader-page run preparation worker rejected work.", error.getMessage());
        }
    }

    private void prepareRunTasks(String runId, String libraryTypeSlug, String requestedBy) {
        try {
            Map<String, Object> job = requireRun(runId);
            if (isRunTerminal(job)) {
                return;
            }
            List<LibraryTitle> titles = titlesForType(libraryTypeSlug);
            if (titles.isEmpty()) {
                updateJob(
                    job,
                    STATUS_COMPLETED,
                    "No ready titles were eligible for reader-page rebuild.",
                    runSummary(0, 0, 0, List.of(), List.of()),
                    true
                );
                return;
            }

            logger.info(
                "LIBRARY",
                "Preparing durable reader-page title tasks.",
                "runId=" + runId + " type=" + libraryTypeSlug + " titles=" + titles.size()
            );
            String now = Instant.now().toString();
            Map<String, Object> payload = new LinkedHashMap<>(normalizeMap(job.get("payload")));
            payload.put("titleCount", titles.size());
            payload.put("preparing", true);
            job = new LinkedHashMap<>(job);
            job.put("payload", payload);
            job.put("result", runSummary(titles.size(), 0, 0, List.of(), List.of()));
            job.put("updatedAt", now);
            putJob(runId, job);

            for (int index = 0; index < titles.size(); index += 1) {
                if (Thread.currentThread().isInterrupted()) {
                    return;
                }
                if (index % 25 == 0 && (isRunTerminal(requireRun(runId)) || "paused".equals(requireRun(runId).get("status")) || !migrationControl.enabled())) {
                    return;
                }
                putTitleTask(runId, buildTitleTask(runId, titles.get(index), requestedBy, index, now));
                if ((index + 1) % 250 == 0) {
                    logger.info(
                        "LIBRARY",
                        "Prepared reader-page title tasks.",
                        "runId=" + runId + " prepared=" + (index + 1) + "/" + titles.size()
                    );
                }
            }

            List<Map<String, Object>> tasks;
            synchronized (this) {
                job = requireRun(runId);
                if (isRunTerminal(job) || "paused".equals(job.get("status")) || !migrationControl.enabled()) return;
                Map<String, Object> preparedPayload = new LinkedHashMap<>(normalizeMap(job.get("payload"))); preparedPayload.put("preparing", false);
                job = new LinkedHashMap<>(job); job.put("payload", preparedPayload); putJob(runId, job);
                tasks = loadTitleTasks(runId);
                updateJob(job, STATUS_QUEUED, "Queued reader-page rebuild for the fair ingest scheduler.", runSummaryFromTasks(tasks), false);
            }
            logger.info(
                "LIBRARY",
                "Queued durable reader-page run for fair scheduler.",
                "runId=" + runId + " type=" + libraryTypeSlug + " titles=" + tasks.size()
            );
            scheduleRunWorker();
        } catch (Exception error) {
            logger.error("LIBRARY", "Raven could not prepare reader-page rebuild title tasks.", error);
            try {
                Map<String, Object> job = requireRun(runId);
                if (!isRunTerminal(job)) {
                    updateJob(
                        job,
                        STATUS_FAILED,
                        firstNonBlank(rootMessage(error), "Raven could not prepare reader-page rebuild title tasks."),
                        runSummaryFromTasks(loadTitleTasks(runId)),
                        true
                    );
                }
            } catch (Exception updateError) {
                logger.warn("LIBRARY", "Raven could not persist failed reader-page preparation state.", updateError.getMessage());
            }
        }
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
        response.put("active", isDurableActive(job));
        response.put("runtime", runtimeSummary(job, tasks, activeRunPositions(loadRunJobsForSummaries())));
        response.put("current", currentTaskSummary(tasks));
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
        Map<String, Integer> positions = activeRunPositions(jobs);
        List<Map<String, Object>> summaries = jobs.stream()
            .filter((job) -> matchesSummaryFilter(job, filter))
            .map((job) -> runSummaryRow(job, positions))
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
        recovery.scheduleWithFixedDelay(this::recoverMigration, 30, 30, TimeUnit.SECONDS);
        recoverMigration();
    }

    /** Reconcile durable scheduling intent periodically without interpreting a status read as a start request. */
    private void recoverMigration() {
        try {
            if (!migrationControl.enabled()) return;
            List<Map<String, Object>> jobs = loadRunJobs();
            for (Map<String, Object> job : jobs) {
                if (isLegacyActiveRun(job)) {
                    supersedeRun(job, "Superseded by the current reader-page migration.");
                }
            }
            jobs = collapseDuplicateActiveRuns(loadRunJobs());
            for (Map<String, Object> job : jobs) {
                String id = stringValue(job.get("jobId"));
                if ("paused".equals(job.get("status")) && !activeRunIds.contains(id)) {
                    pausedRunIds.remove(id); List<Map<String, Object>> tasks = resetRunningTasksToQueued(id, loadTitleTasks(id));
                    updateJob(job, Boolean.TRUE.equals(normalizeMap(job.get("payload")).get("preparing")) ? STATUS_PREPARING : STATUS_QUEUED, "Resumed after the previous chapter checkpoint finished.", runSummaryFromTasks(tasks), false); job = requireRun(id);
                }
                reconcileRun(job);
            }
            if (WebpMigrationControl.webp()) ensureMigrationTypes(loadRunJobs());
        } catch (RuntimeException error) {
            logger.warn("LIBRARY", "Raven could not inspect durable library ingest runs during startup.", error.getMessage());
        }
    }

    /**
     * Repair a crash between persisted migration intent and creation of every library-type run.
     * Existing failed/completed runs are evidence of scheduling, not permission to retry them automatically.
     * @param jobs current durable ingest runs
     */
    synchronized void ensureMigrationTypes(List<Map<String, Object>> jobs) {
        if (!migrationControl.enabled()) return;
        Set<String> known = new LinkedHashSet<>();
        for (Map<String, Object> job : jobs) {
            Map<String, Object> payload = normalizeMap(job.get("payload"));
            if (!STATUS_SUPERSEDED.equals(job.get("status")) && INGEST_FORMAT.equals(payload.get("format")) && INGEST_MODE.equals(payload.get("mode"))) known.add(stringValue(payload.get("libraryTypeSlug")));
        }
        for (Map<String, Object> row : libraryService.listCompactTitleRows(Map.of())) {
            String type = LibraryNaming.normalizeTypeSlug(stringValue(row.get("libraryTypeSlug")));
            if (ALLOWED_TYPE_SLUGS.contains(type) && toInt(row.get("chapterCount"), 0) > 0 && known.add(type)) createPreparingRun(type, "scriptarr-migration-recovery");
        }
    }

    /**
     * Stop the ingest-run worker on Spring shutdown.
     */
    @PreDestroy
    public void shutdown() {
        recovery.shutdownNow();
        worker.shutdownNow();
        preparationWorker.shutdownNow();
    }

    private void runSchedulerLoop(String runId) {
        try {
            processOneTitle(runId);
        } finally {
            synchronized (this) {
                activeRunIds.remove(normalizeRunId(runId));
                workerSlotsInUse = Math.max(0, workerSlotsInUse - 1);
                schedulerRunning = workerSlotsInUse > 0;
                if (!schedulerRunning) {
                    schedulerStartedAtMillis = 0;
                }
            }
            if (hasRunnableJobs()) {
                scheduleRunWorker();
            }
        }
    }

    private void processOneTitle(String runId) {
        String normalizedRunId = normalizeRunId(runId);
        List<String> completedTitleIds = new ArrayList<>();
        List<String> failedTitleIds = new ArrayList<>();
        try {
            Map<String, Object> job = requireRun(normalizedRunId);
            if (isRunTerminal(job) || "paused".equals(stringValue(job.get("status"))) || !migrationControl.enabled()) {
                return;
            }
            List<Map<String, Object>> tasks = loadTitleTasks(normalizedRunId);
            if (tasks.stream().allMatch(this::isTaskTerminal)) {
                finalizeRunFromTasks(job, tasks);
                return;
            }
            Map<String, Object> task = firstRunnableTask(tasks);
            if (task.isEmpty()) {
                finalizeRunFromTasks(job, tasks);
                return;
            }
            String titleId = titleIdForTask(task);
            completedTitleIds.addAll(titleIdsWithStatus(tasks, STATUS_COMPLETED));
            failedTitleIds.addAll(titleIdsWithStatus(tasks, STATUS_FAILED));
            failedTitleIds.addAll(titleIdsWithStatus(tasks, STATUS_CANCELLED));
            updateJob(
                job,
                STATUS_RUNNING,
                "Rebuilding reader-page pages from existing canonical CBZ archives.",
                runSummary(tasks.size(), completedTitleIds.size(), failedTitleIds.size(), completedTitleIds, failedTitleIds),
                false
            );
            Map<String, Object> runningTask = withTaskStatus(task, STATUS_RUNNING, "Rebuilding title reader-page pages.", 5, Map.of());
            putTitleTask(normalizedRunId, runningTask);
            try (var context = IngestExecutionContext.enter("migration", Map.of("runId", normalizedRunId, "taskId", stringValue(task.get("taskId")), "requestedBy", stringValue(task.get("requestedBy"))))) {
                LibraryTitle title;
                boolean pendingMigration;
                if (WebpMigrationControl.webp()) {
                    LibraryService.MigrationPass pass = libraryService.ingestMigrationTitle(titleId, stringValue(task.get("requestedBy")),
                        () -> cancellationRequestedRunIds.contains(normalizedRunId) || Thread.currentThread().isInterrupted(), value -> { });
                    title = pass.title(); pendingMigration = pass.pending();
                } else {
                    title = libraryService.ingestTitle(titleId, stringValue(task.get("requestedBy")),
                        () -> cancellationRequestedRunIds.contains(normalizedRunId) || Thread.currentThread().isInterrupted(), value -> { }, false);
                    pendingMigration = false;
                }
                if (taskStillWritable(normalizedRunId, stringValue(runningTask.get("taskId")))) {
                    putTitleTask(normalizedRunId, withTaskStatus(
                        runningTask,
                        pendingMigration ? STATUS_QUEUED : STATUS_COMPLETED,
                        pendingMigration ? "Yielded after one chapter for foreground work." : "Title reader-page rebuild completed.",
                        pendingMigration ? 0 : 100,
                        Map.of(
                            "titleId", title.id(),
                            "ingestStatus", title.ingestStatus(),
                            "ingestedChapterCount", title.ingestedChapterCount()
                        )
                    ));
                }
            } catch (LibraryIngestException error) {
                if (pausedRunIds.contains(normalizedRunId)) {
                    putTitleTask(normalizedRunId, withTaskStatus(runningTask, STATUS_QUEUED, "Paused without replacing readable pages.", 0, Map.of("titleId", titleId)));
                    return;
                }
                String status = "ingest_cancelled".equals(error.failureCode()) ? STATUS_CANCELLED : STATUS_FAILED;
                if (taskStillWritable(normalizedRunId, stringValue(runningTask.get("taskId")))) {
                    putTitleTask(normalizedRunId, withTaskStatus(
                        runningTask,
                        status,
                        sanitizeError(error.getMessage()),
                        100,
                        Map.of(
                            "titleId", titleId,
                            "error", sanitizeError(error.getMessage())
                        )
                    ));
                }
                if (!STATUS_CANCELLED.equals(status)) {
                    logger.warn("LIBRARY", "Raven library ingest run failed a title.", "titleId=" + titleId + " error=" + error.getMessage());
                }
            } catch (Exception error) {
                if (taskStillWritable(normalizedRunId, stringValue(runningTask.get("taskId")))) {
                    putTitleTask(normalizedRunId, withTaskStatus(
                        runningTask,
                        STATUS_FAILED,
                        sanitizeError(error.getMessage()),
                        100,
                        Map.of(
                            "titleId", titleId,
                            "error", sanitizeError(error.getMessage())
                        )
                    ));
                }
                logger.warn("LIBRARY", "Raven library ingest run failed a title.", "titleId=" + titleId + " error=" + error.getMessage());
            }
            refreshRunAfterTitle(normalizedRunId);
        } catch (Exception error) {
            logger.error("LIBRARY", "Raven library ingest run failed.", error);
            try {
                Map<String, Object> job = requireRun(normalizedRunId);
                if (!isRunTerminal(job)) {
                    List<Map<String, Object>> tasks = loadTitleTasks(normalizedRunId);
                    updateJob(
                        job,
                        STATUS_FAILED,
                        firstNonBlank(error.getMessage(), "Raven reader-page rebuild failed."),
                        runSummaryFromTasks(tasks),
                        true
                    );
                }
            } catch (Exception updateError) {
                logger.warn("LIBRARY", "Raven could not persist failed library ingest run state.", updateError.getMessage());
            }
        }
    }

    private Map<String, Object> nextRunnableJob() {
        List<Map<String, Object>> candidates = new ArrayList<>();
        for (Map<String, Object> job : collapseDuplicateActiveRuns(loadRunJobs())) {
            String runId = stringValue(job.get("jobId"));
            if (runId.isBlank() || !isDurableActive(job) || isLegacyActiveRun(job)) {
                continue;
            }
            if (activeRunIds.contains(runId) || cancellationRequestedRunIds.contains(runId)) {
                continue;
            }
            String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
            if (STATUS_PREPARING.equals(status)) {
                continue;
            }
            List<Map<String, Object>> tasks = loadTitleTasks(runId);
            if (tasks.isEmpty()) {
                continue;
            }
            if (tasks.stream().allMatch(this::isTaskTerminal)) {
                finalizeRunFromTasks(job, tasks);
                continue;
            }
            if (STATUS_RUNNING.equals(status) && !activeRunIds.contains(runId)) {
                updateJob(
                    job,
                    STATUS_QUEUED,
                    "Recovered detached reader-page rebuild for the fair ingest scheduler.",
                    runSummaryFromTasks(tasks),
                    false
                );
                job = requireRun(runId);
            }
            candidates.add(job);
        }
        return candidates.stream()
            .sorted(this::compareRunnableRuns)
            .findFirst()
            .orElse(Map.of());
    }

    private boolean hasRunnableJobs() {
        if (!migrationControl.enabled()) return false;
        try {
            for (Map<String, Object> job : loadRunJobs()) {
                if (!isDurableActive(job)) {
                    continue;
                }
                if (STATUS_PREPARING.equals(stringValue(job.get("status")).toLowerCase(Locale.ROOT))) {
                    continue;
                }
                List<Map<String, Object>> tasks = loadTitleTasks(stringValue(job.get("jobId")));
                if (tasks.stream().anyMatch((task) -> !isTaskTerminal(task))) {
                    return true;
                }
            }
        } catch (IllegalStateException error) {
            logger.warn("LIBRARY", "Raven could not check for runnable library ingest work.", rootMessage(error));
        }
        return false;
    }

    private int compareRunnableRuns(Map<String, Object> left, Map<String, Object> right) {
        int priority = Integer.compare(libraryTypePriority(left), libraryTypePriority(right));
        if (priority != 0) {
            return priority;
        }
        int updated = Long.compare(runOrderTimestamp(left), runOrderTimestamp(right));
        if (updated != 0) {
            return updated;
        }
        return stringValue(left.get("jobId")).compareTo(stringValue(right.get("jobId")));
    }

    private int libraryTypePriority(Map<String, Object> job) {
        String type = stringValue(normalizeMap(job.get("payload")).get("libraryTypeSlug")).toLowerCase(Locale.ROOT);
        int index = CLEAN_RESTART_ORDER.indexOf(type);
        return index >= 0 ? index : CLEAN_RESTART_ORDER.size();
    }

    private long runOrderTimestamp(Map<String, Object> job) {
        long updatedAt = parseInstantMillis(stringValue(job.get("updatedAt")));
        if (updatedAt > 0) {
            return updatedAt;
        }
        long createdAt = parseInstantMillis(stringValue(job.get("createdAt")));
        return createdAt > 0 ? createdAt : Long.MAX_VALUE;
    }

    private Map<String, Object> firstRunnableTask(List<Map<String, Object>> tasks) {
        return tasks.stream()
            .filter((task) -> !isTaskTerminal(task))
            .findFirst()
            .orElse(Map.of());
    }

    private boolean taskStillWritable(String runId, String taskId) {
        Map<String, Object> job = requireRun(runId);
        if (isRunTerminal(job)) {
            return false;
        }
        return loadTitleTasks(runId).stream()
            .filter((task) -> taskId.equals(stringValue(task.get("taskId"))))
            .findFirst()
            .map((task) -> !isTaskTerminal(task))
            .orElse(false);
    }

    private void refreshRunAfterTitle(String runId) {
        Map<String, Object> job = requireRun(runId);
        if (isRunTerminal(job) || "paused".equals(job.get("status")) || !migrationControl.enabled()) {
            return;
        }
        List<Map<String, Object>> tasks = loadTitleTasks(runId);
        Map<String, Object> summary = runSummaryFromTasks(tasks);
        if (tasks.stream().allMatch(this::isTaskTerminal)) {
            boolean failed = toInt(summary.get("failedTitles"), 0) > 0;
            updateJob(
                job,
                failed ? STATUS_FAILED : STATUS_COMPLETED,
                failed ? "Raven reader-page rebuild completed with failed title(s)." : "Raven reader-page rebuild completed.",
                summary,
                true
            );
            return;
        }
        int finished = toInt(summary.get("completedTitles"), 0) + toInt(summary.get("failedTitles"), 0);
        updateJob(
            job,
            STATUS_QUEUED,
            "Waiting for the fair reader-page ingest scheduler after rebuilding " + finished + " of " + tasks.size() + " title(s).",
            summary,
            false
        );
    }

    private void reconcileRun(Map<String, Object> job) {
        String runId = stringValue(job.get("jobId"));
        String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
        if (runId.isBlank() || (!STATUS_PREPARING.equals(status) && !STATUS_QUEUED.equals(status) && !STATUS_RUNNING.equals(status))) {
            return;
        }
        if (activeRunIds.contains(runId)) {
            return;
        }
        if (STATUS_PREPARING.equals(status)) {
            Map<String, Object> payload = normalizeMap(job.get("payload"));
            scheduleRunPreparation(
                runId,
                stringValue(payload.get("libraryTypeSlug")).toLowerCase(Locale.ROOT),
                firstNonBlank(stringValue(job.get("requestedBy")), "scriptarr-admin")
            );
            return;
        }

        List<Map<String, Object>> tasks = resetRunningTasksToQueued(runId, loadTitleTasks(runId));
        if (tasks.stream().allMatch(this::isTaskTerminal)) {
            finalizeRunFromTasks(job, tasks);
            return;
        }
        if (STATUS_RUNNING.equals(status)) {
            updateJob(
                job,
                STATUS_QUEUED,
                "Recovered detached reader-page rebuild for the fair ingest scheduler.",
                runSummaryFromTasks(tasks),
                false
            );
        }

        logger.warn(
            "LIBRARY",
            "Raven recovered a detached library ingest run.",
            "runId=" + runId + " status=" + status + " unfinishedTasks=" + tasks.stream().filter((task) -> !isTaskTerminal(task)).count()
        );
        scheduleRunWorker();
    }

    private void finalizeRunFromTasks(Map<String, Object> job, List<Map<String, Object>> tasks) {
        List<String> completedTitleIds = titleIdsWithStatus(tasks, STATUS_COMPLETED);
        List<String> failedTitleIds = new ArrayList<>(titleIdsWithStatus(tasks, STATUS_FAILED));
        failedTitleIds.addAll(titleIdsWithStatus(tasks, STATUS_CANCELLED));
        boolean failed = !failedTitleIds.isEmpty();
        updateJob(
            job,
            failed ? STATUS_FAILED : STATUS_COMPLETED,
            failed ? "Raven reader-page rebuild completed with failed title(s)." : "Raven reader-page rebuild completed.",
            runSummaryFromTasks(tasks),
            true
        );
    }

    private synchronized boolean scheduleRunWorker() {
        if (worker.isShutdown() || !migrationControl.enabled()) {
            return false;
        }
        boolean scheduled = false;
        while (workerSlotsInUse < titleLaneCount) {
            Map<String, Object> job = nextRunnableJob();
            if (job.isEmpty()) {
                break;
            }
            String runId = normalizeRunId(stringValue(job.get("jobId")));
            if (runId.isBlank() || !activeRunIds.add(runId)) {
                break;
            }
            workerSlotsInUse += 1;
            schedulerRunning = true;
            if (schedulerStartedAtMillis <= 0) {
                schedulerStartedAtMillis = Instant.now().toEpochMilli();
            }
            try {
                worker.execute(() -> runSchedulerLoop(runId));
                scheduled = true;
            } catch (RejectedExecutionException error) {
                activeRunIds.remove(runId);
                workerSlotsInUse = Math.max(0, workerSlotsInUse - 1);
                schedulerRunning = workerSlotsInUse > 0;
                if (!schedulerRunning) {
                    schedulerStartedAtMillis = 0;
                }
                logger.warn("LIBRARY", "Raven library ingest-run worker could not accept a durable run.", error.getMessage());
                break;
            }
        }
        return scheduled;
    }

    private boolean schedulerStartupIsStale() {
        long startedAt = schedulerStartedAtMillis;
        return startedAt > 0 && Instant.now().toEpochMilli() - startedAt > SCHEDULER_STARTUP_STALE_MILLIS;
    }

    private List<Map<String, Object>> resetRunningTasksToQueued(String runId, List<Map<String, Object>> tasks) {
        List<Map<String, Object>> refreshed = new ArrayList<>();
        for (Map<String, Object> task : tasks) {
            if (STATUS_RUNNING.equals(stringValue(task.get("status")).toLowerCase(Locale.ROOT))) {
                Map<String, Object> reset = withTaskStatus(
                    task,
                    STATUS_QUEUED,
                    "Recovered stale title reader-page rebuild for the fair ingest scheduler.",
                    Math.max(0, Math.min(95, toInt(task.get("percent"), 0))),
                    normalizeMap(task.get("result"))
                );
                putTitleTask(runId, reset);
                refreshed.add(reset);
            } else {
                refreshed.add(task);
            }
        }
        return List.copyOf(refreshed);
    }

    private Map<String, Object> runSummaryFromTasks(List<Map<String, Object>> tasks) {
        List<String> completedTitleIds = titleIdsWithStatus(tasks, STATUS_COMPLETED);
        List<String> failedTitleIds = new ArrayList<>(titleIdsWithStatus(tasks, STATUS_FAILED));
        failedTitleIds.addAll(titleIdsWithStatus(tasks, STATUS_CANCELLED));
        return runSummary(tasks.size(), completedTitleIds.size(), failedTitleIds.size(), completedTitleIds, failedTitleIds);
    }

    private Set<String> retryableLibraryTypes() {
        Object titles = libraryService.listIngestBacklog().get("titles");
        if (!(titles instanceof List<?> rows)) {
            return new LinkedHashSet<>();
        }
        Set<String> types = new LinkedHashSet<>();
        for (Object entry : rows) {
            if (!(entry instanceof Map<?, ?> row)) {
                continue;
            }
            Map<String, Object> title = normalizeMap(row);
            if ("ready".equals(stringValue(title.get("ingestStatus")).toLowerCase(Locale.ROOT))) {
                continue;
            }
            String type = LibraryNaming.normalizeTypeSlug(firstNonBlank(
                stringValue(title.get("libraryTypeSlug")),
                stringValue(title.get("mediaType")),
                stringValue(title.get("requestType"))
            ));
            if (ALLOWED_TYPE_SLUGS.contains(type)) {
                types.add(type);
            }
        }
        return types;
    }

    private boolean isDurableActive(Map<String, Object> job) {
        String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
        return STATUS_PREPARING.equals(status) || STATUS_QUEUED.equals(status) || STATUS_RUNNING.equals(status);
    }

    private boolean isRunTerminal(Map<String, Object> job) {
        String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
        return STATUS_COMPLETED.equals(status)
            || STATUS_FAILED.equals(status)
            || STATUS_CANCELLED.equals(status)
            || STATUS_SUPERSEDED.equals(status);
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
        task.put("message", "Queued title reader-page rebuild.");
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
        if (STATUS_COMPLETED.equals(status) || STATUS_FAILED.equals(status) || STATUS_CANCELLED.equals(status) || STATUS_SUPERSEDED.equals(status)) {
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
            .map(this::loadIngestTitle)
            .filter((title) -> title != null)
            .filter((title) -> !WebpMigrationControl.webp() || title.chapters().stream().anyMatch(chapter -> chapter.available() && chapter.archivePath() != null && !chapter.archivePath().isBlank()))
            .toList();
    }

    /** @param titleId exact canonical card identity @return full title without silently omitting broker failures @throws IllegalStateException when migration ownership cannot be loaded */
    private LibraryTitle loadIngestTitle(String titleId) {
        if (!WebpMigrationControl.webp()) return libraryService.findTitleById(titleId);
        try {
            JsonNode row = brokerClient.getLibraryTitle(titleId);
            if (row == null || !row.isObject() || !titleId.equals(row.path("id").asText()) || !row.path("chapters").isArray()) throw new IllegalStateException("Migration catalog scope is unavailable.");
            return objectMapper.treeToValue(row, LibraryTitle.class);
        } catch (Exception unavailable) { throw new IllegalStateException("Could not load a complete migration title snapshot.", unavailable); }
    }

    private Map<String, Object> activeRunForType(String libraryTypeSlug) {
        List<Map<String, Object>> activeRuns = new ArrayList<>();
        for (Map<String, Object> job : loadRunJobs()) {
            String jobType = stringValue(normalizeMap(job.get("payload")).get("libraryTypeSlug")).toLowerCase(Locale.ROOT);
            if (libraryTypeSlug.equals(jobType) && isDurableActive(job)) {
                activeRuns.add(job);
            }
        }
        activeRuns.sort(this::compareDuplicateActiveRuns);
        for (int index = 1; index < activeRuns.size(); index += 1) {
            supersedeRunJobOnly(activeRuns.get(index), "Superseded duplicate active reader-page rebuild for " + libraryTypeSlug + ".");
        }
        return activeRuns.isEmpty() ? Map.of() : activeRuns.getFirst();
    }

    private boolean activeRunNeedsCanonicalRestart(Map<String, Object> job, List<LibraryTitle> currentTitles) {
        String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
        if (STATUS_PREPARING.equals(status)) {
            return false;
        }
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
                supersedeRun(job, "Superseded by reader-page reader-page migration.");
            }
        }
    }

    private boolean isLegacyActiveRun(Map<String, Object> job) {
        String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
        if (!STATUS_PREPARING.equals(status) && !STATUS_QUEUED.equals(status) && !STATUS_RUNNING.equals(status)) {
            return false;
        }
        Map<String, Object> payload = normalizeMap(job.get("payload"));
        String format = stringValue(payload.get("format")).toLowerCase(Locale.ROOT);
        String mode = stringValue(payload.get("mode")).toLowerCase(Locale.ROOT);
        return !INGEST_FORMAT.equals(format) || !INGEST_MODE.equals(mode);
    }

    private void supersedeRun(Map<String, Object> job, String message) {
        String runId = stringValue(job.get("jobId"));
        cancellationRequestedRunIds.add(runId);
        activeRunIds.remove(runId);
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
            runSummaryFromTasks(loadTitleTasks(runId)),
            true
        );
    }

    private void supersedeRunJobOnly(Map<String, Object> job, String message) {
        String runId = stringValue(job.get("jobId"));
        cancellationRequestedRunIds.add(runId);
        activeRunIds.remove(runId);
        updateJob(
            job,
            STATUS_SUPERSEDED,
            firstNonBlank(message, "Superseded by a newer reader-page ingest run."),
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
                || STATUS_CANCELLED.equals(status);
        }
        if ("active".equals(filter)) {
            return isDurableActive(job);
        }
        return filter.equals(status);
    }

    private List<Map<String, Object>> collapseDuplicateActiveRuns(List<Map<String, Object>> jobs) {
        Map<String, List<Map<String, Object>>> runsByType = new LinkedHashMap<>();
        for (Map<String, Object> job : Optional.ofNullable(jobs).orElse(List.of())) {
            if (!isDurableActive(job) || isLegacyActiveRun(job)) {
                continue;
            }
            String type = stringValue(normalizeMap(job.get("payload")).get("libraryTypeSlug")).toLowerCase(Locale.ROOT);
            if (type.isBlank()) {
                continue;
            }
            runsByType.computeIfAbsent(type, ignored -> new ArrayList<>()).add(job);
        }

        int supersededCount = 0;
        for (Map.Entry<String, List<Map<String, Object>>> entry : runsByType.entrySet()) {
            List<Map<String, Object>> activeRuns = entry.getValue();
            if (activeRuns.size() <= 1) {
                continue;
            }
            activeRuns.sort(this::compareDuplicateActiveRuns);
            for (int index = 1; index < activeRuns.size(); index += 1) {
                supersedeRunJobOnly(activeRuns.get(index), "Superseded duplicate active reader-page rebuild for " + entry.getKey() + ".");
                supersededCount += 1;
            }
        }
        if (supersededCount > 0) {
            logger.warn(
                "LIBRARY",
                "Raven superseded duplicate active reader-page ingest runs.",
                "count=" + supersededCount
            );
            return loadRunJobs();
        }
        return Optional.ofNullable(jobs).orElse(List.of());
    }

    private int compareDuplicateActiveRuns(Map<String, Object> left, Map<String, Object> right) {
        String leftId = stringValue(left.get("jobId"));
        String rightId = stringValue(right.get("jobId"));
        int workerActive = Boolean.compare(activeRunIds.contains(rightId), activeRunIds.contains(leftId));
        if (workerActive != 0) {
            return workerActive;
        }
        int updated = Long.compare(runOrderTimestamp(right), runOrderTimestamp(left));
        if (updated != 0) {
            return updated;
        }
        int status = Integer.compare(activeDuplicateStatusRank(left), activeDuplicateStatusRank(right));
        if (status != 0) {
            return status;
        }
        return leftId.compareTo(rightId);
    }

    private int activeDuplicateStatusRank(Map<String, Object> job) {
        String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
        if (STATUS_RUNNING.equals(status)) {
            return 0;
        }
        if (STATUS_QUEUED.equals(status)) {
            return 1;
        }
        if (STATUS_PREPARING.equals(status)) {
            return 2;
        }
        return 3;
    }

    private Map<String, Object> runSummaryRow(Map<String, Object> job, Map<String, Integer> positions) {
        Map<String, Object> payload = normalizeMap(job.get("payload"));
        Map<String, Object> result = normalizeMap(job.get("result"));
        String runId = stringValue(job.get("jobId"));
        String status = stringValue(job.get("status"));
        List<Map<String, Object>> tasks = loadTitleTasks(runId);
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
        summary.put("active", isDurableActive(job));
        summary.put("requestedBy", stringValue(job.get("requestedBy")));
        summary.put("libraryTypeSlug", stringValue(payload.get("libraryTypeSlug")));
        summary.put("libraryTypeLabel", firstNonBlank(stringValue(payload.get("libraryTypeLabel")), typeLabelForSlug(stringValue(payload.get("libraryTypeSlug")))));
        summary.put("format", firstNonBlank(stringValue(payload.get("format")), INGEST_FORMAT));
        summary.put("mode", firstNonBlank(stringValue(payload.get("mode")), INGEST_MODE));
        summary.put("message", firstNonBlank(stringValue(job.get("message")), messageForRunStatus(status)));
        summary.put("counts", counts);
        summary.put("percent", percent);
        summary.put("etaMinutes", estimateEtaMinutes(job, percent));
        summary.put("runtime", runtimeSummary(job, tasks, positions));
        summary.put("current", currentTaskSummary(tasks));
        summary.put("createdAt", stringValue(job.get("createdAt")));
        summary.put("startedAt", stringValue(job.get("startedAt")));
        summary.put("finishedAt", stringValue(job.get("finishedAt")));
        summary.put("updatedAt", stringValue(job.get("updatedAt")));
        return summary;
    }

    private String messageForRunStatus(String status) {
        String normalized = stringValue(status).toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case STATUS_PREPARING -> "Preparing title tasks for the fair reader-page scheduler.";
            case STATUS_QUEUED -> "Waiting for reader-page worker slot.";
            case STATUS_RUNNING -> "Running current title reader-page rebuild.";
            case STATUS_COMPLETED -> "reader-page rebuild completed.";
            case STATUS_FAILED -> "reader-page rebuild completed with failed title(s).";
            case STATUS_CANCELLED -> "reader-page rebuild cancelled.";
            case STATUS_SUPERSEDED -> "reader-page rebuild superseded.";
            default -> "reader-page rebuild state updated.";
        };
    }

    private Map<String, Integer> activeRunPositions(List<Map<String, Object>> jobs) {
        List<Map<String, Object>> active = jobs.stream()
            .filter(this::isDurableActive)
            .sorted(this::compareRunnableRuns)
            .toList();
        Map<String, Integer> positions = new LinkedHashMap<>();
        int position = 1;
        for (Map<String, Object> job : active) {
            String runId = stringValue(job.get("jobId"));
            boolean running = activeRunIds.contains(runId);
            positions.put(runId, running ? 0 : position);
            if (!running) {
                position += 1;
            }
        }
        return positions;
    }

    private String firstActiveRunId() {
        return activeRunIds.stream().sorted().findFirst().orElse("");
    }

    private Map<String, Object> runtimeSummary(
        Map<String, Object> job,
        List<Map<String, Object>> tasks,
        Map<String, Integer> positions
    ) {
        String runId = stringValue(job.get("jobId"));
        String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
        boolean workerActive = activeRunIds.contains(runId);
        boolean terminal = isRunTerminal(job);
        boolean preparing = STATUS_PREPARING.equals(status);
        boolean schedulerPreflight = schedulerRunning && activeRunIds.isEmpty();
        boolean schedulerStalled = schedulerRunning
            && activeRunIds.isEmpty()
            && schedulerStartupIsStale()
            && !preparing
            && tasks.stream().anyMatch((task) -> !isTaskTerminal(task));
        boolean needsRecovery = (STATUS_RUNNING.equals(status) && !workerActive) || schedulerStalled;
        String schedulerState;
        if (terminal) {
            schedulerState = "terminal";
        } else if (workerActive) {
            schedulerState = "running";
        } else if (preparing) {
            schedulerState = "waiting";
        } else if (needsRecovery) {
            schedulerState = "needs-recovery";
        } else if (schedulerPreflight && isDurableActive(job)) {
            schedulerState = "waiting";
        } else if (isDurableActive(job)) {
            schedulerState = schedulerRunning ? "waiting" : "detached";
        } else {
            schedulerState = "detached";
        }
        Map<String, Object> runtime = new LinkedHashMap<>();
        runtime.put("schedulerState", schedulerState);
        runtime.put("workerActive", workerActive);
        runtime.put("needsRecovery", needsRecovery || ("detached".equals(schedulerState) && tasks.stream().anyMatch((task) -> !isTaskTerminal(task))));
        runtime.put("queuedPosition", positions.getOrDefault(runId, workerActive ? 0 : null));
        runtime.put("blockedByRunId", !workerActive && schedulerRunning ? firstActiveRunId() : "");
        runtime.put("titleLanes", titleLaneCount);
        runtime.put("activeTitleLanes", activeRunIds.size());
        runtime.put("lastProgressAt", lastProgressAt(job, tasks));
        runtime.put("checkedAt", Instant.now().toString());
        return runtime;
    }

    private Map<String, Object> currentTaskSummary(List<Map<String, Object>> tasks) {
        Map<String, Object> task = tasks.stream()
            .filter((entry) -> STATUS_RUNNING.equals(stringValue(entry.get("status")).toLowerCase(Locale.ROOT)))
            .findFirst()
            .orElseGet(() -> firstRunnableTask(tasks));
        if (task.isEmpty()) {
            return Map.of();
        }
        Map<String, Object> payload = normalizeMap(task.get("payload"));
        Map<String, Object> current = new LinkedHashMap<>();
        current.put("taskId", stringValue(task.get("taskId")));
        current.put("titleId", titleIdForTask(task));
        current.put("titleName", firstNonBlank(stringValue(payload.get("titleName")), stringValue(task.get("label"))));
        current.put("status", stringValue(task.get("status")));
        return current;
    }

    private String lastProgressAt(Map<String, Object> job, List<Map<String, Object>> tasks) {
        long latest = parseInstantMillis(stringValue(job.get("updatedAt")));
        for (Map<String, Object> task : tasks) {
            latest = Math.max(latest, parseInstantMillis(stringValue(task.get("updatedAt"))));
        }
        return latest > 0 ? Instant.ofEpochMilli(latest).toString() : "";
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

    private List<String> orderedLibraryTypes(Set<String> libraryTypes) {
        Set<String> normalized = Optional.ofNullable(libraryTypes).orElse(Set.of()).stream()
            .map(LibraryNaming::normalizeTypeSlug)
            .filter(ALLOWED_TYPE_SLUGS::contains)
            .collect(Collectors.toCollection(LinkedHashSet::new));
        List<String> ordered = new ArrayList<>();
        for (String type : CLEAN_RESTART_ORDER) {
            if (normalized.remove(type)) {
                ordered.add(type);
            }
        }
        ordered.addAll(normalized.stream().sorted().toList());
        return List.copyOf(ordered);
    }

    private int compactSupersededRun(Map<String, Object> job) {
        Map<String, Object> payload = new LinkedHashMap<>(normalizeMap(job.get("payload")));
        if (Boolean.TRUE.equals(payload.get("compacted"))) {
            return 0;
        }
        payload.put("compacted", true);
        payload.put("compactedAt", Instant.now().toString());
        Map<String, Object> compacted = new LinkedHashMap<>(job);
        compacted.put("payload", payload);
        compacted.put("message", firstNonBlank(stringValue(job.get("message")), "Superseded reader-page rebuild compacted."));
        compacted.put("updatedAt", Instant.now().toString());
        putJob(stringValue(job.get("jobId")), compacted);
        return 1;
    }

    /** @return bounded title lanes from the process environment */
    private static int resolveConfiguredTitleLanes() {
        return resolveConfiguredTitleLanes(System.getenv());
    }

    /**
     * Resolve the established title-lane policy without mutating the process environment.
     * @param env process environment or isolated test values
     * @return configured lanes bounded to one through three, or the existing default
     */
    static int resolveConfiguredTitleLanes(Map<String, String> env) {
        String raw = Optional.ofNullable(env.get("SCRIPTARR_RAVEN_AVIF_TITLE_LANES"))
            .filter((value) -> !value.isBlank())
            .orElseGet(() -> Optional.ofNullable(env.get("SCRIPTARR_RAVEN_INGEST_TITLE_LANES")).orElse(""));
        try {
            return raw == null || raw.isBlank()
                ? DEFAULT_TITLE_LANES
                : Math.max(1, Math.min(MAX_TITLE_LANES, Integer.parseInt(raw.trim())));
        } catch (NumberFormatException ignored) {
            return DEFAULT_TITLE_LANES;
        }
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

    private static final class TitleLaneThreadFactory implements java.util.concurrent.ThreadFactory {
        private final AtomicInteger counter = new AtomicInteger(1);

        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "raven-library-ingest-title-" + counter.getAndIncrement());
            thread.setDaemon(true);
            return thread;
        }
    }
}
