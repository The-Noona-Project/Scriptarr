package com.scriptarr.raven.downloader;

import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Unit coverage for Raven's live title-download runtime settings.
 */
class DownloaderServiceRuntimeSettingsTest {
    /**
     * Verify Raven keeps today's two-title default when no setting exists.
     */
    @Test
    void defaultActiveTitleDownloadsIsTwo() {
        DownloaderService service = createService(new FakeRavenBrokerClient());
        try {
            assertEquals(2, service.stats().get("activeSlots"));
            assertEquals(2, service.stats().get("totalSlots"));
        } finally {
            service.shutdown();
        }
    }

    /**
     * Verify brokered runtime settings resize the title worker live.
     */
    @Test
    void reloadDownloadRuntimeSettingsResizesTitleSlots() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        DownloaderService service = createService(brokerClient);
        try {
            brokerClient.setSetting("raven.download.runtime", Map.of("activeTitleDownloads", 4));
            Map<String, Object> expanded = service.reloadDownloadRuntimeSettings();
            assertEquals(4, expanded.get("activeTitleDownloads"));
            assertEquals(4, service.stats().get("activeSlots"));

            brokerClient.setSetting("raven.download.runtime", Map.of("activeTitleDownloads", 1));
            Map<String, Object> reduced = service.reloadDownloadRuntimeSettings();
            assertEquals(1, reduced.get("activeTitleDownloads"));
            assertEquals(1, service.stats().get("activeSlots"));
        } finally {
            service.shutdown();
        }
    }

    /**
     * Verify startup task restore applies the saved runtime setting first.
     */
    @Test
    void restorePersistedTasksAppliesSavedRuntimeSettingFirst() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        brokerClient.setSetting("raven.download.runtime", Map.of("activeTitleDownloads", 5));
        DownloaderService service = createService(brokerClient);
        try {
            service.restorePersistedTasks();
            assertEquals(5, service.stats().get("activeSlots"));
        } finally {
            service.shutdown();
        }
    }

    private DownloaderService createService(FakeRavenBrokerClient brokerClient) {
        TestLogger logger = new TestLogger();
        RavenSettingsService settingsService = new RavenSettingsService(brokerClient, logger, java.util.List.of());
        return new DownloaderService(null, null, null, null, null, brokerClient, settingsService, logger);
    }

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
        public void warn(String tag, String message, String detail) {
        }
    }
}
