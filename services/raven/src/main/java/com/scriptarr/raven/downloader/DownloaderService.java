package com.scriptarr.raven.downloader;

import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryNaming;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.metadata.MetadataService;
import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.settings.RavenNamingSettings;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.ScriptarrLogger;
import com.scriptarr.raven.vpn.VpnService;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.PriorityBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Serialized Raven download queue that scrapes chapters, stages them under the
 * downloading root, and promotes completed titles into the downloaded root.
 */
@Service
public class DownloaderService {
    private static final String DOWNLOADING_FOLDER_NAME = "downloading";
    private static final String DOWNLOADED_FOLDER_NAME = "downloaded";
    private static final String DOWNLOAD_JOB_KIND = "download";
    private static final String SUPERSEDED_STATUS = "superseded";
    private static final String PRIORITY_HIGH = "high";
    private static final String PRIORITY_NORMAL = "normal";
    private static final String PRIORITY_LOW = "low";
    private static final int PAGE_DOWNLOAD_WORKER_COUNT = 2;
    private static final int CHAPTER_SOURCE_RETRY_ATTEMPTS = 3;
    private static final int CHAPTER_DOWNLOAD_RETRY_ATTEMPTS = 3;
    private static final int IMAGE_DOWNLOAD_RETRY_ATTEMPTS = 3;
    private static final int CHAPTER_DOWNLOAD_PROGRESS_CAP = 90;
    private static final Duration IMAGE_DOWNLOAD_TIMEOUT = Duration.ofSeconds(30);
    private static final Duration PAGE_DOWNLOAD_TIMEOUT = Duration.ofMinutes(2);
    private static final int RESTORE_RETRY_ATTEMPTS = 6;
    private static final Duration RESTORE_RETRY_BACKOFF = Duration.ofSeconds(5);
    private static final long RETRY_BACKOFF_MS = 1_500L;
    private static final String WEBCENTRAL_PROVIDER_ID = "weebcentral";
    private static final String WEBCENTRAL_REFERER = "https://weebcentral.com";
    private static final String USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

    private final Map<String, Map<String, Object>> tasks = new ConcurrentHashMap<>();
    private final AtomicLong queueSequence = new AtomicLong();
    private ThreadPoolExecutor queueWorker = createQueueWorker();
    private java.util.concurrent.ExecutorService pageDownloadWorker = createPageDownloadWorker();
    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build();

    private final DownloadProviderRegistry downloadProviderRegistry;
    private final VpnService vpnService;
    private final LibraryService libraryService;
    private final DownloadIntakeService downloadIntakeService;
    private final MetadataService metadataService;
    private final RavenBrokerClient brokerClient;
    private final RavenSettingsService settingsService;
    private final ScriptarrLogger logger;

    /**
     * Create the download queue service.
     *
     * @param downloadProviderRegistry registry of enabled Raven download providers
     * @param vpnService VPN coordinator for optional protected downloads
     * @param libraryService library projection and persistence service
     * @param downloadIntakeService metadata-first Raven intake service
     * @param metadataService metadata persistence service
     * @param brokerClient Sage-backed broker client for Raven state
     * @param settingsService Sage-backed Raven settings service
     * @param logger shared Raven logger
     */
    public DownloaderService(
        DownloadProviderRegistry downloadProviderRegistry,
        VpnService vpnService,
        LibraryService libraryService,
        DownloadIntakeService downloadIntakeService,
        MetadataService metadataService,
        RavenBrokerClient brokerClient,
        RavenSettingsService settingsService,
        ScriptarrLogger logger
    ) {
        this.downloadProviderRegistry = downloadProviderRegistry;
        this.vpnService = vpnService;
        this.libraryService = libraryService;
        this.downloadIntakeService = downloadIntakeService;
        this.metadataService = metadataService;
        this.brokerClient = brokerClient;
        this.settingsService = settingsService;
        this.logger = logger;
    }

    /**
     * Restore queued Raven download tasks so the serialized worker can resume
     * after a container restart.
     */
    @PostConstruct
    public void restorePersistedTasks() {
        for (int attempt = 1; attempt <= RESTORE_RETRY_ATTEMPTS; attempt++) {
            try {
                restorePersistedTasksOnce();
                return;
            } catch (Exception error) {
                logger.warn(
                    "DOWNLOAD",
                    "Failed to restore persisted Raven tasks.",
                    "attempt=" + attempt + "/" + RESTORE_RETRY_ATTEMPTS + " reason="
                        + normalizeString(error.getMessage(), "unknown")
                );
                if (attempt < RESTORE_RETRY_ATTEMPTS && !sleepBeforeRestoreRetry()) {
                    return;
                }
            }
        }
    }

    private void restorePersistedTasksOnce() throws Exception {
            var payload = brokerClient.listDownloadTasks();
            if (payload == null || !payload.isArray()) {
                return;
            }

            List<Map<String, Object>> restoredTasks = new ArrayList<>();
            Map<String, Map<String, Object>> activeByKey = new LinkedHashMap<>();

            payload.forEach((node) -> {
                Map<String, Object> task = new LinkedHashMap<>();
                task.put("taskId", node.path("taskId").asText(""));
                task.put("jobId", node.path("jobId").asText(node.path("taskId").asText("")));
                task.put("titleId", node.path("titleId").asText(""));
                task.put("titleName", node.path("titleName").asText(""));
                task.put("titleUrl", node.path("titleUrl").asText(""));
                task.put("requestType", node.path("requestType").asText("manga"));
                task.put("requestedBy", node.path("requestedBy").asText("scriptarr"));
                task.put("status", node.path("status").asText("queued"));
                task.put("message", node.path("message").asText(""));
                task.put("percent", node.path("percent").asInt(0));
                task.put("queuedAt", node.path("queuedAt").asText(Instant.now().toString()));
                task.put("updatedAt", node.path("updatedAt").asText(Instant.now().toString()));
                copyIfPresent(node, task, "providerId");
                copyIfPresent(node, task, "requestId");
                copyIfPresent(node, task, "replacementTitleId");
                copyIfPresent(node, task, "libraryTypeLabel");
                copyIfPresent(node, task, "libraryTypeSlug");
                copyIfPresent(node, task, "workingRoot");
                copyIfPresent(node, task, "downloadRoot");
                copyIfPresent(node, task, "coverUrl");
                if (node.hasNonNull("details")) {
                    var detailsNode = node.path("details");
                    task.put("details", brokerClientPayloadToMap(detailsNode));
                    if (detailsNode.has("selectedMetadata")) {
                        task.put("selectedMetadata", brokerClientPayloadToMap(detailsNode.path("selectedMetadata")));
                    }
                    if (detailsNode.has("selectedDownload")) {
                        task.put("selectedDownload", brokerClientPayloadToMap(detailsNode.path("selectedDownload")));
                    }
                    if (detailsNode.hasNonNull("coverUrl") && !detailsNode.path("coverUrl").asText("").isBlank()) {
                        task.put("coverUrl", detailsNode.path("coverUrl").asText(""));
                    }
                }

                String taskId = String.valueOf(task.get("taskId"));
                if (taskId.isBlank()) {
                    return;
                }

                String status = String.valueOf(task.get("status"));
                if ("queued".equals(status) || "running".equals(status)) {
                    String dedupeKey = restorableTaskKey(task);
                    if (!dedupeKey.isBlank()) {
                        Map<String, Object> existing = activeByKey.get(dedupeKey);
                        if (existing == null) {
                            activeByKey.put(dedupeKey, task);
                        } else if (compareTaskFreshness(task, existing) >= 0) {
                            markTaskSuperseded(existing, taskId);
                            activeByKey.put(dedupeKey, task);
                        } else {
                            markTaskSuperseded(task, String.valueOf(existing.getOrDefault("taskId", "")));
                        }
                    }
                }

                restoredTasks.add(task);
            });

            for (Map<String, Object> task : restoredTasks) {
                String taskId = String.valueOf(task.get("taskId"));
                tasks.put(taskId, task);
                persistTask(taskId);

                String status = String.valueOf(task.getOrDefault("status", ""));
                if ("failed".equals(status) && isRecoverablePersistFailure(task) && recoverCompletedTask(taskId)) {
                    continue;
                }
                if (!"queued".equals(status) && !"running".equals(status)) {
                    continue;
                }

                if (recoverCompletedTask(taskId)) {
                    continue;
                }

                task.put("status", "queued");
                task.put("message", "Restored after Raven restart.");
                persistTask(taskId);
                submitQueuedTask(taskId, new DownloadRequest(
                    String.valueOf(task.get("titleName")),
                    String.valueOf(task.get("titleUrl")),
                    String.valueOf(task.get("requestType")),
                    String.valueOf(task.get("requestedBy")),
                    String.valueOf(task.getOrDefault("providerId", "")),
                    String.valueOf(task.getOrDefault("requestId", "")),
                    normalizeMap(task.get("selectedMetadata")),
                    normalizeMap(task.get("selectedDownload")),
                    String.valueOf(task.getOrDefault("replacementTitleId", "")),
                    String.valueOf(task.getOrDefault("priority", PRIORITY_NORMAL))
                ));
        }
    }

    private boolean isRecoverablePersistFailure(Map<String, Object> task) {
        String message = normalizeString(task.get("message")).toLowerCase(Locale.ROOT);
        return "failed".equals(normalizeString(task.get("status")).toLowerCase(Locale.ROOT))
            && (message.contains("persist raven title") || message.contains("persist raven chapters"));
    }

