package com.scriptarr.raven.downloader;

import com.scriptarr.raven.support.ScriptarrLogger;
import com.scriptarr.raven.vpn.VpnService;
import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.settings.RavenVaultClient;
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
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Serialized Raven download queue that scrapes chapters and stores CBZ archives.
 */
@Service
public class DownloaderService {
    private final Map<String, Map<String, Object>> tasks = new ConcurrentHashMap<>();
    private final ExecutorService queueWorker = Executors.newSingleThreadExecutor();
    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build();

    private final TitleScraper titleScraper;
    private final SourceFinder sourceFinder;
    private final VpnService vpnService;
    private final LibraryService libraryService;
    private final RavenVaultClient vaultClient;
    private final ScriptarrLogger logger;

    /**
     * Create the download queue service.
     *
     * @param titleScraper scraper used to search titles and chapters
     * @param sourceFinder scraper used to resolve page image URLs
     * @param vpnService VPN coordinator for optional protected downloads
     * @param libraryService library projection and persistence service
     * @param vaultClient Vault-backed Raven persistence client
     * @param logger shared Raven logger
     */
    public DownloaderService(
        TitleScraper titleScraper,
        SourceFinder sourceFinder,
        VpnService vpnService,
        LibraryService libraryService,
        RavenVaultClient vaultClient,
        ScriptarrLogger logger
    ) {
        this.titleScraper = titleScraper;
        this.sourceFinder = sourceFinder;
        this.vpnService = vpnService;
        this.libraryService = libraryService;
        this.vaultClient = vaultClient;
        this.logger = logger;
    }

    /**
     * Restore queued Raven download tasks so the serialized worker can resume
     * after a container restart.
     */
    @PostConstruct
    public void restorePersistedTasks() {
        try {
            var payload = vaultClient.listDownloadTasks();
            if (payload == null || !payload.isArray()) {
                return;
            }

            payload.forEach((node) -> {
                Map<String, Object> task = new LinkedHashMap<>();
                task.put("taskId", node.path("taskId").asText(""));
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
        task.put("titleId", libraryService.slugifyTitleId(request.titleName()));
        task.put("titleName", request.titleName());
        task.put("titleUrl", request.titleUrl());
        task.put("requestType", request.requestType());
        task.put("requestedBy", request.requestedBy());
        task.put("status", "queued");
        task.put("message", "Queued for Raven download.");
        task.put("percent", 0);
        task.put("queuedAt", Instant.now().toString());
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

            Path titleRoot = resolveTitleRoot(request);
            Files.createDirectories(titleRoot);

            int total = chapters.size();
            for (int index = 0; index < chapters.size(); index++) {
                Map<String, String> chapter = chapters.get(index);
                Path archivePath = downloadChapter(titleRoot, request, chapter);
                libraryService.recordDownloadedChapter(
                    request.titleName(),
                    request.requestType(),
                    request.titleUrl(),
                    null,
                    details,
                    new LibraryChapter(
                        chapterId(request, chapter),
                        chapterLabel(chapter),
                        chapter.getOrDefault("chapter_number", String.valueOf(index + 1)),
                        countArchiveEntries(archivePath),
                        null,
                        true,
                        archivePath.toString(),
                        chapter.get("href")
                    ),
                    archivePath
                );
                int percent = Math.max(10, (int) (((index + 1) / (double) total) * 100));
                update(taskId, "running", "Downloaded chapter " + chapter.get("chapter_number") + ".", percent);
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

        String chapterNumber = chapter.getOrDefault("chapter_number", "0");
        String archiveName = sanitizeFileName(request.titleName()) + "_c" + chapterNumber + ".cbz";
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

    private void persistTask(String taskId) {
        Map<String, Object> task = tasks.get(taskId);
        if (task == null) {
            return;
        }
        try {
            vaultClient.putDownloadTask(taskId, task);
        } catch (Exception error) {
            logger.warn("DOWNLOAD", "Failed to persist a Raven task snapshot.", error.getMessage());
        }
    }

    private Path resolveTitleRoot(DownloadRequest request) {
        String mediaType = request.requestType() == null || request.requestType().isBlank()
            ? "manga"
            : request.requestType().trim().toLowerCase(Locale.ROOT);
        return logger.getDownloadsRoot()
            .resolve(mediaType)
            .resolve(sanitizeFileName(request.titleName()));
    }

    private String chapterId(DownloadRequest request, Map<String, String> chapter) {
        return libraryService.slugifyTitleId(request.titleName())
            + "-c"
            + chapter.getOrDefault("chapter_number", "0").replace('.', '-');
    }

    private String chapterLabel(Map<String, String> chapter) {
        String chapterNumber = chapter.getOrDefault("chapter_number", "0");
        return "Chapter " + chapterNumber;
    }

    private int countArchiveEntries(Path archivePath) {
        try (java.util.zip.ZipFile zipFile = new java.util.zip.ZipFile(archivePath.toFile())) {
            return (int) zipFile.stream().filter((entry) -> !entry.isDirectory()).count();
        } catch (Exception ignored) {
            return 1;
        }
    }

    private String sanitizeFileName(String value) {
        return value == null ? "scriptarr-title" : value.replaceAll("[^\\p{Alnum}._-]+", "_").replaceAll("_+", "_");
    }

    private String resolveExtension(String url, String fallback) {
        int dotIndex = url.lastIndexOf('.');
        if (dotIndex < 0 || dotIndex >= url.length() - 1) {
            return fallback;
        }
        String extension = url.substring(dotIndex + 1).toLowerCase();
        if (extension.contains("?")) {
            extension = extension.substring(0, extension.indexOf('?'));
        }
        return extension.isBlank() ? fallback : extension;
    }
}
