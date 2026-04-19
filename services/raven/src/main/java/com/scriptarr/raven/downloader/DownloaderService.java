package com.scriptarr.raven.downloader;

import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryNaming;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.settings.RavenBrokerClient;
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
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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

    private final Map<String, Map<String, Object>> tasks = new ConcurrentHashMap<>();
    private final ExecutorService queueWorker = Executors.newSingleThreadExecutor();
    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build();

    private final TitleScraper titleScraper;
    private final SourceFinder sourceFinder;
    private final VpnService vpnService;
    private final LibraryService libraryService;
    private final RavenBrokerClient brokerClient;
    private final ScriptarrLogger logger;

    /**
     * Create the download queue service.
     *
     * @param titleScraper scraper used to search titles and chapters
     * @param sourceFinder scraper used to resolve page image URLs
     * @param vpnService VPN coordinator for optional protected downloads
     * @param libraryService library projection and persistence service
     * @param brokerClient Sage-backed broker client for Raven state
     * @param logger shared Raven logger
     */
    public DownloaderService(
        TitleScraper titleScraper,
        SourceFinder sourceFinder,
        VpnService vpnService,
        LibraryService libraryService,
        RavenBrokerClient brokerClient,
        ScriptarrLogger logger
    ) {
        this.titleScraper = titleScraper;
        this.sourceFinder = sourceFinder;
        this.vpnService = vpnService;
        this.libraryService = libraryService;
        this.brokerClient = brokerClient;
        this.logger = logger;
    }

    /**
     * Restore queued Raven download tasks so the serialized worker can resume
     * after a container restart.
     */
    @PostConstruct
    public void restorePersistedTasks() {
        try {
            var payload = brokerClient.listDownloadTasks();
            if (payload == null || !payload.isArray()) {
                return;
            }

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
                copyIfPresent(node, task, "libraryTypeLabel");
                copyIfPresent(node, task, "libraryTypeSlug");
                copyIfPresent(node, task, "workingRoot");
                copyIfPresent(node, task, "downloadRoot");

                String taskId = String.valueOf(task.get("taskId"));
                if (taskId.isBlank()) {
                    return;
                }

                tasks.put(taskId, task);
                String status = String.valueOf(task.get("status"));
                if ("queued".equals(status) || "running".equals(status)) {
                    task.put("status", "queued");
                    task.put("message", "Restored after Raven restart.");
                    persistTask(taskId);
                    queueWorker.submit(() -> process(taskId, new DownloadRequest(
                        String.valueOf(task.get("titleName")),
                        String.valueOf(task.get("titleUrl")),
                        String.valueOf(task.get("requestType")),
                        String.valueOf(task.get("requestedBy"))
                    )));
                }
            });
        } catch (Exception error) {
            logger.warn("DOWNLOAD", "Failed to restore persisted Raven tasks.", error.getMessage());
        }
    }

    /**
     * Search the upstream source for titles Raven can queue.
     *
     * @param query user-supplied search text
     * @return normalized search results
     */
    public List<Map<String, String>> searchTitles(String query) {
        return titleScraper.searchManga(query);
    }

    /**
     * Queue a new download job and return the initial task snapshot.
     *
     * @param request normalized download request payload
     * @return queued task snapshot
     */
    public Map<String, Object> queueDownload(DownloadRequest request) {
        String taskId = "task_" + UUID.randomUUID().toString().replace("-", "");
        Map<String, Object> task = new LinkedHashMap<>();
        task.put("taskId", taskId);
        task.put("jobId", taskId);
        task.put("titleId", "");
        task.put("titleName", request.titleName());
        task.put("titleUrl", request.titleUrl());
        task.put("requestType", request.requestType());
        task.put("requestedBy", request.requestedBy());
        task.put("status", "queued");
        task.put("message", "Queued for Raven download.");
        task.put("percent", 0);
        task.put("queuedAt", Instant.now().toString());
        task.put("updatedAt", Instant.now().toString());
        task.put("libraryTypeLabel", LibraryNaming.normalizeTypeLabel(request.requestType()));
        task.put("libraryTypeSlug", LibraryNaming.normalizeTypeSlug(request.requestType()));
        tasks.put(taskId, task);
        persistTask(taskId);

        queueWorker.submit(() -> process(taskId, request));
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
     * Stop the queue worker when the Spring context shuts down.
     */
    @PreDestroy
    public void shutdown() {
        queueWorker.shutdownNow();
    }

    private void process(String taskId, DownloadRequest request) {
        try {
            update(taskId, "running", "Preparing Raven download.", 5);
            vpnService.ensureConnectedIfEnabled();

            List<Map<String, String>> chapters = titleScraper.getChapters(request.titleUrl());
            if (chapters.isEmpty()) {
                throw new IllegalStateException("No chapters were found for the requested title URL.");
            }
            TitleDetails details = titleScraper.getTitleDetails(request.titleUrl());
            String typeLabel = resolveLibraryTypeLabel(request, details);
            String typeSlug = LibraryNaming.normalizeTypeSlug(typeLabel);
            Path workingRoot = resolveTitleRoot(DOWNLOADING_FOLDER_NAME, request.titleName(), typeSlug);
            Path finalRoot = resolveTitleRoot(DOWNLOADED_FOLDER_NAME, request.titleName(), typeSlug);

            rememberRoots(taskId, typeLabel, typeSlug, workingRoot, finalRoot);
            Files.createDirectories(workingRoot);

            int total = chapters.size();
            Map<String, String> sourceByChapter = new LinkedHashMap<>();
            for (int index = 0; index < chapters.size(); index++) {
                Map<String, String> chapter = chapters.get(index);
                Path archivePath = downloadChapter(workingRoot, request, chapter);
                String chapterNumber = normalizeStoredChapterNumber(chapter.getOrDefault("chapter_number", String.valueOf(index + 1)));
                sourceByChapter.put(chapterNumber, chapter.get("href"));
                int percent = Math.max(10, (int) (((index + 1) / (double) total) * 90));
                update(taskId, "running", "Downloaded chapter " + chapterNumber + ".", percent);
            }

            promoteTitleFolder(workingRoot, finalRoot);
            LibraryTitle title = libraryService.recordDownloadedTitle(
                request.titleName(),
                typeLabel,
                request.titleUrl(),
                null,
                details,
                buildLibraryChapters(finalRoot, sourceByChapter),
                workingRoot,
                finalRoot
            );
            if (title != null) {
                Map<String, Object> task = tasks.get(taskId);
                if (task != null) {
                    task.put("titleId", title.id());
                    task.put("libraryTypeLabel", title.libraryTypeLabel());
                    task.put("libraryTypeSlug", title.libraryTypeSlug());
                    task.put("workingRoot", title.workingRoot());
                    task.put("downloadRoot", title.downloadRoot());
                }
            }

            update(taskId, "completed", "Raven download completed.", 100);
        } catch (Exception error) {
            update(taskId, "failed", error.getMessage(), 0);
            logger.error("DOWNLOAD", "Raven download failed.", error);
        }
    }

    private Path downloadChapter(Path titleRoot, DownloadRequest request, Map<String, String> chapter) throws IOException, InterruptedException {
        List<String> images = sourceFinder.findSource(chapter.get("href"));
        if (images.isEmpty()) {
            throw new IllegalStateException("No chapter pages were found for " + chapter.get("href"));
        }

        String chapterNumber = normalizeStoredChapterNumber(chapter.getOrDefault("chapter_number", "0"));
        String archiveName = LibraryNaming.sanitizeTitleFolder(request.titleName()) + "_c" + chapterNumber + ".cbz";
        Path archivePath = titleRoot.resolve(archiveName);

        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archivePath))) {
            for (int index = 0; index < images.size(); index++) {
                String imageUrl = images.get(index);
                byte[] bytes = downloadImage(imageUrl);
                String extension = resolveExtension(imageUrl, "jpg");
                ZipEntry entry = new ZipEntry(String.format("%03d.%s", index + 1, extension));
                zip.putNextEntry(entry);
                zip.write(bytes);
                zip.closeEntry();
            }
        }
        logger.info("DOWNLOAD", "Saved chapter archive.", "file=" + archivePath.getFileName());
        return archivePath;
    }

    private List<LibraryChapter> buildLibraryChapters(Path finalRoot, Map<String, String> sourceByChapter) throws IOException {
        try (var archives = Files.list(finalRoot)) {
            return archives
                .filter(Files::isRegularFile)
                .filter((path) -> path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".cbz"))
                .sorted()
                .map((path) -> {
                    String chapterNumber = extractChapterNumber(path.getFileName().toString());
                    return new LibraryChapter(
                        "",
                        "Chapter " + chapterNumber,
                        chapterNumber,
                        countArchiveEntries(path),
                        null,
                        true,
                        path.toString(),
                        sourceByChapter.getOrDefault(chapterNumber, null)
                    );
                })
                .toList();
        }
    }

    private byte[] downloadImage(String imageUrl) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(imageUrl))
            .timeout(Duration.ofSeconds(30))
            .GET()
            .build();
        HttpResponse<InputStream> response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IOException("Image download failed with status " + response.statusCode() + " for " + imageUrl);
        }
        return response.body().readAllBytes();
    }

    private void update(String taskId, String status, String message, int percent) {
        Map<String, Object> task = tasks.get(taskId);
        if (task == null) {
            return;
        }
        task.put("status", status);
        task.put("message", message);
        task.put("percent", percent);
        task.put("updatedAt", Instant.now().toString());
        persistTask(taskId);
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
        persistTask(taskId);
    }

    private void persistTask(String taskId) {
        Map<String, Object> task = tasks.get(taskId);
        if (task == null) {
            return;
        }
        try {
            brokerClient.putDownloadTask(taskId, task);
            String jobId = String.valueOf(task.getOrDefault("jobId", taskId));
            brokerClient.putJob(jobId, buildJobPayload(jobId, task));
            brokerClient.putJobTask(jobId, jobTaskId(jobId), buildJobTaskPayload(jobId, task));
        } catch (Exception error) {
            logger.warn("DOWNLOAD", "Failed to persist a Raven task snapshot.", error.getMessage());
        }
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
            "libraryTypeLabel", String.valueOf(task.getOrDefault("libraryTypeLabel", "")),
            "libraryTypeSlug", String.valueOf(task.getOrDefault("libraryTypeSlug", ""))
        ));
        payload.put("result", Map.of(
            "titleId", String.valueOf(task.getOrDefault("titleId", "")),
            "workingRoot", String.valueOf(task.getOrDefault("workingRoot", "")),
            "downloadRoot", String.valueOf(task.getOrDefault("downloadRoot", "")),
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
            "requestType", String.valueOf(task.getOrDefault("requestType", "manga"))
        ));
        payload.put("result", Map.of(
            "titleId", String.valueOf(task.getOrDefault("titleId", "")),
            "workingRoot", String.valueOf(task.getOrDefault("workingRoot", "")),
            "downloadRoot", String.valueOf(task.getOrDefault("downloadRoot", ""))
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
        return "completed".equals(status) || "failed".equals(status);
    }

    private Path resolveTitleRoot(String stateFolder, String titleName, String typeSlug) {
        return logger.getDownloadsRoot()
            .resolve(stateFolder)
            .resolve(typeSlug)
            .resolve(LibraryNaming.sanitizeTitleFolder(titleName));
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

    private int countArchiveEntries(Path archivePath) {
        try (java.util.zip.ZipFile zipFile = new java.util.zip.ZipFile(archivePath.toFile())) {
            return (int) zipFile.stream().filter((entry) -> !entry.isDirectory()).count();
        } catch (Exception ignored) {
            return 1;
        }
    }

    private String extractChapterNumber(String fileName) {
        String normalized = fileName.replaceFirst("(?i)\\.cbz$", "");
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("(?i)(?:chapter|c|_c)([0-9]+(?:\\.[0-9]+)?)").matcher(normalized);
        if (matcher.find()) {
            return normalizeStoredChapterNumber(matcher.group(1));
        }
        matcher = java.util.regex.Pattern.compile("([0-9]+(?:\\.[0-9]+)?)").matcher(normalized);
        return matcher.find() ? normalizeStoredChapterNumber(matcher.group(1)) : String.valueOf(Math.abs(fileName.hashCode()));
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

    private String resolveExtension(String url, String fallback) {
        int dotIndex = url.lastIndexOf('.');
        if (dotIndex < 0 || dotIndex >= url.length() - 1) {
            return fallback;
        }
        String extension = url.substring(dotIndex + 1).toLowerCase(Locale.ROOT);
        if (extension.contains("?")) {
            extension = extension.substring(0, extension.indexOf('?'));
        }
        return extension.isBlank() ? fallback : extension;
    }

    private void copyIfPresent(com.fasterxml.jackson.databind.JsonNode node, Map<String, Object> target, String field) {
        if (node.hasNonNull(field) && !node.path(field).asText("").isBlank()) {
            target.put(field, node.path(field).asText(""));
        }
    }
}
