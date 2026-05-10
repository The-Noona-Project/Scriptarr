package com.scriptarr.raven.api;

import com.scriptarr.raven.downloader.DownloadRequest;
import com.scriptarr.raven.downloader.BulkQueueDownloadResult;
import com.scriptarr.raven.downloader.BulkRunService;
import com.scriptarr.raven.downloader.DownloadIntakeService;
import com.scriptarr.raven.downloader.DownloaderService;
import com.scriptarr.raven.library.ReaderChapterPayload;
import com.scriptarr.raven.library.ReaderManifest;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.RenderedPage;
import com.scriptarr.raven.metadata.MetadataService;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.vpn.VpnService;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * HTTP API controller for Raven library, downloader, metadata, and reader endpoints.
 */
@RestController
@RequestMapping
public class RavenController {
    private final MetadataService metadataService;
    private final DownloadIntakeService downloadIntakeService;
    private final DownloaderService downloaderService;
    private final BulkRunService bulkRunService;
    private final VpnService vpnService;
    private final RavenSettingsService settingsService;
    private final LibraryService libraryService;

    /**
     * Create the Raven controller.
     *
     * @param metadataService metadata service
     * @param downloadIntakeService intake orchestration service
     * @param downloaderService download queue service
     * @param bulkRunService durable bulk-run orchestration service
     * @param vpnService VPN status service
     * @param settingsService Raven settings service
     * @param libraryService library projection service
     */
    public RavenController(
        MetadataService metadataService,
        DownloadIntakeService downloadIntakeService,
        DownloaderService downloaderService,
        BulkRunService bulkRunService,
        VpnService vpnService,
        RavenSettingsService settingsService,
        LibraryService libraryService
    ) {
        this.metadataService = metadataService;
        this.downloadIntakeService = downloadIntakeService;
        this.downloaderService = downloaderService;
        this.bulkRunService = bulkRunService;
        this.vpnService = vpnService;
        this.settingsService = settingsService;
        this.libraryService = libraryService;
    }

    /**
     * Expose the Raven health payload.
     *
     * @return health payload with download, VPN, and provider state
     */
    @GetMapping("/health")
    public Map<String, Object> health() {
        return Map.of(
            "ok", true,
            "service", "scriptarr-raven",
            "downloads", downloaderService.stats(),
            "vpn", vpnService.status(),
            "metadataProviders", settingsService.getMetadataProviderSettings(),
            "downloadProviders", settingsService.getDownloadProviderSettings()
        );
    }

