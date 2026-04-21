package com.scriptarr.raven.downloader;

import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.metadata.MetadataService;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Unit coverage for Raven's Discord bulk queue flow.
 */
class DownloaderServiceBulkQueueTest {
    /**
     * Verify Raven bulk queue uses the provider browse flow and normalizes the
     * queued summary for the Portal DM command.
     */
    @Test
    void bulkQueueMatchesPrefixAndQueuesTitles() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        brokerClient.setSetting("raven.download.providers", Map.of(
            "providers", List.of(Map.of(
                "id", "weebcentral",
                "enabled", true,
                "priority", 10
            ))
        ));
        TestLogger logger = new TestLogger();
        RavenSettingsService settingsService = new RavenSettingsService(brokerClient, logger, List.of());
        DownloadProviderRegistry providerRegistry = new DownloadProviderRegistry(List.of(new FakeDownloadProvider()), settingsService);
        DownloadIntakeService downloadIntakeService = mock(DownloadIntakeService.class);
        MetadataService metadataService = mock(MetadataService.class);
        when(downloadIntakeService.resolveBulkMetadata("weebcentral", "https://weebcentral.com/series/alpha-start", "Alpha Start", "Manga"))
            .thenReturn(matchedResolution("Alpha Start", "alpha-md", "https://weebcentral.com/series/alpha-start"));
        when(downloadIntakeService.resolveBulkMetadata("weebcentral", "https://weebcentral.com/series/another-dawn", "Another Dawn", "Manga"))
            .thenReturn(matchedResolution("Another Dawn", "another-md", "https://weebcentral.com/series/another-dawn"));
        RecordingDownloaderService service = new RecordingDownloaderService(
            providerRegistry,
            downloadIntakeService,
            metadataService,
            brokerClient,
            settingsService,
            logger
        );

        BulkQueueDownloadResult result = service.bulkQueueDownload("manga", false, "a", "owner-1");

