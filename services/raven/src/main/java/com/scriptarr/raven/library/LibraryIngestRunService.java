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
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Durable WebP rebuild runs for Raven library types.
 */
@Service
public final class LibraryIngestRunService {
    private static final String OWNER_SERVICE = "scriptarr-raven";
    private static final String RUN_JOB_KIND = "raven-library-ingest";
    private static final String STATUS_QUEUED = "queued";
    private static final String STATUS_RUNNING = "running";
    private static final String STATUS_COMPLETED = "completed";
    private static final String STATUS_FAILED = "failed";
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

    /**
     * Create the durable Raven library ingest-run service.
     *
     * @param libraryService existing title-level WebP ingest service
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
     * Create and start a WebP-only rebuild run for one library type slug.
     *
     * @param body caller payload with libraryTypeSlug/type and requestedBy
     * @return durable run status payload
     */
    public synchronized Map<String, Object> createRun(Map<String, Object> body) {
        Map<String, Object> request = body == null ? Map.of() : body;
        String libraryTypeSlug = resolveLibraryTypeSlug(request);
        String requestedBy = firstNonBlank(stringValue(request.get("requestedBy")), "scriptarr-admin");
        Map<String, Object> activeRun = activeRunForType(libraryTypeSlug);
        if (!activeRun.isEmpty()) {
            Map<String, Object> existingStatus = status(stringValue(activeRun.get("jobId")));
            existingStatus.put("reused", true);
            existingStatus.put("message", "Raven already has an active library ingest run for " + libraryTypeSlug + ".");
            return existingStatus;
        }

        List<LibraryTitle> titles = titlesForType(libraryTypeSlug);
        String runId = "ingestrun_" + UUID.randomUUID().toString().replace("-", "");
        String now = Instant.now().toString();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("libraryTypeSlug", libraryTypeSlug);
        payload.put("libraryTypeLabel", typeLabelForSlug(libraryTypeSlug));
        payload.put("mode", "webp-force-rebuild");
        payload.put("titleCount", titles.size());

        Map<String, Object> job = new LinkedHashMap<>();
        job.put("jobId", runId);
        job.put("kind", RUN_JOB_KIND);
        job.put("ownerService", OWNER_SERVICE);
        job.put("status", STATUS_QUEUED);
        job.put("label", "Raven WebP rebuild");
        job.put("message", "Queued WebP rebuild from existing canonical CBZ archives.");
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
     * Resume queued or running library ingest runs after Raven restarts.
     */
    @PostConstruct
    public void resumeInterruptedRuns() {
        try {
            for (Map<String, Object> job : loadRunJobs()) {
                String status = stringValue(job.get("status")).toLowerCase(Locale.ROOT);
                if (STATUS_QUEUED.equals(status) || STATUS_RUNNING.equals(status)) {
                    tryScheduleRunWorker(stringValue(job.get("jobId")));
                }
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
            updateJob(
                job,
                STATUS_RUNNING,
                "Rebuilding WebP pages from existing canonical CBZ archives.",
                runSummary(tasks.size(), 0, 0, List.of(), List.of()),
                false
            );

            for (Map<String, Object> task : tasks) {
                String titleId = stringValue(normalizeMap(task.get("payload")).get("titleId"));
                Map<String, Object> runningTask = withTaskStatus(task, STATUS_RUNNING, "Rebuilding title WebP pages.", 5, Map.of());
                putTitleTask(runId, runningTask);
                try {
                    LibraryTitle title = libraryService.ingestTitle(titleId, stringValue(task.get("requestedBy")));
                    completedTitleIds.add(titleId);
                    putTitleTask(runId, withTaskStatus(
                        runningTask,
                        STATUS_COMPLETED,
                        "Title WebP rebuild completed.",
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
                failed ? "Raven WebP rebuild completed with failed title(s)." : "Raven WebP rebuild completed.",
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
                    firstNonBlank(error.getMessage(), "Raven WebP rebuild failed."),
                    runSummary(tasks.size(), completedTitleIds.size(), failedTitleIds.size(), completedTitleIds, failedTitleIds),
                    true
                );
            } catch (Exception updateError) {
                logger.warn("LIBRARY", "Raven could not persist failed library ingest run state.", updateError.getMessage());
            }
        }
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
        payload.put("mode", "webp-force-rebuild");

        Map<String, Object> task = new LinkedHashMap<>();
        task.put("taskId", titleTaskId(runId, title.id()));
        task.put("taskKey", title.id());
        task.put("status", STATUS_QUEUED);
        task.put("label", title.title());
        task.put("message", "Queued title WebP rebuild.");
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
        if (STATUS_COMPLETED.equals(status) || STATUS_FAILED.equals(status)) {
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
            return jobs;
        } catch (Exception error) {
            throw new IllegalStateException("Raven could not load durable library ingest runs.", error);
        }
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