    /**
     * Test Raven's configured VPN path through the same guard used by download
     * tasks. A successful enabled test leaves the tunnel connected.
     *
     * @return VPN test payload
     */
    @PostMapping("/v1/vpn/test")
    public ResponseEntity<Map<String, Object>> testVpn() {
        Map<String, Object> vpn = vpnService.testConnection();
        boolean ok = Boolean.TRUE.equals(vpn.get("ok"))
            || Boolean.TRUE.equals(vpn.get("protected"))
            || "disabled".equals(String.valueOf(vpn.getOrDefault("state", "")));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", ok);
        payload.put("vpn", vpn);
        if (!ok) {
            payload.put("error", String.valueOf(vpn.getOrDefault("lastError", "Raven VPN test failed.")));
        }
        return ResponseEntity.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).body(payload);
    }

    /**
     * Reload live Raven download runtime settings from the broker.
     *
     * @return refreshed runtime and queue slot snapshot
     */
    @PostMapping("/v1/downloads/runtime/reload")
    public Map<String, Object> reloadDownloadRuntime() {
        return downloaderService.reloadDownloadRuntimeSettings();
    }

    /**
     * Search enabled metadata providers and resolve download availability.
     *
     * @param query intake search query
     * @return normalized intake candidates
     */
    @GetMapping("/v1/intake/search")
    public Map<String, Object> searchIntake(@RequestParam("query") String query) {
        return Map.of(
            "query", query == null ? "" : query.trim(),
            "results", downloadIntakeService.search(query)
        );
    }

    /**
     * Resolve explicit download-provider options from a selected metadata row.
     *
     * @param body intake resolution payload
     * @return normalized metadata snapshot and concrete download targets
     */
    @PostMapping("/v1/intake/download-options")
    public ResponseEntity<Map<String, Object>> intakeDownloadOptions(@RequestBody Map<String, Object> body) {
        Map<String, Object> selectedMetadata = body.get("selectedMetadata") instanceof Map<?, ?> metadata
            ? (Map<String, Object>) metadata
            : Map.of();
        if (String.valueOf(selectedMetadata.getOrDefault("provider", "")).trim().isBlank()
            || String.valueOf(selectedMetadata.getOrDefault("providerSeriesId", "")).trim().isBlank()) {
            return ResponseEntity.badRequest().body(Map.of(
                "error", "selectedMetadata with provider and providerSeriesId is required."
            ));
        }

        return ResponseEntity.ok(downloadIntakeService.resolveDownloadOptions(
            String.valueOf(body.getOrDefault("query", "")).trim(),
            selectedMetadata
        ));
    }

    /**
     * List the current Raven library titles.
     *
     * @return library payload
     */
    @GetMapping("/v1/library")
    public Map<String, Object> library(
        @RequestParam(name = "view", required = false) String view,
        @RequestParam Map<String, String> query
    ) {
        if ("card".equalsIgnoreCase(view == null ? "" : view.trim())) {
            return libraryService.listTitleCardPage(query);
        }
        return Map.of("titles", libraryService.listTitles());
    }

    /**
     * Load a single Raven library title.
     *
     * @param titleId title id to resolve
     * @return matching title or a not-found payload
     */
    @GetMapping("/v1/library/{titleId}")
    public ResponseEntity<?> libraryTitle(@PathVariable("titleId") String titleId) {
        var title = libraryService.findTitle(titleId);
        if (title == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Title not found."));
        }
        return ResponseEntity.ok(title);
    }

    /**
     * Load alternate repair candidates for an existing Raven library title.
     *
     * @param titleId title id to inspect
     * @return one row per concrete provider target
     */
    @GetMapping("/v1/library/{titleId}/repair-options")
    public ResponseEntity<?> libraryRepairOptions(@PathVariable("titleId") String titleId) {
        var title = libraryService.findTitle(titleId);
        if (title == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Title not found."));
        }
        return ResponseEntity.ok(Map.of(
            "titleId", title.id(),
            "currentSourceUrl", title.sourceUrl(),
            "options", downloadIntakeService.repairOptions(title)
        ));
    }

    /**
     * Queue a safe replacement download for an existing Raven library title.
     *
     * @param titleId title id to replace
     * @param body selected provider target payload
     * @return accepted replacement task payload or a validation error
     */
    @PostMapping("/v1/library/{titleId}/replace-source")
    public ResponseEntity<Map<String, Object>> replaceLibrarySource(
        @PathVariable("titleId") String titleId,
        @RequestBody Map<String, Object> body
    ) {
        var title = libraryService.findTitle(titleId);
        if (title == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Title not found."));
        }

        String providerId = String.valueOf(body.getOrDefault("providerId", "")).trim();
        String titleUrl = String.valueOf(body.getOrDefault("titleUrl", "")).trim();
        if (providerId.isBlank() || titleUrl.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "providerId and titleUrl are required."));
        }

        Map<String, Object> selectedDownload = new java.util.LinkedHashMap<>();
        selectedDownload.put("providerId", providerId);
        selectedDownload.put("providerName", String.valueOf(body.getOrDefault("providerName", providerId)).trim());
        selectedDownload.put("titleName", String.valueOf(body.getOrDefault("titleName", title.title())).trim());
        selectedDownload.put("titleUrl", titleUrl);
        selectedDownload.put("requestType", String.valueOf(body.getOrDefault("requestType", title.libraryTypeLabel())).trim());
        selectedDownload.put("libraryTypeLabel", String.valueOf(body.getOrDefault("libraryTypeLabel", title.libraryTypeLabel())).trim());
        selectedDownload.put("libraryTypeSlug", String.valueOf(body.getOrDefault("libraryTypeSlug", title.libraryTypeSlug())).trim());
        selectedDownload.put("coverUrl", String.valueOf(body.getOrDefault("coverUrl", title.coverUrl())).trim());

        Map<String, Object> selectedMetadata = new java.util.LinkedHashMap<>();
        selectedMetadata.put("provider", title.metadataProvider() == null ? "" : title.metadataProvider());
        selectedMetadata.put("providerSeriesId", title.id());
        selectedMetadata.put("title", title.title());
        selectedMetadata.put("summary", title.summary() == null ? "" : title.summary());
        selectedMetadata.put("coverUrl", title.coverUrl() == null ? "" : title.coverUrl());
        selectedMetadata.put("aliases", title.aliases() == null ? List.of() : title.aliases());
        selectedMetadata.put("type", title.libraryTypeLabel() == null ? "manga" : title.libraryTypeLabel());

        try {
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(downloaderService.queueDownload(new DownloadRequest(
                title.title(),
                titleUrl,
                title.libraryTypeLabel() == null ? "manga" : title.libraryTypeLabel(),
                String.valueOf(body.getOrDefault("requestedBy", "scriptarr-admin")).trim(),
                providerId,
                "",
                selectedMetadata,
                selectedDownload,
                title.id(),
                "high"
            )));
        } catch (IllegalStateException error) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", error.getMessage()));
        }
    }

    /**
     * Load the reader manifest for a title.
     *
     * @param titleId title id to resolve
     * @return reader manifest or a not-found payload
     */
    @GetMapping("/v1/reader/{titleId}")
    public ResponseEntity<?> readerManifest(@PathVariable("titleId") String titleId) {
        ReaderManifest payload = libraryService.readerManifest(titleId);
        if (payload == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Reader manifest not found."));
        }
        return ResponseEntity.ok(payload);
    }

    /**
     * Load the reader payload for a specific chapter.
     *
     * @param titleId title id to resolve
     * @param chapterId chapter id to resolve
     * @return chapter payload or a not-found payload
     */
    @GetMapping("/v1/reader/{titleId}/{chapterId}")
    public ResponseEntity<?> readerChapter(
        @PathVariable("titleId") String titleId,
        @PathVariable("chapterId") String chapterId
    ) {
        ReaderChapterPayload payload = libraryService.readerChapter(titleId, chapterId);
        if (payload == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Reader chapter not found."));
        }
        return ResponseEntity.ok(payload);
    }

    /**
     * Render a single reader page as SVG.
     *
     * @param titleId title id to resolve
     * @param chapterId chapter id to resolve
     * @param pageIndex zero-based page index
     * @return SVG bytes or a not-found payload
     */
    @GetMapping("/v1/reader/{titleId}/{chapterId}/page/{pageIndex}")
    public ResponseEntity<?> readerPage(
        @PathVariable("titleId") String titleId,
        @PathVariable("chapterId") String chapterId,
        @PathVariable("pageIndex") int pageIndex
    ) {
        RenderedPage payload = libraryService.renderReaderPage(titleId, chapterId, pageIndex);
        if (payload == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        }
        return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType(payload.mediaType()))
            .body(payload.bytes());
    }

    /**
     * Search upstream download sources for a title.
     *
     * @param query title query to search
     * @return candidate source titles
     */
    @GetMapping("/v1/downloads/search")
    public List<Map<String, String>> searchDownloads(@RequestParam("query") String query) {
        return downloaderService.searchTitles(query);
    }

    /**
     * Queue a new Raven download task.
     *
     * @param body request payload from Moon or Sage
     * @return accepted task payload or a validation error
     */
    @PostMapping("/v1/downloads/queue")
    public ResponseEntity<Map<String, Object>> queueDownload(@RequestBody Map<String, Object> body) {
        String titleName = String.valueOf(body.getOrDefault("titleName", "")).trim();
        String titleUrl = String.valueOf(body.getOrDefault("titleUrl", "")).trim();
        if (titleName.isBlank() || titleUrl.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "titleName and titleUrl are required."));
        }

        DownloadRequest request = new DownloadRequest(
            titleName,
            titleUrl,
            String.valueOf(body.getOrDefault("requestType", "manga")).trim(),
            String.valueOf(body.getOrDefault("requestedBy", "scriptarr")).trim(),
            String.valueOf(body.getOrDefault("providerId", "")).trim(),
            String.valueOf(body.getOrDefault("requestId", "")).trim(),
            body.get("selectedMetadata") instanceof Map<?, ?> selectedMetadata ? (Map<String, Object>) selectedMetadata : Map.of(),
            body.get("selectedDownload") instanceof Map<?, ?> selectedDownload ? (Map<String, Object>) selectedDownload : Map.of(),
            String.valueOf(body.getOrDefault("replacementTitleId", "")).trim(),
            String.valueOf(body.getOrDefault("priority", "normal")).trim()
        );
        try {
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(downloaderService.queueDownload(request));
        } catch (IllegalStateException error) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", error.getMessage()));
        }
    }

    /**
     * Queue every provider title matching the supplied DM bulk queue filters.
     *
     * @param body bulk queue request payload
     * @return bulk queue summary payload
     */
    @PostMapping("/v1/downloads/bulk-queue")
    public ResponseEntity<BulkQueueDownloadResult> bulkQueueDownloads(@RequestBody Map<String, Object> body) {
        BulkQueueDownloadResult result = downloaderService.bulkQueueDownload(
            String.valueOf(body.getOrDefault("providerId", "")).trim(),
            String.valueOf(body.getOrDefault("type", "")).trim(),
            body.get("nsfw") instanceof Boolean nsfw ? nsfw : null,
            String.valueOf(body.getOrDefault("titlePrefix", "")).trim(),
            String.valueOf(body.getOrDefault("requestedBy", "scriptarr-portal")).trim()
        );
        if (BulkQueueDownloadResult.STATUS_INVALID_REQUEST.equals(result.status())) {
            return ResponseEntity.badRequest().body(result);
        }
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(result);
    }

    /**
     * Create and optionally start a durable Raven mega downloadall run.
     *
     * @param body bulk-run request payload
     * @return durable run status payload
     */
    @PostMapping("/v1/downloads/bulk-runs")
    public ResponseEntity<Map<String, Object>> createBulkRun(@RequestBody Map<String, Object> body) {
        try {
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(bulkRunService.createRun(body));
        } catch (IllegalArgumentException error) {
            return ResponseEntity.badRequest().body(Map.of("error", error.getMessage()));
        } catch (IllegalStateException error) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", error.getMessage()));
        }
    }

    /**
     * Load a durable Raven mega downloadall run.
     *
     * @param runId durable run id
     * @return durable run status payload
     */
    @GetMapping("/v1/downloads/bulk-runs/{runId}")
    public ResponseEntity<Map<String, Object>> bulkRunStatus(@PathVariable("runId") String runId) {
        try {
            return ResponseEntity.ok(bulkRunService.status(runId));
        } catch (IllegalArgumentException error) {
            return ResponseEntity.badRequest().body(Map.of("error", error.getMessage()));
        } catch (IllegalStateException error) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", error.getMessage()));
        }
    }

    /**
     * Start a queued durable Raven mega downloadall run.
     *
     * @param runId durable run id
     * @return durable run status payload
     */
    @PostMapping("/v1/downloads/bulk-runs/{runId}/start")
    public ResponseEntity<Map<String, Object>> startBulkRun(@PathVariable("runId") String runId) {
        try {
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(bulkRunService.startRun(runId));
        } catch (IllegalArgumentException error) {
            return ResponseEntity.badRequest().body(Map.of("error", error.getMessage()));
        } catch (IllegalStateException error) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", error.getMessage()));
        }
    }

    /**
     * Resume a durable Raven mega downloadall run after a pause or restart.
     *
     * @param runId durable run id
     * @return durable run status payload
     */
    @PostMapping("/v1/downloads/bulk-runs/{runId}/resume")
    public ResponseEntity<Map<String, Object>> resumeBulkRun(@PathVariable("runId") String runId) {
        try {
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(bulkRunService.resumeRun(runId));
        } catch (IllegalArgumentException error) {
            return ResponseEntity.badRequest().body(Map.of("error", error.getMessage()));
        } catch (IllegalStateException error) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", error.getMessage()));
        }
    }

    /**
     * Continue a durable Raven mega downloadall run after a pause or restart.
     *
     * @param runId durable run id
     * @return durable run status payload
     */
    @PostMapping("/v1/downloads/bulk-runs/{runId}/continue")
    public ResponseEntity<Map<String, Object>> continueBulkRun(@PathVariable("runId") String runId) {
        return resumeBulkRun(runId);
    }

    /**
     * Cancel a durable Raven mega downloadall run.
     *
     * @param runId durable run id
     * @return durable run status payload
     */
    @PostMapping("/v1/downloads/bulk-runs/{runId}/cancel")
    public ResponseEntity<Map<String, Object>> cancelBulkRun(@PathVariable("runId") String runId) {
        try {
            return ResponseEntity.ok(bulkRunService.cancelRun(runId));
        } catch (IllegalArgumentException error) {
            return ResponseEntity.badRequest().body(Map.of("error", error.getMessage()));
        } catch (IllegalStateException error) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", error.getMessage()));
        }
    }

    /**
     * Snapshot the Raven download task list.
     *
     * @return task history
     */
    @GetMapping("/v1/downloads/tasks")
    public List<Map<String, Object>> tasks() {
        return downloaderService.snapshot();
    }

    /**
     * Cancel a queued or running Raven download task.
     *
     * @param taskId task id to cancel
     * @return updated task payload or a validation error
     */
    @PostMapping("/v1/downloads/tasks/{taskId}/cancel")
    public ResponseEntity<Map<String, Object>> cancelTask(@PathVariable("taskId") String taskId) {
        try {
            return ResponseEntity.ok(downloaderService.cancelTask(taskId));
        } catch (IllegalStateException error) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", error.getMessage()));
        }
    }

    /**
     * Retry a failed Raven download task.
     *
     * @param taskId task id to retry
     * @return updated task payload or a validation error
     */
    @PostMapping("/v1/downloads/tasks/{taskId}/retry")
    public ResponseEntity<Map<String, Object>> retryTask(@PathVariable("taskId") String taskId) {
        try {
            return ResponseEntity.ok(downloaderService.retryTask(taskId));
        } catch (IllegalStateException error) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", error.getMessage()));
        }
    }

    /**
     * Remove a failed or stale queued Raven download task and its incomplete working files.
     *
     * @param taskId task id to remove
     * @return removal summary or a validation error
     */
    @PostMapping("/v1/downloads/tasks/{taskId}/remove")
    public ResponseEntity<Map<String, Object>> removeTask(@PathVariable("taskId") String taskId) {
        try {
            return ResponseEntity.ok(downloaderService.removeTask(taskId));
        } catch (IllegalStateException error) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", error.getMessage()));
        }
    }

    /**
     * Reprioritize a queued Raven download task.
     *
     * @param taskId task id to update
     * @param body priority payload
     * @return updated task payload or a validation error
     */
    @PostMapping("/v1/downloads/tasks/{taskId}/priority")
    public ResponseEntity<Map<String, Object>> updateTaskPriority(
        @PathVariable("taskId") String taskId,
        @RequestBody Map<String, Object> body
    ) {
        try {
            return ResponseEntity.ok(downloaderService.updateTaskPriority(
                taskId,
                String.valueOf(body.getOrDefault("priority", "normal")).trim()
            ));
        } catch (IllegalStateException error) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", error.getMessage()));
        }
    }

    /**
     * Move a queued Raven download task inside its priority band.
     *
     * @param taskId task id to move
     * @param body move payload
     * @return updated task payload or a validation error
     */
    @PostMapping("/v1/downloads/tasks/{taskId}/move")
    public ResponseEntity<Map<String, Object>> moveTask(
        @PathVariable("taskId") String taskId,
        @RequestBody Map<String, Object> body
    ) {
        try {
            return ResponseEntity.ok(downloaderService.moveQueuedTask(
                taskId,
                String.valueOf(body.getOrDefault("direction", "")).trim()
            ));
        } catch (IllegalStateException error) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", error.getMessage()));
        }
    }

    /**
     * Preview the Raven-managed portion of a content reset.
     *
     * @return managed task and storage counts
     */
    @GetMapping("/v1/system/content-reset/preview")
    public Map<String, Object> previewContentReset() {
        return downloaderService.previewManagedContentReset();
    }

    /**
     * Execute the Raven-managed portion of a content reset.
     *
     * @return reset result payload
     */
    @PostMapping("/v1/system/content-reset")
    public Map<String, Object> executeContentReset() {
        return downloaderService.executeManagedContentReset();
    }

    /**
     * Describe Raven's metadata providers.
     *
     * @return metadata provider payload
     */
    @GetMapping("/v1/metadata/providers")
    public Map<String, Object> providers() {
        return Map.of("providers", metadataService.describeProviders());
    }

    /**
     * Search metadata providers for a series.
     *
     * @param name series name to search
     * @param provider optional provider filter
     * @param libraryId optional Raven library id used for type-aware filtering
     * @return aggregated metadata matches
     */
    @GetMapping("/v1/metadata/search")
    public List<Map<String, Object>> searchMetadata(
        @RequestParam("name") String name,
        @RequestParam(value = "provider", required = false) String provider,
        @RequestParam(value = "libraryId", required = false) String libraryId
    ) {
        return metadataService.search(name, provider, libraryId);
    }

    /**
     * Record a metadata identification match.
     *
     * @param body identification payload from Moon admin
     * @return confirmation payload
     */
    @PostMapping("/v1/metadata/identify")
    public Map<String, Object> identify(@RequestBody Map<String, Object> body) {
        return metadataService.identify(
            String.valueOf(body.getOrDefault("provider", "")),
            String.valueOf(body.getOrDefault("providerSeriesId", "")),
            String.valueOf(body.getOrDefault("seriesId", "")),
            String.valueOf(body.getOrDefault("libraryId", ""))
        );
    }

    /**
     * Load details for a specific provider series.
     *
     * @param provider provider id to query
     * @param providerSeriesId provider-specific series id
     * @return provider detail payload
     */
    @GetMapping("/v1/metadata/series-details")
    public Map<String, Object> seriesDetails(
        @RequestParam("provider") String provider,
        @RequestParam("providerSeriesId") String providerSeriesId
    ) {
        return metadataService.seriesDetails(provider, providerSeriesId);
    }
}