    private boolean sleepBeforeRestoreRetry() {
        try {
            Thread.sleep(RESTORE_RETRY_BACKOFF.toMillis());
            return true;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            logger.warn("DOWNLOAD", "Interrupted while retrying Raven task restore.", interrupted.getMessage());
            return false;
        }
    }

    /**
     * Search the upstream source for titles Raven can queue.
     *
     * @param query user-supplied search text
     * @return normalized search results
     */
    public List<Map<String, String>> searchTitles(String query) {
        return downloadProviderRegistry.enabledProviders().stream()
            .findFirst()
            .map((provider) -> provider.searchTitles(query).stream()
                .map((entry) -> {
                    Map<String, String> next = new LinkedHashMap<>(entry);
                    next.put("providerId", provider.id());
                    next.put("provider", provider.name());
                    next.putIfAbsent("titleName", entry.getOrDefault("title", ""));
                    next.putIfAbsent("titleUrl", entry.getOrDefault("href", ""));
                    next.putIfAbsent("requestType", LibraryNaming.normalizeTypeLabel(entry.getOrDefault("type", "manga")));
                    next.putIfAbsent("status", "available");
                    return next;
                })
                .toList())
            .orElse(List.of());
    }

    /**
     * Queue every provider title matching the supplied browse filters.
     *
     * @param providerId explicit provider id for the bulk browse path
     * @param type requested display type label
     * @param nsfw whether adult-only titles should be included
     * @param titlePrefix visible title prefix filter
     * @param requestedBy user or system actor requesting the bulk queue
     * @return bulk queue summary
     */
    public BulkQueueDownloadResult bulkQueueDownload(String providerId, String type, Boolean nsfw, String titlePrefix, String requestedBy) {
        String normalizedProviderId = normalizeString(providerId).toLowerCase(Locale.ROOT);
        String normalizedType = normalizeBulkQueueType(type);
        String normalizedPrefix = normalizeBulkTitlePrefix(titlePrefix);
        BulkQueueDownloadResult.Filters filters = new BulkQueueDownloadResult.Filters(
            normalizedType == null ? normalizeQueueType(type) : normalizedType,
            Boolean.TRUE.equals(nsfw),
            normalizedPrefix == null ? "" : normalizedPrefix
        );

        if (normalizedProviderId.isBlank() || normalizedType == null || nsfw == null || normalizedPrefix == null) {
            return new BulkQueueDownloadResult(
                BulkQueueDownloadResult.STATUS_INVALID_REQUEST,
                "providerId, type, nsfw, and titlePrefix are required.",
                filters,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of()
            );
        }

        if (!WEBCENTRAL_PROVIDER_ID.equals(normalizedProviderId)) {
            return new BulkQueueDownloadResult(
                BulkQueueDownloadResult.STATUS_INVALID_REQUEST,
                "The Scriptarr bulk queue command is locked to the WeebCentral provider.",
                filters,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of()
            );
        }

        Optional<DownloadProvider> selectedProvider = downloadProviderRegistry.getById(normalizedProviderId)
            .filter((provider) -> settingsService.isDownloadProviderEnabled(provider.id()));
        if (selectedProvider.isEmpty()) {
            return new BulkQueueDownloadResult(
                BulkQueueDownloadResult.STATUS_INVALID_REQUEST,
                "WeebCentral bulk queue is unavailable because the provider is disabled in Raven settings.",
                filters,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of()
            );
        }

        BulkBrowseResult browseResult = selectedProvider.get().browseTitlesAlphabetically(normalizedType, Boolean.TRUE.equals(nsfw), normalizedPrefix);

        List<Map<String, String>> matchedTitles = filterTitlesByPrefix(browseResult.titles(), normalizedPrefix);
        if (matchedTitles.isEmpty()) {
            return new BulkQueueDownloadResult(
                BulkQueueDownloadResult.STATUS_EMPTY_RESULTS,
                "No titles matched the supplied filters.",
                filters,
                browseResult.pagesScanned(),
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of()
            );
        }

        List<String> queuedTitles = new ArrayList<>();
        List<String> skippedActiveTitles = new ArrayList<>();
        List<String> skippedAdultContentTitles = new ArrayList<>();
        List<String> skippedNoMetadataTitles = new ArrayList<>();
        List<String> skippedAmbiguousMetadataTitles = new ArrayList<>();
        List<String> failedTitles = new ArrayList<>();
        String actor = normalizeString(requestedBy, "scriptarr-portal");
        List<LibraryTitle> existingLibraryTitles = libraryService == null ? List.of() : libraryService.listTitles();

        for (Map<String, String> selectedTitle : matchedTitles) {
            String titleName = normalizeString(selectedTitle.get("title"), "Unknown title");
            String titleUrl = normalizeString(selectedTitle.get("href"));
            String requestType = LibraryNaming.normalizeTypeLabel(selectedTitle.getOrDefault("type", normalizedType));
            String activeKey = activeBulkTaskKey(Map.of(
                "providerId", selectedProvider.get().id(),
                "titleUrl", titleUrl
            ));
            if (titleUrl.isBlank()) {
                failedTitles.add(titleName);
                continue;
            }
            if (isTaskAlreadyActive(activeKey, titleName) || isTitleAlreadyInLibrary(existingLibraryTitles, titleUrl, titleName, requestType)) {
                skippedActiveTitles.add(titleName);
                continue;
            }

            try {
                TitleDetails providerDetails = selectedProvider.get().getTitleDetails(titleUrl);
                if (!Boolean.TRUE.equals(nsfw) && (providerDetails == null || !Boolean.FALSE.equals(providerDetails.adultContent()))) {
                    skippedAdultContentTitles.add(titleName);
                    continue;
                }

                DownloadIntakeService.BulkMetadataResolution metadataResolution = downloadIntakeService.resolveBulkMetadata(
                    selectedProvider.get().id(),
                    titleUrl,
                    titleName,
                    requestType
                );
                if (metadataResolution.unmatched()) {
                    skippedNoMetadataTitles.add(titleName);
                    continue;
                }
                if (metadataResolution.ambiguous()) {
                    skippedAmbiguousMetadataTitles.add(titleName);
                    continue;
                }

                Map<String, Object> selectedMetadata = new LinkedHashMap<>(metadataResolution.metadataSnapshot());
                Map<String, Object> selectedDownload = new LinkedHashMap<>(metadataResolution.downloadSnapshot());
                selectedDownload.putIfAbsent("providerId", selectedProvider.get().id());
                selectedDownload.putIfAbsent("providerName", selectedProvider.get().name());
                selectedDownload.putIfAbsent("titleName", titleName);
                selectedDownload.putIfAbsent("titleUrl", titleUrl);
                selectedDownload.putIfAbsent("requestType", requestType);
                selectedDownload.putIfAbsent("libraryTypeLabel", requestType);
                selectedDownload.putIfAbsent("libraryTypeSlug", LibraryNaming.normalizeTypeSlug(requestType));
                if (providerDetails != null && providerDetails.adultContent() != null) {
                    selectedDownload.put("adultContent", providerDetails.adultContent());
                    selectedDownload.put("nsfw", providerDetails.adultContent());
                }

                queueDownload(new DownloadRequest(
                    titleName,
                    titleUrl,
                    requestType,
                    actor,
                    selectedProvider.get().id(),
                    "",
                    selectedMetadata,
                    selectedDownload,
                    "",
                    "normal"
                ));
                queuedTitles.add(titleName);
            } catch (Exception error) {
                failedTitles.add(titleName);
                logger.warn("DOWNLOAD", "Bulk queue failed for title.", error.getMessage());
            }
        }

        return new BulkQueueDownloadResult(
            resolveBulkQueueStatus(
                queuedTitles,
                skippedActiveTitles,
                skippedAdultContentTitles,
                skippedNoMetadataTitles,
                skippedAmbiguousMetadataTitles,
                failedTitles
            ),
            buildBulkQueueMessage(
                queuedTitles,
                skippedActiveTitles,
                skippedAdultContentTitles,
                skippedNoMetadataTitles,
                skippedAmbiguousMetadataTitles,
                failedTitles,
                matchedTitles.size()
            ),
            filters,
            browseResult.pagesScanned(),
            matchedTitles.size(),
            queuedTitles.size(),
            skippedActiveTitles.size(),
            skippedAdultContentTitles.size(),
            skippedNoMetadataTitles.size(),
            skippedAmbiguousMetadataTitles.size(),
            failedTitles.size(),
            queuedTitles,
            skippedActiveTitles,
            skippedAdultContentTitles,
            skippedNoMetadataTitles,
            skippedAmbiguousMetadataTitles,
            failedTitles
        );
    }

