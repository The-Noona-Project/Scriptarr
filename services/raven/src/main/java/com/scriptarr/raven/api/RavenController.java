package com.scriptarr.raven.api;

import com.scriptarr.raven.downloader.DownloadRequest;
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

import java.util.List;
import java.util.Map;

/**
 * HTTP API controller for Raven library, downloader, metadata, and reader endpoints.
 */
@RestController
@RequestMapping
public class RavenController {
    private final MetadataService metadataService;
    private final DownloaderService downloaderService;
    private final VpnService vpnService;
    private final RavenSettingsService settingsService;
    private final LibraryService libraryService;

    /**
     * Create the Raven controller.
     *
     * @param metadataService metadata service
     * @param downloaderService download queue service
     * @param vpnService VPN status service
     * @param settingsService Raven settings service
     * @param libraryService library projection service
     */
    public RavenController(
        MetadataService metadataService,
        DownloaderService downloaderService,
        VpnService vpnService,
        RavenSettingsService settingsService,
        LibraryService libraryService
    ) {
        this.metadataService = metadataService;
        this.downloaderService = downloaderService;
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
            "metadataProviders", settingsService.getMetadataProviderSettings()
        );
    }

    /**
     * List the current Raven library titles.
     *
     * @return library payload
     */
    @GetMapping("/v1/library")
    public Map<String, Object> library() {
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
            String.valueOf(body.getOrDefault("requestedBy", "scriptarr")).trim()
        );
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(downloaderService.queueDownload(request));
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
     * @return aggregated metadata matches
     */
    @GetMapping("/v1/metadata/search")
    public List<Map<String, Object>> searchMetadata(
        @RequestParam("name") String name,
        @RequestParam(value = "provider", required = false) String provider
    ) {
        return metadataService.search(name, provider);
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
