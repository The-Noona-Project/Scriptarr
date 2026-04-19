package com.scriptarr.raven.api;

import com.scriptarr.raven.downloader.DownloadRequest;
import com.scriptarr.raven.downloader.DownloaderService;
import com.scriptarr.raven.library.ReaderChapterPayload;
import com.scriptarr.raven.library.ReaderManifest;
import com.scriptarr.raven.library.LibraryService;
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

@RestController
@RequestMapping
public class RavenController {
    private final MetadataService metadataService;
    private final DownloaderService downloaderService;
    private final VpnService vpnService;
    private final RavenSettingsService settingsService;
    private final LibraryService libraryService;

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

    @GetMapping("/v1/library")
    public Map<String, Object> library() {
        return Map.of("titles", libraryService.listTitles());
    }

    @GetMapping("/v1/library/{titleId}")
    public ResponseEntity<?> libraryTitle(@PathVariable("titleId") String titleId) {
        var title = libraryService.findTitle(titleId);
        if (title == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Title not found."));
        }
        return ResponseEntity.ok(title);
    }

    @GetMapping("/v1/reader/{titleId}")
    public ResponseEntity<?> readerManifest(@PathVariable("titleId") String titleId) {
        ReaderManifest payload = libraryService.readerManifest(titleId);
        if (payload == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Reader manifest not found."));
        }
        return ResponseEntity.ok(payload);
    }

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

    @GetMapping(value = "/v1/reader/{titleId}/{chapterId}/page/{pageIndex}", produces = "image/svg+xml")
    public ResponseEntity<?> readerPage(
        @PathVariable("titleId") String titleId,
        @PathVariable("chapterId") String chapterId,
        @PathVariable("pageIndex") int pageIndex
    ) {
        byte[] payload = libraryService.renderReaderPage(titleId, chapterId, pageIndex);
        if (payload == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Reader page not found."));
        }
        return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType("image/svg+xml"))
            .body(payload);
    }

    @GetMapping("/v1/downloads/search")
    public List<Map<String, String>> searchDownloads(@RequestParam("query") String query) {
        return downloaderService.searchTitles(query);
    }

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

    @GetMapping("/v1/downloads/tasks")
    public List<Map<String, Object>> tasks() {
        return downloaderService.snapshot();
    }

    @GetMapping("/v1/metadata/providers")
    public Map<String, Object> providers() {
        return Map.of("providers", metadataService.describeProviders());
    }

    @GetMapping("/v1/metadata/search")
    public List<Map<String, Object>> searchMetadata(
        @RequestParam("name") String name,
        @RequestParam(value = "provider", required = false) String provider
    ) {
        return metadataService.search(name, provider);
    }

    @PostMapping("/v1/metadata/identify")
    public Map<String, Object> identify(@RequestBody Map<String, Object> body) {
        return metadataService.identify(
            String.valueOf(body.getOrDefault("provider", "")),
            String.valueOf(body.getOrDefault("providerSeriesId", "")),
            String.valueOf(body.getOrDefault("seriesId", "")),
            String.valueOf(body.getOrDefault("libraryId", ""))
        );
    }

    @GetMapping("/v1/metadata/series-details")
    public Map<String, Object> seriesDetails(
        @RequestParam("provider") String provider,
        @RequestParam("providerSeriesId") String providerSeriesId
    ) {
        return metadataService.seriesDetails(provider, providerSeriesId);
    }
}