    /**
     * Queue a new download job and return the initial task snapshot.
     *
     * @param request normalized download request payload
     * @return queued task snapshot
     */
    public Map<String, Object> queueDownload(DownloadRequest request) {
        String activeKey = activeBulkTaskKey(Map.of(
            "providerId", request.providerId() == null ? "" : request.providerId(),
            "titleUrl", request.titleUrl()
        ));
        if (isTaskAlreadyActive(activeKey, request.titleName()) || isRequestAlreadyActive(request.requestId())) {
            throw new IllegalStateException("A Raven download for this title is already queued or running.");
        }

        String taskId = "task_" + UUID.randomUUID().toString().replace("-", "");
        Map<String, Object> task = new LinkedHashMap<>();
        task.put("taskId", taskId);
        task.put("jobId", taskId);
        task.put("titleId", "");
        task.put("titleName", request.titleName());
        task.put("titleUrl", request.titleUrl());
        task.put("requestType", request.requestType());
        task.put("requestedBy", request.requestedBy());
        task.put("providerId", request.providerId() == null ? "" : request.providerId());
        task.put("requestId", request.requestId() == null ? "" : request.requestId());
        task.put("replacementTitleId", request.replacementTitleId() == null ? "" : request.replacementTitleId());
        task.put("status", "queued");
        task.put("message", "Queued for Raven download.");
        task.put("percent", 0);
        task.put("queuedAt", Instant.now().toString());
        task.put("updatedAt", Instant.now().toString());
        task.put("libraryTypeLabel", LibraryNaming.normalizeTypeLabel(request.requestType()));
        task.put("libraryTypeSlug", LibraryNaming.normalizeTypeSlug(request.requestType()));
        task.put("selectedMetadata", request.selectedMetadata() == null ? Map.of() : request.selectedMetadata());
        task.put("selectedDownload", request.selectedDownload() == null ? Map.of() : request.selectedDownload());
        task.put("coverUrl", resolveCoverUrl(request));
        task.put("priority", normalizePriorityLabel(request.priority()));
        task.put("details", buildTaskDetails(task));
        tasks.put(taskId, task);
        persistTask(taskId);
        syncLinkedRequest(task, "", "queued", "Queued for Raven download.");

        submitQueuedTask(taskId, request);
        return Map.copyOf(task);
    }

    /**
     * Snapshot the current task history sorted by newest queue time first.
     *
     * @return task snapshots
     */
    public List<Map<String, Object>> snapshot() {
        return tasks.values().stream()
            .sorted(Comparator.comparing(entry -> String.valueOf(entry.get("queuedAt")), Comparator.reverseOrder()))
            .map(Map::copyOf)
            .toList();
    }

    /**
     * Summarize current queue counters for the health endpoint.
     *
     * @return aggregate queue counts
     */
    public Map<String, Object> stats() {
        long running = tasks.values().stream().filter(entry -> "running".equals(entry.get("status"))).count();
        long failed = tasks.values().stream().filter(entry -> "failed".equals(entry.get("status"))).count();
        long complete = tasks.values().stream().filter(entry -> "completed".equals(entry.get("status"))).count();
        return Map.of(
            "queued", tasks.size(),
            "running", running,
            "failed", failed,
            "completed", complete
        );
    }

    /**
     * Preview the managed Raven content reset scope.
     *
     * @return preview payload for managed tasks and folders
     */
    public synchronized Map<String, Object> previewManagedContentReset() {
        Path downloadsRoot = logger.getDownloadsRoot();
        return Map.of(
            "downloadsRoot", downloadsRoot == null ? "" : downloadsRoot.toString(),
            "counts", Map.of(
                "activeTasks", tasks.size(),
                "downloadingTitleFolders", countManagedTitleFolders(DOWNLOADING_FOLDER_NAME),
                "downloadedTitleFolders", countManagedTitleFolders(DOWNLOADED_FOLDER_NAME)
            )
        );
    }

    /**
     * Clear managed Raven workers, in-memory tasks, and managed title folders.
     *
     * @return reset result payload
     */
    public synchronized Map<String, Object> executeManagedContentReset() {
        Map<String, Object> preview = previewManagedContentReset();
        ThreadPoolExecutor previousQueueWorker = queueWorker;
        java.util.concurrent.ExecutorService previousPageWorker = pageDownloadWorker;
        queueWorker = createQueueWorker();
        pageDownloadWorker = createPageDownloadWorker();
        previousQueueWorker.shutdownNow();
        previousPageWorker.shutdownNow();
        tasks.clear();
        deleteDirectoryQuietly(logger.getDownloadsRoot().resolve(DOWNLOADING_FOLDER_NAME));
        deleteDirectoryQuietly(logger.getDownloadsRoot().resolve(DOWNLOADED_FOLDER_NAME));
        return preview;
    }

    /**
     * Stop the queue worker when the Spring context shuts down.
     */
    @PreDestroy
    public void shutdown() {
        queueWorker.shutdownNow();
        pageDownloadWorker.shutdownNow();
    }

    private void process(String taskId, DownloadRequest request) {
        try {
            update(taskId, "running", "Preparing Raven download.", 5);
            if (vpnService != null) {
                vpnService.ensureConnectedIfEnabled();
            }

            DownloadProvider provider = resolveProvider(request);
            List<Map<String, String>> chapters = provider.getChapters(request.titleUrl());
            if (chapters.isEmpty()) {
                throw new IllegalStateException("No chapters were found for the requested title URL.");
            }
            TitleDetails details = provider.getTitleDetails(request.titleUrl());
            details = mergeRequestTagsIntoDetails(details, request);
            String typeLabel = resolveLibraryTypeLabel(request, details);
            String typeSlug = LibraryNaming.normalizeTypeSlug(typeLabel);
            RavenNamingSettings namingSettings = settingsService.getNamingSettings();
            Path canonicalFinalRoot = resolveReplacementTargetRoot(request, typeSlug);
            boolean replacementDownload = isReplacementDownload(request);
            Path workingRoot = replacementDownload
                ? resolveStagedTitleRoot(DOWNLOADING_FOLDER_NAME, request.titleName(), typeSlug, taskId)
                : resolveTitleRoot(DOWNLOADING_FOLDER_NAME, request.titleName(), typeSlug);
            Path finalRoot = replacementDownload
                ? resolveStagedTitleRoot(DOWNLOADED_FOLDER_NAME, request.titleName(), typeSlug, taskId)
                : canonicalFinalRoot;

            rememberRoots(taskId, typeLabel, typeSlug, workingRoot, canonicalFinalRoot);
            Files.createDirectories(workingRoot);

            int total = chapters.size();
            Map<String, Map<String, String>> chapterDetailsByNumber = new LinkedHashMap<>();
            for (int index = 0; index < chapters.size(); index++) {
                Map<String, String> chapter = chapters.get(index);
                Path archivePath = downloadChapterWithRetries(provider, workingRoot, request, typeLabel, chapter, namingSettings);
                String chapterNumber = normalizeStoredChapterNumber(chapter.getOrDefault("chapter_number", String.valueOf(index + 1)));
                Map<String, String> storedChapter = new LinkedHashMap<>(chapter);
                storedChapter.put("archive_path", archivePath.toString());
                chapterDetailsByNumber.put(chapterNumber, storedChapter);
                int percent = Math.max(10, (int) (((index + 1) / (double) total) * CHAPTER_DOWNLOAD_PROGRESS_CAP));
                update(taskId, "running", "Downloaded chapter " + chapterNumber + ".", percent);
            }

            update(taskId, "running", "Promoting completed files into the Raven library.", 95);
            promoteTitleFolder(workingRoot, finalRoot);
            if (replacementDownload) {
                update(taskId, "running", "Swapping the staged replacement into the live Raven library.", 97);
                swapReplacementFolder(finalRoot, canonicalFinalRoot);
                finalRoot = canonicalFinalRoot;
            }
            LibraryTitle title = libraryService.recordDownloadedTitle(
                request.titleName(),
                typeLabel,
                request.titleUrl(),
                resolveCoverUrl(request),
                details,
                buildLibraryChapters(finalRoot, chapterDetailsByNumber, typeLabel, namingSettings),
                workingRoot,
                finalRoot
            );
            if (title == null || title.id() == null || title.id().isBlank()) {
                throw new IllegalStateException("Raven could not persist the downloaded title into the library catalog.");
            }
            title = persistSelectedMetadata(title, request);
            if (title != null) {
                Map<String, Object> task = tasks.get(taskId);
                if (task != null) {
                    task.put("titleId", title.id());
                    task.put("libraryTypeLabel", title.libraryTypeLabel());
                    task.put("libraryTypeSlug", title.libraryTypeSlug());
                    task.put("workingRoot", title.workingRoot());
                    task.put("downloadRoot", title.downloadRoot());
                    task.put("coverUrl", title.coverUrl());
                }
            }

            update(taskId, "completed", "Raven download completed.", 100);
        } catch (Exception error) {
            update(taskId, "failed", normalizeString(error.getMessage(), "Raven download failed."), 90);
            logger.error("DOWNLOAD", "Raven download failed.", error);
        }
    }

    private LibraryTitle persistSelectedMetadata(LibraryTitle title, DownloadRequest request) {
        Map<String, Object> selectedMetadata = normalizeMap(request.selectedMetadata());
        String provider = stringValue(selectedMetadata.get("provider"));
        String providerSeriesId = stringValue(selectedMetadata.get("providerSeriesId"));
        if (title == null || title.id() == null || title.id().isBlank() || provider.isBlank() || providerSeriesId.isBlank()) {
            return title;
        }

        Map<String, Object> result = metadataService.persistResolvedMatch(title.id(), selectedMetadata);
        if (!Boolean.TRUE.equals(result.get("ok"))) {
            throw new IllegalStateException(normalizeString(result.get("error"), "Raven could not persist metadata for the downloaded title."));
        }
        LibraryTitle refreshed = libraryService.findTitle(title.id());
        return refreshed == null ? title : refreshed;
    }