        assertEquals(BulkQueueDownloadResult.STATUS_QUEUED, result.status());
        assertEquals(2, result.matchedCount());
        assertEquals(2, result.queuedCount());
        assertEquals(List.of("Alpha Start", "Another Dawn"), result.queuedTitles());
        assertEquals("owner-1", service.requests.getFirst().requestedBy());
        assertEquals("weebcentral", service.requests.getFirst().providerId());
        assertFalse(service.requests.getFirst().selectedMetadata().isEmpty());
        assertEquals("alpha-md", service.requests.getFirst().selectedMetadata().get("providerSeriesId"));
    }

    /**
     * Verify Raven rejects incomplete bulk queue requests before browsing a
     * provider or enqueueing work.
     */
    @Test
    void bulkQueueRejectsIncompleteFilters() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        TestLogger logger = new TestLogger();
        RavenSettingsService settingsService = new RavenSettingsService(brokerClient, logger, List.of());
        DownloadProviderRegistry providerRegistry = new DownloadProviderRegistry(List.of(new FakeDownloadProvider()), settingsService);
        RecordingDownloaderService service = new RecordingDownloaderService(
            providerRegistry,
            mock(DownloadIntakeService.class),
            mock(MetadataService.class),
            brokerClient,
            settingsService,
            logger
        );

        BulkQueueDownloadResult result = service.bulkQueueDownload("", null, "", "owner-1");

        assertEquals(BulkQueueDownloadResult.STATUS_INVALID_REQUEST, result.status());
        assertEquals(0, service.requests.size());
    }

    /**
     * Verify Raven skips bulk titles that do not have one confident metadata
     * match instead of queueing metadata-less downloads.
     */
    @Test
    void bulkQueueSkipsTitlesWithoutMetadataMatches() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        brokerClient.setSetting("raven.download.providers", Map.of(
            "providers", List.of(Map.of(
                "id", "weebcentral",
                "enabled", true,
                "priority", 10
            ))
        ));
        TestLogger logger = new TestLogger();
        RavenSettingsService settingsService = new RavenSettingsService(brokerClient, logger, List.of());
        DownloadProviderRegistry providerRegistry = new DownloadProviderRegistry(List.of(new SingleTitleDownloadProvider()), settingsService);
        DownloadIntakeService downloadIntakeService = mock(DownloadIntakeService.class);
        when(downloadIntakeService.resolveBulkMetadata("weebcentral", "https://weebcentral.com/series/alpha-start", "Alpha Start", "Manga"))
            .thenReturn(new DownloadIntakeService.BulkMetadataResolution("unmatched", Map.of(), Map.of()));
        RecordingDownloaderService service = new RecordingDownloaderService(
            providerRegistry,
            downloadIntakeService,
            mock(MetadataService.class),
            brokerClient,
            settingsService,
            logger
        );

        BulkQueueDownloadResult result = service.bulkQueueDownload("manga", false, "a", "owner-1");

        assertEquals(BulkQueueDownloadResult.STATUS_PARTIAL, result.status());
        assertEquals(0, result.queuedCount());
        assertEquals(1, result.skippedNoMetadataCount());
        assertEquals(List.of("Alpha Start"), result.skippedNoMetadataTitles());
    }

    /**
     * Verify Raven reports ambiguous metadata matches separately so Portal can
     * explain why a bulk title was skipped.
     */
    @Test
    void bulkQueueSkipsAmbiguousMetadataMatches() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        brokerClient.setSetting("raven.download.providers", Map.of(
            "providers", List.of(Map.of(
                "id", "weebcentral",
                "enabled", true,
                "priority", 10
            ))
        ));
        TestLogger logger = new TestLogger();
        RavenSettingsService settingsService = new RavenSettingsService(brokerClient, logger, List.of());
        DownloadProviderRegistry providerRegistry = new DownloadProviderRegistry(List.of(new SingleTitleDownloadProvider()), settingsService);
        DownloadIntakeService downloadIntakeService = mock(DownloadIntakeService.class);
        when(downloadIntakeService.resolveBulkMetadata("weebcentral", "https://weebcentral.com/series/alpha-start", "Alpha Start", "Manga"))
            .thenReturn(new DownloadIntakeService.BulkMetadataResolution("ambiguous", Map.of(), Map.of()));
        RecordingDownloaderService service = new RecordingDownloaderService(
            providerRegistry,
            downloadIntakeService,
            mock(MetadataService.class),
            brokerClient,
            settingsService,
            logger
        );

        BulkQueueDownloadResult result = service.bulkQueueDownload("manga", false, "a", "owner-1");

        assertEquals(BulkQueueDownloadResult.STATUS_PARTIAL, result.status());
        assertEquals(0, result.queuedCount());
        assertEquals(1, result.skippedAmbiguousMetadataCount());
        assertEquals(List.of("Alpha Start"), result.skippedAmbiguousMetadataTitles());
    }

    /**
     * Lightweight logger test double that keeps Raven unit tests off the real
     * filesystem and console.
     */
    private static final class TestLogger extends ScriptarrLogger {
        @Override
        public Path getDownloadsRoot() {
            return Path.of("build/test-downloads");
        }

        @Override
        public Path getLogsRoot() {
            return Path.of("build/test-logs");
        }

        @Override
        public void info(String tag, String message) {
        }

        @Override
        public void info(String tag, String message, String detail) {
        }

        @Override
        public void warn(String tag, String message) {
        }

        @Override
        public void warn(String tag, String message, String detail) {
        }

        @Override
        public void error(String tag, String message, Throwable error) {
        }
    }

    /**
     * Fake provider that exposes a stable alphabetical browse result for the
     * DM bulk queue tests.
     */
    private static final class FakeDownloadProvider implements DownloadProvider {
        @Override
        public String id() {
            return "weebcentral";
        }

        @Override
        public String name() {
            return "WeebCentral";
        }

        @Override
        public boolean supportsUrl(String titleUrl) {
            return titleUrl != null && titleUrl.contains("weebcentral");
        }

        @Override
        public List<Map<String, String>> searchTitles(String query) {
            return List.of();
        }

        @Override
        public BulkBrowseResult browseTitlesAlphabetically(String type, boolean adultContent, String titlePrefix) {
            return new BulkBrowseResult(List.of(
                Map.of(
                    "title", "Alpha Start",
                    "href", "https://weebcentral.com/series/alpha-start",
                    "type", "Manga"
                ),
                Map.of(
                    "title", "Another Dawn",
                    "href", "https://weebcentral.com/series/another-dawn",
                    "type", "Manga"
                )
            ), 1);
        }

        @Override
        public TitleDetails getTitleDetails(String titleUrl) {
            return null;
        }

        @Override
        public List<Map<String, String>> getChapters(String titleUrl) {
            return List.of();
        }

        @Override
        public List<String> resolvePages(String chapterUrl) {
            return List.of();
        }
    }

    /**
     * Single-title browse provider used for metadata skip scenarios.
     */
    private static final class SingleTitleDownloadProvider implements DownloadProvider {
        @Override
        public String id() {
            return "weebcentral";
        }

        @Override
        public String name() {
            return "WeebCentral";
        }

        @Override
        public boolean supportsUrl(String titleUrl) {
            return titleUrl != null && titleUrl.contains("weebcentral");
        }

        @Override
        public List<Map<String, String>> searchTitles(String query) {
            return List.of();
        }

        @Override
        public BulkBrowseResult browseTitlesAlphabetically(String type, boolean adultContent, String titlePrefix) {
            return new BulkBrowseResult(List.of(Map.of(
                "title", "Alpha Start",
                "href", "https://weebcentral.com/series/alpha-start",
                "type", "Manga"
            )), 1);
        }

        @Override
        public TitleDetails getTitleDetails(String titleUrl) {
            return null;
        }

        @Override
        public List<Map<String, String>> getChapters(String titleUrl) {
            return List.of();
        }

        @Override
        public List<String> resolvePages(String chapterUrl) {
            return List.of();
        }
    }

    /**
     * Download service test double that records queue requests instead of
     * starting real Raven downloads.
     */
    private static final class RecordingDownloaderService extends DownloaderService {
        private final List<DownloadRequest> requests = new ArrayList<>();

        RecordingDownloaderService(
            DownloadProviderRegistry providerRegistry,
            DownloadIntakeService downloadIntakeService,
            MetadataService metadataService,
            FakeRavenBrokerClient brokerClient,
            RavenSettingsService settingsService,
            ScriptarrLogger logger
        ) {
            super(providerRegistry, null, null, downloadIntakeService, metadataService, brokerClient, settingsService, logger);
        }

        @Override
        public Map<String, Object> queueDownload(DownloadRequest request) {
            requests.add(request);
            return Map.of("status", "queued");
        }
    }

    private static DownloadIntakeService.BulkMetadataResolution matchedResolution(String title, String seriesId, String titleUrl) {
        return new DownloadIntakeService.BulkMetadataResolution(
            "matched",
            Map.of(
                "provider", "mangadex",
                "providerSeriesId", seriesId,
                "title", title,
                "type", "Manga",
                "details", Map.of(
                    "title", title,
                    "aliases", List.of(title),
                    "summary", title + " summary",
                    "type", "Manga"
                )
            ),
            Map.of(
                "providerId", "weebcentral",
                "providerName", "WeebCentral",
                "titleName", title,
                "titleUrl", titleUrl,
                "requestType", "Manga",
                "libraryTypeLabel", "Manga",
                "libraryTypeSlug", "manga",
                "matchScore", 120
            )
        );
    }
}
