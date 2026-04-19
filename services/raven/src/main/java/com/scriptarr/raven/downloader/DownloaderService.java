package com.scriptarr.raven.downloader;

import com.scriptarr.raven.support.ScriptarrLogger;
import com.scriptarr.raven.vpn.VpnService;
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
    private final ScriptarrLogger logger;

    /**
     * Create the download queue service.
     *
     * @param titleScraper scraper used to search titles and chapters
     * @param sourceFinder scraper used to resolve page image URLs
     * @param vpnService VPN coordinator for optional protected downloads
     * @param logger shared Raven logger
     */
    public DownloaderService(TitleScraper titleScraper, SourceFinder sourceFinder, VpnService vpnService, ScriptarrLogger logger) {
        this.titleScraper = titleScraper;
        this.sourceFinder = sourceFinder;
        this.vpnService = vpnService;
        this.logger = logger;
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
        task.put("titleName", request.titleName());
        task.put("titleUrl", request.titleUrl());
        task.put("requestType", request.requestType());
        task.put("requestedBy", request.requestedBy());
        task.put("status", "queued");
        task.put("message", "Queued for Raven download.");
        task.put("percent", 0);
        task.put("queuedAt", Instant.now().toString());
        tasks.put(taskId, task);

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

            Path titleRoot = logger.getDownloadsRoot().resolve(sanitizeFileName(request.titleName()));
            Files.createDirectories(titleRoot);

            int total = chapters.size();
            for (int index = 0; index < chapters.size(); index++) {
                Map<String, String> chapter = chapters.get(index);
                downloadChapter(titleRoot, request, chapter);
                int percent = Math.max(10, (int) (((index + 1) / (double) total) * 100));
                update(taskId, "running", "Downloaded chapter " + chapter.get("chapter_number") + ".", percent);
            }

            update(taskId, "completed", "Raven download completed.", 100);
        } catch (Exception error) {
            update(taskId, "failed", error.getMessage(), 0);
            logger.error("DOWNLOAD", "Raven download failed.", error);
        }
    }

    private void downloadChapter(Path titleRoot, DownloadRequest request, Map<String, String> chapter) throws IOException, InterruptedException {
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