    private Path downloadChapterWithRetries(
        DownloadProvider provider,
        Path titleRoot,
        DownloadRequest request,
        String typeLabel,
        Map<String, String> chapter,
        RavenNamingSettings namingSettings
    ) throws IOException, InterruptedException {
        String chapterNumber = normalizeStoredChapterNumber(chapter.getOrDefault("chapter_number", "0"));
        String lastFailureMessage = "No chapter pages were found for " + chapter.get("href");
        IOException lastIoFailure = null;

        for (int attempt = 1; attempt <= CHAPTER_DOWNLOAD_RETRY_ATTEMPTS; attempt++) {
            List<String> images = findChapterPagesWithRetries(
                provider,
                request.titleName(),
                chapterNumber,
                chapter.get("chapter_title"),
                chapter.get("href")
            );
            if (images.isEmpty()) {
                lastFailureMessage = "No chapter pages were found for " + chapter.get("href");
                if (attempt < CHAPTER_DOWNLOAD_RETRY_ATTEMPTS && !sleepBeforeRetry("chapter page resolution", request.titleName(), chapterNumber, attempt, null)) {
                    break;
                }
                continue;
            }

            try {
                return writeChapterArchive(titleRoot, request, typeLabel, chapter, namingSettings, chapterNumber, images);
            } catch (IOException error) {
                lastIoFailure = error;
                lastFailureMessage = normalizeString(error.getMessage(), "Raven could not save chapter " + chapterNumber + ".");
                logger.warn(
                    "DOWNLOAD",
                    "Chapter archive attempt failed.",
                    "title=" + request.titleName() + " chapter=" + chapterNumber + " attempt="
                        + attempt + "/" + CHAPTER_DOWNLOAD_RETRY_ATTEMPTS + " reason=" + lastFailureMessage
                );
                if (attempt < CHAPTER_DOWNLOAD_RETRY_ATTEMPTS && !sleepBeforeRetry("chapter archive", request.titleName(), chapterNumber, attempt, error)) {
                    break;
                }
            }
        }

        if (lastIoFailure != null) {
            throw new IOException(lastFailureMessage, lastIoFailure);
        }
        throw new IllegalStateException(lastFailureMessage);
    }

