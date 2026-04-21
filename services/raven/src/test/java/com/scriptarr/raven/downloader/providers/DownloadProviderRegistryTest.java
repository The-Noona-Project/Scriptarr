package com.scriptarr.raven.downloader.providers;

import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Unit coverage for Raven's settings-aware provider ordering.
 */
class DownloadProviderRegistryTest {
    @Test
    void enabledProvidersHonorConfiguredPriority() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        brokerClient.setSetting("raven.download.providers", Map.of(
            "providers", List.of(
                Map.of("id", "weebcentral", "enabled", true, "priority", 20),
                Map.of("id", "mangadex", "enabled", true, "priority", 10)
            )
        ));
        RavenSettingsService settingsService = new RavenSettingsService(brokerClient, new TestLogger(), List.of());
        DownloadProviderRegistry registry = new DownloadProviderRegistry(
            List.of(new StubDownloadProvider("weebcentral"), new StubDownloadProvider("mangadex")),
            settingsService
        );

        List<DownloadProvider> enabled = registry.enabledProviders();

        assertEquals(List.of("mangadex", "weebcentral"), enabled.stream().map(DownloadProvider::id).toList());
    }

    private static final class StubDownloadProvider implements DownloadProvider {
        private final String id;

        private StubDownloadProvider(String id) {
            this.id = id;
        }

        @Override
        public String id() {
            return id;
        }

        @Override
        public String name() {
            return id;
        }

        @Override
        public boolean supportsUrl(String titleUrl) {
            return false;
        }

        @Override
        public List<Map<String, String>> searchTitles(String query) {
            return List.of();
        }

        @Override
        public com.scriptarr.raven.downloader.TitleDetails getTitleDetails(String titleUrl) {
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
}