    private List<LibraryChapter> buildLibraryChapters(
        Path finalRoot,
        Map<String, Map<String, String>> chapterDetailsByNumber,
        String typeLabel,
        RavenNamingSettings namingSettings
    ) throws IOException {
        try (var archives = Files.list(finalRoot)) {
            return archives
                .filter(Files::isRegularFile)
                .filter((path) -> path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".cbz"))
                .sorted()
                .map((path) -> {
                    String chapterNumber = LibraryNaming.extractChapterNumber(path.getFileName().toString(), namingSettings, typeLabel);
                    Map<String, String> chapterDetails = chapterDetailsByNumber.getOrDefault(chapterNumber, Map.of());
                    String releaseDate = firstNonBlank(
                        normalizeString(chapterDetails.get("release_date")),
                        resolveArchiveTimestamp(path)
                    );
                    return new LibraryChapter(
                        "",
                        normalizeString(chapterDetails.get("chapter_title"), "Chapter " + chapterNumber),
                        chapterNumber,
                        countArchiveEntries(path),
                        releaseDate,
                        true,
                        path.toString(),
                        normalizeString(chapterDetails.get("href"), null)
                    );
                })
                .toList();
        }
    }

    private String resolveArchiveTimestamp(Path archivePath) {
        if (archivePath == null) {
            return null;
        }

        try {
            return Files.getLastModifiedTime(archivePath).toInstant().toString();
        } catch (IOException ignored) {
            return null;
        }
    }

    private Path writeChapterArchive(
        Path titleRoot,
        DownloadRequest request,
        String typeLabel,
        Map<String, String> chapter,
        RavenNamingSettings namingSettings,
        String chapterNumber,
        List<String> images
    ) throws IOException, InterruptedException {
        String volumeNumber = normalizeStoredVolumeNumber(chapter.get("volume_number"));
        String archiveName = LibraryNaming.buildChapterArchiveName(
            namingSettings,
            request.titleName(),
            typeLabel,
            chapterNumber,
            volumeNumber,
            images.size(),
            resolveDomain(chapter.get("href"))
        );
        Path archivePath = titleRoot.resolve(archiveName);
        if (Files.exists(archivePath) && Files.size(archivePath) > 0) {
            logger.info("DOWNLOAD", "Skipping chapter archive that already exists.", "file=" + archivePath.getFileName());
            return archivePath;
        }

        Path stagedPagesRoot = resolveChapterStageRoot(titleRoot, archiveName);
        Files.createDirectories(stagedPagesRoot);
        List<Future<Path>> pageDownloads = new ArrayList<>();
        for (int index = 0; index < images.size(); index++) {
            final int pageNumber = index + 1;
            final String imageUrl = images.get(index);
            final String extension = resolveExtension(imageUrl, ".jpg");
            final String pageFileName = LibraryNaming.buildPageFileName(
                namingSettings,
                request.titleName(),
                typeLabel,
                chapterNumber,
                volumeNumber,
                pageNumber,
                extension
            );
            final Path stagedPage = stagedPagesRoot.resolve(pageFileName);
            if (Files.exists(stagedPage) && Files.size(stagedPage) > 0) {
                pageDownloads.add(CompletableFuture.completedFuture(stagedPage));
                continue;
            }

            pageDownloads.add(pageDownloadWorker.submit(() -> {
                Files.createDirectories(stagedPage.getParent());
                Files.write(stagedPage, downloadImageWithRetries(imageUrl, chapter.get("href"), request.titleName(), chapterNumber));
                return stagedPage;
            }));
        }

        boolean archiveCompleted = false;
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archivePath))) {
            for (Future<Path> pageDownload : pageDownloads) {
                Path stagedPage = awaitDownloadedPage(pageDownload);
                try (InputStream stream = Files.newInputStream(stagedPage)) {
                    ZipEntry entry = new ZipEntry(stagedPage.getFileName().toString());
                    zip.putNextEntry(entry);
                    stream.transferTo(zip);
                    zip.closeEntry();
                }
            }
            archiveCompleted = true;
        } catch (IOException | InterruptedException error) {
            Files.deleteIfExists(archivePath);
            throw error;
        } finally {
            if (archiveCompleted) {
                deleteDirectoryQuietly(stagedPagesRoot);
            }
        }

        logger.info("DOWNLOAD", "Saved chapter archive.", "file=" + archivePath.getFileName());
        return archivePath;
    }

    private List<String> findChapterPagesWithRetries(
        DownloadProvider provider,
        String titleName,
        String chapterNumber,
        String chapterTitle,
        String chapterUrl
    ) throws InterruptedException {
        if (chapterUrl == null || chapterUrl.isBlank()) {
            return List.of();
        }

        for (int attempt = 1; attempt <= CHAPTER_SOURCE_RETRY_ATTEMPTS; attempt++) {
            try {
                List<String> pageUrls = provider.resolvePages(chapterUrl);
                if (pageUrls != null && !pageUrls.isEmpty()) {
                    return pageUrls;
                }
                logger.warn(
                    "DOWNLOAD",
                    "Chapter page lookup returned no pages.",
                    "title=" + titleName + " chapter=" + chapterNumber + " label=" + normalizeString(chapterTitle)
                        + " attempt=" + attempt + "/" + CHAPTER_SOURCE_RETRY_ATTEMPTS
                );
            } catch (Exception error) {
                logger.warn(
                    "DOWNLOAD",
                    "Chapter page lookup failed.",
                    "title=" + titleName + " chapter=" + chapterNumber + " label=" + normalizeString(chapterTitle)
                        + " attempt=" + attempt + "/" + CHAPTER_SOURCE_RETRY_ATTEMPTS + " reason="
                        + normalizeString(error.getMessage(), "unknown")
                );
            }

            if (attempt < CHAPTER_SOURCE_RETRY_ATTEMPTS && !sleepBeforeRetry("chapter page lookup", titleName, chapterNumber, attempt, null)) {
                break;
            }
        }

        return List.of();
    }

    private byte[] downloadImageWithRetries(
        String imageUrl,
        String chapterUrl,
        String titleName,
        String chapterNumber
    ) throws IOException, InterruptedException {
        IOException lastFailure = null;
        for (int attempt = 1; attempt <= IMAGE_DOWNLOAD_RETRY_ATTEMPTS; attempt++) {
            try {
                return downloadImage(imageUrl, chapterUrl);
            } catch (IOException error) {
                lastFailure = error;
                logger.warn(
                    "DOWNLOAD",
                    "Image download attempt failed.",
                    "title=" + titleName + " chapter=" + chapterNumber + " attempt="
                        + attempt + "/" + IMAGE_DOWNLOAD_RETRY_ATTEMPTS + " reason="
                        + normalizeString(error.getMessage(), "unknown")
                );
                if (attempt < IMAGE_DOWNLOAD_RETRY_ATTEMPTS && !sleepBeforeRetry("image download", titleName, chapterNumber, attempt, error)) {
                    break;
                }
            }
        }

        throw lastFailure == null
            ? new IOException("Image download failed for " + imageUrl)
            : lastFailure;
    }

    private byte[] downloadImage(String imageUrl, String chapterUrl) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(imageUrl))
            .timeout(IMAGE_DOWNLOAD_TIMEOUT)
            .header("User-Agent", USER_AGENT)
            .header("Referer", normalizeString(chapterUrl, WEBCENTRAL_REFERER))
            .GET()
            .build();
        HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IOException("Image download failed with status " + response.statusCode() + " for " + imageUrl);
        }
        return response.body();
    }

    private boolean sleepBeforeRetry(String stage, String titleName, String chapterNumber, int attempt, Exception error) throws InterruptedException {
        logger.info(
            "DOWNLOAD",
            "Retrying " + stage + ".",
            "title=" + titleName + " chapter=" + chapterNumber + " nextAttempt=" + (attempt + 1)
                + " reason=" + normalizeString(error == null ? "" : error.getMessage(), "retrying")
        );
        long delay = RETRY_BACKOFF_MS;
        String reason = normalizeString(error == null ? "" : error.getMessage()).toLowerCase(Locale.ROOT);
        if (reason.contains("429") || reason.contains("too many requests") || reason.contains("timed out")) {
            delay = RETRY_BACKOFF_MS * (attempt + 1L);
        }
        Thread.sleep(delay);
        return true;
    }

    private void update(String taskId, String status, String message, int percent) {
        Map<String, Object> task = tasks.get(taskId);
        if (task == null) {
            return;
        }
        String previousStatus = String.valueOf(task.getOrDefault("status", ""));
        task.put("status", status);
        task.put("message", message);
        task.put("percent", percent);
        task.put("updatedAt", Instant.now().toString());
        task.put("details", buildTaskDetails(task));
        persistTask(taskId);
        syncLinkedRequest(task, previousStatus, status, message);
    }

    private void rememberRoots(String taskId, String typeLabel, String typeSlug, Path workingRoot, Path finalRoot) {
        Map<String, Object> task = tasks.get(taskId);
        if (task == null) {
            return;
        }
        task.put("libraryTypeLabel", typeLabel);
        task.put("libraryTypeSlug", typeSlug);
        task.put("workingRoot", workingRoot.toString());
        task.put("downloadRoot", finalRoot.toString());
        task.put("details", buildTaskDetails(task));
        persistTask(taskId);
    }

    private void persistTask(String taskId) {
        Map<String, Object> task = tasks.get(taskId);
        if (task == null) {
            return;
        }
        try {
            task.put("details", buildTaskDetails(task));
            brokerClient.putDownloadTask(taskId, task);
            String jobId = String.valueOf(task.getOrDefault("jobId", taskId));
            brokerClient.putJob(jobId, buildJobPayload(jobId, task));
            brokerClient.putJobTask(jobId, jobTaskId(jobId), buildJobTaskPayload(jobId, task));
        } catch (Exception error) {
            logger.warn("DOWNLOAD", "Failed to persist a Raven task snapshot.", error.getMessage());
        }
    }

    private DownloadProvider resolveProvider(DownloadRequest request) {
        return downloadProviderRegistry.resolve(request.providerId(), request.titleUrl())
            .orElseThrow(() -> new IllegalStateException("No enabled Raven download provider could handle the selected title URL."));
    }

    private Map<String, Object> buildTaskDetails(Map<String, Object> task) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("selectedMetadata", task.getOrDefault("selectedMetadata", Map.of()));
        details.put("selectedDownload", task.getOrDefault("selectedDownload", Map.of()));
        details.put("libraryTypeLabel", String.valueOf(task.getOrDefault("libraryTypeLabel", "")));
        details.put("libraryTypeSlug", String.valueOf(task.getOrDefault("libraryTypeSlug", "")));
        details.put("workingRoot", String.valueOf(task.getOrDefault("workingRoot", "")));
        details.put("downloadRoot", String.valueOf(task.getOrDefault("downloadRoot", "")));
        details.put("coverUrl", String.valueOf(task.getOrDefault("coverUrl", "")));
        details.put("replacementTitleId", String.valueOf(task.getOrDefault("replacementTitleId", "")));
        details.put("priority", String.valueOf(task.getOrDefault("priority", PRIORITY_NORMAL)));
        return details;
    }

    private void syncLinkedRequest(Map<String, Object> task, String previousTaskStatus, String nextTaskStatus, String message) {
        String requestId = String.valueOf(task.getOrDefault("requestId", ""));
        if (requestId.isBlank()) {
            return;
        }

        String nextRequestStatus = toRequestStatus(nextTaskStatus);
        String previousRequestStatus = toRequestStatus(previousTaskStatus);
        Map<String, Object> detailsPatch = new LinkedHashMap<>();
        detailsPatch.put("jobId", String.valueOf(task.getOrDefault("jobId", task.getOrDefault("taskId", ""))));
        detailsPatch.put("taskId", String.valueOf(task.getOrDefault("taskId", "")));
        detailsPatch.put("availability", "available");
        detailsPatch.put("selectedMetadata", task.get("selectedMetadata"));
        detailsPatch.put("selectedDownload", task.get("selectedDownload"));
        detailsPatch.put("coverUrl", String.valueOf(task.getOrDefault("coverUrl", "")));

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("status", nextRequestStatus);
        payload.put("actor", "scriptarr-raven");
        payload.put("detailsMerge", detailsPatch);
        if (!nextRequestStatus.equals(previousRequestStatus)) {
            payload.put("eventType", nextRequestStatus);
            payload.put("eventMessage", message);
        }

        try {
            brokerClient.patchRequest(requestId, payload);
        } catch (Exception error) {
            logger.warn("DOWNLOAD", "Failed to sync Raven task state back to the request record.", error.getMessage());
        }
    }

    private String toRequestStatus(String taskStatus) {
        return switch (String.valueOf(taskStatus).trim().toLowerCase(Locale.ROOT)) {
            case "running" -> "downloading";
            case "completed" -> "completed";
            case "failed" -> "failed";
            case "queued" -> "queued";
            default -> "queued";
        };
    }

    private Map<String, Object> buildJobPayload(String jobId, Map<String, Object> task) {
        String status = String.valueOf(task.getOrDefault("status", "queued"));
        String queuedAt = String.valueOf(task.getOrDefault("queuedAt", Instant.now().toString()));
        String updatedAt = String.valueOf(task.getOrDefault("updatedAt", queuedAt));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("jobId", jobId);
        payload.put("kind", DOWNLOAD_JOB_KIND);
        payload.put("ownerService", "scriptarr-raven");
        payload.put("status", status);
        payload.put("label", "Download " + task.getOrDefault("titleName", "Untitled"));
        payload.put("requestedBy", String.valueOf(task.getOrDefault("requestedBy", "scriptarr")));
        payload.put("payload", Map.of(
            "titleName", String.valueOf(task.getOrDefault("titleName", "")),
            "titleUrl", String.valueOf(task.getOrDefault("titleUrl", "")),
            "requestType", String.valueOf(task.getOrDefault("requestType", "manga")),
            "providerId", String.valueOf(task.getOrDefault("providerId", "")),
            "requestId", String.valueOf(task.getOrDefault("requestId", "")),
            "priority", String.valueOf(task.getOrDefault("priority", PRIORITY_NORMAL)),
            "libraryTypeLabel", String.valueOf(task.getOrDefault("libraryTypeLabel", "")),
            "libraryTypeSlug", String.valueOf(task.getOrDefault("libraryTypeSlug", ""))
        ));
        payload.put("result", Map.of(
            "titleId", String.valueOf(task.getOrDefault("titleId", "")),
            "workingRoot", String.valueOf(task.getOrDefault("workingRoot", "")),
            "downloadRoot", String.valueOf(task.getOrDefault("downloadRoot", "")),
            "coverUrl", String.valueOf(task.getOrDefault("coverUrl", "")),
            "message", String.valueOf(task.getOrDefault("message", ""))
        ));
        payload.put("createdAt", queuedAt);
        payload.put("startedAt", "queued".equals(status) ? null : queuedAt);
        payload.put("finishedAt", isTerminalStatus(status) ? updatedAt : null);
        payload.put("updatedAt", updatedAt);
        return payload;
    }

    private Map<String, Object> buildJobTaskPayload(String jobId, Map<String, Object> task) {
        String status = String.valueOf(task.getOrDefault("status", "queued"));
        String queuedAt = String.valueOf(task.getOrDefault("queuedAt", Instant.now().toString()));
        String updatedAt = String.valueOf(task.getOrDefault("updatedAt", queuedAt));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("taskId", jobTaskId(jobId));
        payload.put("jobId", jobId);
        payload.put("taskKey", "download");
        payload.put("label", "Download " + task.getOrDefault("titleName", "Untitled"));
        payload.put("status", status);
        payload.put("message", String.valueOf(task.getOrDefault("message", "")));
        payload.put("percent", task.getOrDefault("percent", 0));
        payload.put("sortOrder", 0);
        payload.put("payload", Map.of(
            "titleName", String.valueOf(task.getOrDefault("titleName", "")),
            "titleUrl", String.valueOf(task.getOrDefault("titleUrl", "")),
            "requestType", String.valueOf(task.getOrDefault("requestType", "manga")),
            "providerId", String.valueOf(task.getOrDefault("providerId", "")),
            "requestId", String.valueOf(task.getOrDefault("requestId", "")),
            "priority", String.valueOf(task.getOrDefault("priority", PRIORITY_NORMAL))
        ));
        payload.put("result", Map.of(
            "titleId", String.valueOf(task.getOrDefault("titleId", "")),
            "workingRoot", String.valueOf(task.getOrDefault("workingRoot", "")),
            "downloadRoot", String.valueOf(task.getOrDefault("downloadRoot", "")),
            "coverUrl", String.valueOf(task.getOrDefault("coverUrl", ""))
        ));
        payload.put("createdAt", queuedAt);
        payload.put("startedAt", "queued".equals(status) ? null : queuedAt);
        payload.put("finishedAt", isTerminalStatus(status) ? updatedAt : null);
        payload.put("updatedAt", updatedAt);
        return payload;
    }

    private String jobTaskId(String jobId) {
        return jobId + "_download";
    }

    private boolean isTerminalStatus(String status) {
        return "completed".equals(status) || "failed".equals(status) || SUPERSEDED_STATUS.equals(status);
    }

    private Path resolveTitleRoot(String stateFolder, String titleName, String typeSlug) {
        return logger.getDownloadsRoot()
            .resolve(stateFolder)
            .resolve(typeSlug)
            .resolve(LibraryNaming.sanitizeTitleFolder(titleName));
    }

    private Path resolveStagedTitleRoot(String stateFolder, String titleName, String typeSlug, String taskId) {
        return logger.getDownloadsRoot()
            .resolve(stateFolder)
            .resolve(typeSlug)
            .resolve(LibraryNaming.sanitizeTitleFolder(titleName) + "__repair_" + LibraryNaming.slugifySegment(taskId));
    }

    private boolean isReplacementDownload(DownloadRequest request) {
        return request != null && request.replacementTitleId() != null && !request.replacementTitleId().isBlank();
    }

    private Path resolveReplacementTargetRoot(DownloadRequest request, String typeSlug) {
        if (!isReplacementDownload(request)) {
            return resolveTitleRoot(DOWNLOADED_FOLDER_NAME, request.titleName(), typeSlug);
        }

        LibraryTitle existing = libraryService.findTitle(request.replacementTitleId());
        if (existing != null && existing.downloadRoot() != null && !existing.downloadRoot().isBlank()) {
            return Path.of(existing.downloadRoot());
        }
        return resolveTitleRoot(DOWNLOADED_FOLDER_NAME, request.titleName(), typeSlug);
    }

    private void promoteTitleFolder(Path sourceFolder, Path targetFolder) throws IOException {
        if (sourceFolder == null || targetFolder == null) {
            return;
        }

        Path normalizedSource = sourceFolder.normalize();
        Path normalizedTarget = targetFolder.normalize();
        if (normalizedSource.equals(normalizedTarget) || !Files.exists(normalizedSource) || !Files.isDirectory(normalizedSource)) {
            return;
        }

        Path targetParent = normalizedTarget.getParent();
        if (targetParent != null) {
            Files.createDirectories(targetParent);
        }

        if (!Files.exists(normalizedTarget)) {
            Files.move(normalizedSource, normalizedTarget, StandardCopyOption.REPLACE_EXISTING);
        } else {
            moveDirectoryContents(normalizedSource, normalizedTarget);
            Files.deleteIfExists(normalizedSource);
        }

        pruneEmptyManagedParents(normalizedSource.getParent(), logger.getDownloadsRoot().resolve(DOWNLOADING_FOLDER_NAME).normalize());
    }

    private void swapReplacementFolder(Path stagedFolder, Path targetFolder) throws IOException {
        if (stagedFolder == null || targetFolder == null) {
            return;
        }

        Path normalizedStaged = stagedFolder.normalize();
        Path normalizedTarget = targetFolder.normalize();
        if (!Files.exists(normalizedStaged) || !Files.isDirectory(normalizedStaged) || normalizedStaged.equals(normalizedTarget)) {
            return;
        }

        Path targetParent = normalizedTarget.getParent();
        if (targetParent != null) {
            Files.createDirectories(targetParent);
        }

        Path backupFolder = normalizedTarget.resolveSibling(
            normalizedTarget.getFileName().toString() + "__backup_" + Instant.now().toEpochMilli()
        );
        boolean backedUp = false;
        try {
            if (Files.exists(normalizedTarget)) {
                Files.move(normalizedTarget, backupFolder, StandardCopyOption.REPLACE_EXISTING);
                backedUp = true;
            }

            Files.move(normalizedStaged, normalizedTarget, StandardCopyOption.REPLACE_EXISTING);
            if (backedUp) {
                deleteDirectoryQuietly(backupFolder);
            }
        } catch (IOException error) {
            if (!Files.exists(normalizedTarget) && backedUp && Files.exists(backupFolder)) {
                Files.move(backupFolder, normalizedTarget, StandardCopyOption.REPLACE_EXISTING);
            }
            throw error;
        } finally {
            pruneEmptyManagedParents(normalizedStaged.getParent(), logger.getDownloadsRoot().resolve(DOWNLOADED_FOLDER_NAME).normalize());
        }
    }

    private void moveDirectoryContents(Path sourceFolder, Path targetFolder) throws IOException {
        Files.createDirectories(targetFolder);

        List<Path> children;
        try (var stream = Files.list(sourceFolder)) {
            children = stream.toList();
        }

        for (Path child : children) {
            Path targetChild = targetFolder.resolve(child.getFileName().toString());
            if (Files.isDirectory(child)) {
                moveDirectoryContents(child, targetChild);
                Files.deleteIfExists(child);
                continue;
            }

            Files.move(child, targetChild, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private void pruneEmptyManagedParents(Path folder, Path stopRoot) {
        Path current = folder;
        while (current != null && current.startsWith(stopRoot) && !current.equals(stopRoot)) {
            try (var stream = Files.list(current)) {
                if (stream.findAny().isPresent()) {
                    break;
                }
            } catch (Exception ignored) {
                break;
            }

            try {
                Files.deleteIfExists(current);
            } catch (IOException ignored) {
                break;
            }
            current = current.getParent();
        }
    }

    private String resolveLibraryTypeLabel(DownloadRequest request, TitleDetails details) {
        if (details != null && details.type() != null && !details.type().isBlank()) {
            return LibraryNaming.normalizeTypeLabel(details.type());
        }
        return LibraryNaming.normalizeTypeLabel(request.requestType());
    }

    private String resolveCoverUrl(DownloadRequest request) {
        Map<String, Object> selectedDownload = normalizeMap(request.selectedDownload());
        Map<String, Object> selectedMetadata = normalizeMap(request.selectedMetadata());
        Map<String, Object> metadataDetails = normalizeMap(selectedMetadata.get("details"));
        return firstNonBlank(
            stringValue(selectedDownload.get("coverUrl")),
            stringValue(selectedMetadata.get("coverUrl")),
            stringValue(metadataDetails.get("coverUrl")),
            stringValue(metadataDetails.get("coverImageUrl"))
        );
    }

    private TitleDetails mergeRequestTagsIntoDetails(TitleDetails details, DownloadRequest request) {
        Map<String, Object> selectedDownload = normalizeMap(request.selectedDownload());
        Map<String, Object> selectedMetadata = normalizeMap(request.selectedMetadata());
        Map<String, Object> metadataDetails = normalizeMap(selectedMetadata.get("details"));
        List<String> mergedTags = mergeDisplayStrings(
            details == null ? List.of() : details.tags(),
            objectToStringList(selectedDownload.get("tags")),
            objectToStringList(selectedMetadata.get("tags")),
            objectToStringList(metadataDetails.get("tags"))
        );
        if (details == null) {
            return new TitleDetails(
                "",
                "",
                List.of(),
                "",
                "",
                null,
                null,
                null,
                mergedTags,
                List.of()
            );
        }
        return new TitleDetails(
            details.summary(),
            details.type(),
            details.associatedNames(),
            details.status(),
            details.released(),
            details.adultContent(),
            details.officialTranslation(),
            details.animeAdaptation(),
            mergedTags,
            details.relatedSeries()
        );
    }

    private int countArchiveEntries(Path archivePath) {
        try (java.util.zip.ZipFile zipFile = new java.util.zip.ZipFile(archivePath.toFile())) {
            return (int) zipFile.stream().filter((entry) -> !entry.isDirectory()).count();
        } catch (Exception ignored) {
            return 1;
        }
    }

    private String normalizeStoredChapterNumber(String value) {
        if (value == null || value.isBlank()) {
            return "0";
        }
        try {
            return new java.math.BigDecimal(value.trim()).stripTrailingZeros().toPlainString();
        } catch (NumberFormatException ignored) {
            return value.trim();
        }
    }

    private String normalizeStoredVolumeNumber(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        try {
            String normalized = new java.math.BigDecimal(value.trim()).stripTrailingZeros().toPlainString();
            return "0".equals(normalized) ? "" : normalized;
        } catch (NumberFormatException ignored) {
            return value.trim();
        }
    }

    private String resolveExtension(String url, String fallback) {
        int dotIndex = url.lastIndexOf('.');
        if (dotIndex < 0 || dotIndex >= url.length() - 1) {
            return fallback;
        }
        String extension = url.substring(dotIndex).toLowerCase(Locale.ROOT);
        if (extension.contains("?")) {
            extension = extension.substring(0, extension.indexOf('?'));
        }
        return extension.isBlank() ? fallback : extension;
    }

    private String resolveDomain(String href) {
        try {
            URI uri = URI.create(Optional.ofNullable(href).orElse(""));
            return uri.getHost() == null ? "" : uri.getHost();
        } catch (Exception ignored) {
            return "";
        }
    }

    private void copyIfPresent(com.fasterxml.jackson.databind.JsonNode node, Map<String, Object> target, String field) {
        if (node.hasNonNull(field) && !node.path(field).asText("").isBlank()) {
            target.put(field, node.path(field).asText(""));
        }
    }

    private boolean recoverCompletedTask(String taskId) {
        Map<String, Object> task = tasks.get(taskId);
        if (task == null) {
            return false;
        }
        Optional<LibraryTitle> recovered = findRecoveredTitle(task);
        if (recovered.isEmpty()) {
            return false;
        }

        LibraryTitle title = recovered.get();
        task.put("titleId", title.id());
        task.put("libraryTypeLabel", title.libraryTypeLabel());
        task.put("libraryTypeSlug", title.libraryTypeSlug());
        task.put("workingRoot", title.workingRoot());
        task.put("downloadRoot", title.downloadRoot());
        task.put("coverUrl", title.coverUrl());
        update(taskId, "completed", "Recovered completed Raven download from existing files.", 100);
        return true;
    }

    private Optional<LibraryTitle> findRecoveredTitle(Map<String, Object> task) {
        String titleId = normalizeString(task.get("titleId"));
        if (!titleId.isBlank()) {
            LibraryTitle existing = libraryService.findTitle(titleId);
            if (existing != null) {
                return Optional.of(existing);
            }
        }

        String requestedDownloadRoot = normalizeString(task.get("downloadRoot"));
        String titleName = normalizeString(task.get("titleName"));
        String typeSlug = LibraryNaming.normalizeTypeSlug(normalizeString(task.get("libraryTypeSlug"), normalizeString(task.get("requestType"), "manga")));

        Set<Path> candidateDownloadRoots = new LinkedHashSet<>();
        if (!requestedDownloadRoot.isBlank()) {
            candidateDownloadRoots.add(Path.of(requestedDownloadRoot));
        }
        if (!titleName.isBlank()) {
            candidateDownloadRoots.add(resolveTitleRoot(DOWNLOADED_FOLDER_NAME, titleName, typeSlug));
        }

        for (Path downloadRoot : candidateDownloadRoots) {
            if (Files.exists(downloadRoot) && hasArchiveFiles(downloadRoot)) {
                libraryService.rescanDownloadedFiles();
                String normalizedCandidateRoot = downloadRoot.toString();
                for (LibraryTitle title : libraryService.listTitles()) {
                    if (normalizedCandidateRoot.equals(normalizeString(title.downloadRoot()))) {
                        return Optional.of(title);
                    }
                }
            }
        }

        if (titleName.isBlank()) {
            return Optional.empty();
        }

        for (LibraryTitle title : libraryService.listTitles()) {
            if (title == null) {
                continue;
            }
            if (titleName.equalsIgnoreCase(normalizeString(title.title()))
                && typeSlug.equals(LibraryNaming.normalizeTypeSlug(title.libraryTypeSlug()))) {
                return Optional.of(title);
            }
        }
        return Optional.empty();
    }

    private int compareTaskFreshness(Map<String, Object> left, Map<String, Object> right) {
        return taskTimestamp(left).compareTo(taskTimestamp(right));
    }

    private Instant taskTimestamp(Map<String, Object> task) {
        String updatedAt = normalizeString(task.get("updatedAt"), normalizeString(task.get("queuedAt"), Instant.EPOCH.toString()));
        try {
            return Instant.parse(updatedAt);
        } catch (Exception ignored) {
            return Instant.EPOCH;
        }
    }

    private void markTaskSuperseded(Map<String, Object> task, String winnerTaskId) {
        task.put("status", SUPERSEDED_STATUS);
        task.put("message", winnerTaskId == null || winnerTaskId.isBlank()
            ? "Superseded duplicate Raven download task."
            : "Superseded by Raven task " + winnerTaskId + ".");
        task.put("updatedAt", Instant.now().toString());
        task.put("details", buildTaskDetails(task));
    }

    private String restorableTaskKey(Map<String, Object> task) {
        String requestId = normalizeString(task.get("requestId"));
        if (!requestId.isBlank()) {
            return "request::" + requestId;
        }
        String providerAndUrl = activeBulkTaskKey(task);
        if (!providerAndUrl.isBlank()) {
            return "download::" + providerAndUrl;
        }
        String titleName = normalizeString(task.get("titleName"));
        return titleName.isBlank() ? "" : "title::" + titleName.toLowerCase(Locale.ROOT);
    }

    private boolean isRequestAlreadyActive(String requestId) {
        String normalized = normalizeString(requestId);
        if (normalized.isBlank()) {
            return false;
        }
        return tasks.values().stream().anyMatch((task) -> {
            String status = normalizeString(task.get("status")).toLowerCase(Locale.ROOT);
            return ("queued".equals(status) || "running".equals(status))
                && normalized.equals(normalizeString(task.get("requestId")));
        });
    }

    private void submitQueuedTask(String taskId, DownloadRequest request) {
        queueWorker.execute(new PrioritizedTask(
            priorityRank(request.priority()),
            queueSequence.getAndIncrement(),
            () -> process(taskId, request)
        ));
    }

    private ThreadPoolExecutor createQueueWorker() {
        return new ThreadPoolExecutor(
            1,
            1,
            0L,
            TimeUnit.MILLISECONDS,
            new PriorityBlockingQueue<>()
        );
    }

    private java.util.concurrent.ExecutorService createPageDownloadWorker() {
        return Executors.newFixedThreadPool(PAGE_DOWNLOAD_WORKER_COUNT);
    }

    private int priorityRank(String value) {
        return switch (normalizePriorityLabel(value)) {
            case PRIORITY_HIGH -> 10;
            case PRIORITY_LOW -> 90;
            default -> 50;
        };
    }

    private String normalizePriorityLabel(String value) {
        String normalized = normalizeString(value).toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case PRIORITY_HIGH -> PRIORITY_HIGH;
            case PRIORITY_LOW -> PRIORITY_LOW;
            default -> PRIORITY_NORMAL;
        };
    }

    private Map<String, Object> normalizeMap(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> normalized = new LinkedHashMap<>();
            map.forEach((key, entryValue) -> normalized.put(String.valueOf(key), entryValue));
            return normalized;
        }
        return Map.of();
    }

    private List<String> objectToStringList(Object value) {
        if (value instanceof List<?> list) {
            return list.stream()
                .map(this::normalizeString)
                .filter((entry) -> !entry.isBlank())
                .toList();
        }
        return List.of();
    }

    private List<String> mergeDisplayStrings(List<String>... values) {
        Map<String, String> merged = new LinkedHashMap<>();
        for (List<String> entries : values) {
            if (entries == null) {
                continue;
            }
            for (String entry : entries) {
                String normalized = normalizeString(entry);
                if (normalized.isBlank()) {
                    continue;
                }
                merged.putIfAbsent(normalized.toLowerCase(Locale.ROOT), normalized);
            }
        }
        return List.copyOf(merged.values());
    }

    private String normalizeString(Object value, String fallback) {
        String normalized = normalizeString(value);
        return normalized.isBlank() ? fallback : normalized;
    }

    private String normalizeString(Object value) {
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

    private String stringValue(Object value) {
        return normalizeString(value);
    }

    private Path resolveChapterStageRoot(Path titleRoot, String archiveName) {
        String stageFolder = LibraryNaming.slugifySegment(archiveName.replaceFirst("\\.[^.]+$", ""));
        return titleRoot.resolve(".scriptarr-stage").resolve(stageFolder);
    }

    private Path awaitDownloadedPage(Future<Path> download) throws IOException, InterruptedException {
        try {
            return download.get(PAGE_DOWNLOAD_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException error) {
            download.cancel(true);
            throw new IOException("Page download timed out after " + PAGE_DOWNLOAD_TIMEOUT.toSeconds() + " seconds.", error);
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof IOException ioException) {
                throw ioException;
            }
            if (cause instanceof InterruptedException interruptedException) {
                throw interruptedException;
            }
            throw new IOException(cause == null ? error.getMessage() : cause.getMessage(), cause == null ? error : cause);
        }
    }

    private void deleteDirectoryQuietly(Path folder) {
        if (folder == null || !Files.exists(folder)) {
            return;
        }
        try (var walk = Files.walk(folder)) {
            walk.sorted(Comparator.reverseOrder()).forEach((path) -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                }
            });
        } catch (IOException ignored) {
        }
    }

    private boolean hasArchiveFiles(Path folder) {
        if (folder == null || !Files.exists(folder) || !Files.isDirectory(folder)) {
            return false;
        }
        try (var files = Files.list(folder)) {
            return files.anyMatch((path) ->
                Files.isRegularFile(path)
                    && path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".cbz")
            );
        } catch (IOException ignored) {
            return false;
        }
    }

    private int countManagedTitleFolders(String stateFolder) {
        Path root = logger.getDownloadsRoot().resolve(stateFolder);
        if (!Files.exists(root) || !Files.isDirectory(root)) {
            return 0;
        }
        try (var typeFolders = Files.list(root).filter(Files::isDirectory)) {
            return typeFolders
                .mapToInt((typeFolder) -> {
                    try (var titles = Files.list(typeFolder).filter(Files::isDirectory)) {
                        return (int) titles.count();
                    } catch (IOException ignored) {
                        return 0;
                    }
                })
                .sum();
        } catch (IOException ignored) {
            return 0;
        }
    }

    private static final class PrioritizedTask implements Runnable, Comparable<PrioritizedTask> {
        private final int priorityRank;
        private final long sequence;
        private final Runnable delegate;

        private PrioritizedTask(int priorityRank, long sequence, Runnable delegate) {
            this.priorityRank = priorityRank;
            this.sequence = sequence;
            this.delegate = delegate;
        }

        @Override
        public void run() {
            delegate.run();
        }

        @Override
        public int compareTo(PrioritizedTask other) {
            int priorityComparison = Integer.compare(this.priorityRank, other.priorityRank);
            if (priorityComparison != 0) {
                return priorityComparison;
            }
            return Long.compare(this.sequence, other.sequence);
        }
    }

    private Map<String, Object> brokerClientPayloadToMap(com.fasterxml.jackson.databind.JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull() || !node.isObject()) {
            return Map.of();
        }
        return brokerClientPayloadToMapObject(node);
    }

    private Map<String, Object> brokerClientPayloadToMapObject(com.fasterxml.jackson.databind.JsonNode node) {
        Map<String, Object> output = new LinkedHashMap<>();
        node.fields().forEachRemaining((entry) -> output.put(entry.getKey(), brokerClientValue(entry.getValue())));
        return output;
    }

    private Object brokerClientValue(com.fasterxml.jackson.databind.JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        if (node.isObject()) {
            return brokerClientPayloadToMapObject(node);
        }
        if (node.isArray()) {
            List<Object> values = new ArrayList<>();
            node.forEach((child) -> values.add(brokerClientValue(child)));
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

    private String normalizeBulkQueueType(String value) {
        String normalized = normalizeString(value).toLowerCase(Locale.ROOT);
        if (normalized.isBlank()) {
            return null;
        }
        return switch (normalized) {
            case "manga", "managa" -> "Manga";
            case "manhwa" -> "Manhwa";
            case "manhua" -> "Manhua";
            case "oel" -> "OEL";
            default -> null;
        };
    }

    private String normalizeQueueType(String value) {
        String normalized = normalizeString(value);
        return normalized.isBlank() ? "" : LibraryNaming.normalizeTypeLabel(normalized);
    }

    private String normalizeBulkTitlePrefix(String value) {
        String normalized = normalizeString(value);
        return normalized.isBlank() ? null : normalized;
    }

    private List<Map<String, String>> filterTitlesByPrefix(List<Map<String, String>> titles, String titlePrefix) {
        if (titles == null || titles.isEmpty() || titlePrefix == null || titlePrefix.isBlank()) {
            return List.of();
        }

        String normalizedPrefix = titlePrefix.toLowerCase(Locale.ROOT);
        List<Map<String, String>> matched = new ArrayList<>();
        for (Map<String, String> title : titles) {
            if (title == null || title.isEmpty()) {
                continue;
            }

            String comparableTitle = normalizePrefixComparableTitle(title.get("title"));
            if (comparableTitle.isBlank()) {
                continue;
            }

            String lowerTitle = comparableTitle.toLowerCase(Locale.ROOT);
            if (lowerTitle.startsWith(normalizedPrefix)) {
                matched.add(new LinkedHashMap<>(title));
            }
        }

        return matched.isEmpty() ? List.of() : List.copyOf(matched);
    }

    private boolean isTaskAlreadyActive(String activeKey, String titleName) {
        return tasks.values().stream().anyMatch((task) -> {
            String status = String.valueOf(task.getOrDefault("status", "")).trim().toLowerCase(Locale.ROOT);
            if (!"queued".equals(status) && !"running".equals(status)) {
                return false;
            }
            String taskKey = activeBulkTaskKey(task);
            if (!taskKey.isBlank() && taskKey.equals(activeKey)) {
                return true;
            }
            return normalizeString(task.get("titleName")).equalsIgnoreCase(titleName);
        });
    }

    private boolean isTitleAlreadyInLibrary(List<LibraryTitle> titles, String titleUrl, String titleName, String requestType) {
        String normalizedUrl = normalizeString(titleUrl);
        String normalizedTitle = normalizeString(titleName).toLowerCase(Locale.ROOT);
        String normalizedType = LibraryNaming.normalizeTypeSlug(requestType);
        return titles != null && titles.stream().anyMatch((title) -> {
            String existingUrl = normalizeString(title.sourceUrl());
            if (!normalizedUrl.isBlank() && normalizedUrl.equals(existingUrl)) {
                return true;
            }
            return !normalizedTitle.isBlank()
                && normalizedTitle.equals(normalizeString(title.title()).toLowerCase(Locale.ROOT))
                && normalizedType.equals(LibraryNaming.normalizeTypeSlug(normalizeString(title.libraryTypeSlug(), title.mediaType())));
        });
    }

    private String activeBulkTaskKey(Map<String, ?> task) {
        String providerId = normalizeString(task.get("providerId"));
        String titleUrl = normalizeString(task.get("titleUrl"));
        if (providerId.isBlank() && titleUrl.isBlank()) {
            return "";
        }
        return providerId.toLowerCase(Locale.ROOT) + "::" + titleUrl;
    }

    private String resolveBulkQueueStatus(
        List<String> queuedTitles,
        List<String> skippedActiveTitles,
        List<String> skippedAdultContentTitles,
        List<String> skippedNoMetadataTitles,
        List<String> skippedAmbiguousMetadataTitles,
        List<String> failedTitles
    ) {
        boolean hasQueued = queuedTitles != null && !queuedTitles.isEmpty();
        boolean hasSkippedActive = skippedActiveTitles != null && !skippedActiveTitles.isEmpty();
        boolean hasSkippedAdultContent = skippedAdultContentTitles != null && !skippedAdultContentTitles.isEmpty();
        boolean hasSkippedNoMetadata = skippedNoMetadataTitles != null && !skippedNoMetadataTitles.isEmpty();
        boolean hasSkippedAmbiguous = skippedAmbiguousMetadataTitles != null && !skippedAmbiguousMetadataTitles.isEmpty();
        boolean hasFailed = failedTitles != null && !failedTitles.isEmpty();

        if (hasQueued && !hasSkippedActive && !hasSkippedAdultContent && !hasSkippedNoMetadata && !hasSkippedAmbiguous && !hasFailed) {
            return BulkQueueDownloadResult.STATUS_QUEUED;
        }
        if (!hasQueued && hasSkippedActive && !hasSkippedAdultContent && !hasSkippedNoMetadata && !hasSkippedAmbiguous && !hasFailed) {
            return BulkQueueDownloadResult.STATUS_ALREADY_ACTIVE;
        }
        return BulkQueueDownloadResult.STATUS_PARTIAL;
    }

    private String buildBulkQueueMessage(
        List<String> queuedTitles,
        List<String> skippedActiveTitles,
        List<String> skippedAdultContentTitles,
        List<String> skippedNoMetadataTitles,
        List<String> skippedAmbiguousMetadataTitles,
        List<String> failedTitles,
        int matchedCount
    ) {
        int queuedCount = queuedTitles == null ? 0 : queuedTitles.size();
        int skippedActiveCount = skippedActiveTitles == null ? 0 : skippedActiveTitles.size();
        int skippedAdultContentCount = skippedAdultContentTitles == null ? 0 : skippedAdultContentTitles.size();
        int skippedNoMetadataCount = skippedNoMetadataTitles == null ? 0 : skippedNoMetadataTitles.size();
        int skippedAmbiguousCount = skippedAmbiguousMetadataTitles == null ? 0 : skippedAmbiguousMetadataTitles.size();
        int failedCount = failedTitles == null ? 0 : failedTitles.size();

        if (matchedCount <= 0) {
            return "No titles matched the supplied filters.";
        }
        if (queuedCount > 0 && skippedActiveCount == 0 && skippedAdultContentCount == 0 && skippedNoMetadataCount == 0
            && skippedAmbiguousCount == 0 && failedCount == 0) {
            return "Queued " + queuedCount + " title(s) for download.";
        }
        if (queuedCount == 0 && skippedActiveCount > 0 && skippedAdultContentCount == 0 && skippedNoMetadataCount == 0
            && skippedAmbiguousCount == 0 && failedCount == 0) {
            return skippedActiveCount == 1
                ? "Download already in progress for: " + skippedActiveTitles.getFirst()
                : "Downloads already in progress for: " + String.join(", ", skippedActiveTitles);
        }

        return "Queued " + queuedCount + " title(s). Skipped " + skippedActiveCount
            + " already-active title(s), " + skippedAdultContentCount + " adult or unverified adult title(s), "
            + skippedNoMetadataCount + " without confident metadata, " + skippedAmbiguousCount
            + " with ambiguous metadata. Failed " + failedCount + " title(s).";
    }

    private String normalizePrefixComparableTitle(String rawTitle) {
        String trimmed = normalizeString(rawTitle);
        if (trimmed.isBlank()) {
            return "";
        }

        int index = 0;
        while (index < trimmed.length()) {
            char candidate = trimmed.charAt(index);
            if (Character.isWhitespace(candidate) || !Character.isLetterOrDigit(candidate)) {
                index++;
                continue;
            }
            break;
        }

        return trimmed.substring(Math.min(index, trimmed.length())).trim();
    }
}
