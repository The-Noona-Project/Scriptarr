package com.scriptarr.raven.downloader;

import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import com.scriptarr.raven.vpn.VpnService;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * Integration-style coverage for Raven's retrying download worker behavior.
 */
class DownloaderServiceRetryTest {
    @TempDir
    Path tempDir;

    private DownloaderService service;
    private HttpServer server;

    /**
     * Stop test resources after each case.
     */
    @AfterEach
    void tearDown() {
        if (service != null) {
            service.shutdown();
            service = null;
        }
        if (server != null) {
            server.stop(0);
            server = null;
        }
    }

    /**
     * Verify Raven retries chapter page lookup when a provider initially
     * returns no page URLs.
     *
     * @throws Exception when the local test server cannot be used
     */
    @Test
    void queueDownloadRetriesTransientEmptyPageLookup() throws Exception {
        server = startImageServer(new AtomicInteger(), false);
        String imageUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/images/page-1.jpg";
        AtomicInteger resolveAttempts = new AtomicInteger();

        TestContext context = createContext(new FakeDownloadProvider(
            () -> {
                if (resolveAttempts.incrementAndGet() == 1) {
                    return List.of();
                }
                return List.of(imageUrl);
            }
        ));

        service.queueDownload(new DownloadRequest(
            "Retry Series",
            "https://weebcentral.com/series/retry-series",
            "Manga",
            "tester",
            "weebcentral",
            "",
            Map.of(),
            Map.of(),
            "normal"
        ));

        Map<String, Object> task = awaitTerminalTask(service);

        assertEquals("completed", task.get("status"));
        assertEquals(2, resolveAttempts.get());
        assertEquals(1, context.libraryService().listTitles().size());
    }

    /**
     * Verify Raven retries image downloads after a transient upstream rate
     * limit and still promotes the completed title.
     *
     * @throws Exception when the local test server cannot be used
     */
    @Test
    void queueDownloadRetriesRateLimitedImageFetches() throws Exception {
        AtomicInteger imageRequests = new AtomicInteger();
        server = startImageServer(imageRequests, true);
        String imageUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/images/page-1.jpg";

        TestContext context = createContext(new FakeDownloadProvider(() -> List.of(imageUrl)));

        service.queueDownload(new DownloadRequest(
            "Rate Limit Series",
            "https://weebcentral.com/series/rate-limit-series",
            "Manga",
            "tester",
            "weebcentral",
            "",
            Map.of(),
            Map.of(),
            "normal"
        ));

        Map<String, Object> task = awaitTerminalTask(service);

        assertEquals("completed", task.get("status"));
        assertEquals(2, imageRequests.get());
        Path downloadedRoot = context.logger().getDownloadsRoot().resolve("downloaded").resolve("manga").resolve("Rate_Limit_Series");
        try (Stream<Path> files = Files.list(downloadedRoot)) {
            assertFalse(files.toList().isEmpty());
        }
    }

    /**
     * Build a DownloaderService with in-memory broker state and a temporary
     * downloads root.
     *
     * @param provider fake provider under test
     * @return assembled test context
     */
    private TestContext createContext(DownloadProvider provider) {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        brokerClient.setSetting("raven.download.providers", Map.of(
            "providers", List.of(Map.of(
                "id", "weebcentral",
                "enabled", true,
                "priority", 10
            ))
        ));
        TestLogger logger = new TestLogger(tempDir.resolve("downloads"), tempDir.resolve("logs"));
        RavenSettingsService settingsService = new RavenSettingsService(brokerClient, logger, List.of());
        DownloadProviderRegistry providerRegistry = new DownloadProviderRegistry(List.of(provider), settingsService);
        LibraryService libraryService = new LibraryService(brokerClient, settingsService, logger);
        VpnService vpnService = new VpnService(settingsService, logger);
        service = new DownloaderService(providerRegistry, vpnService, libraryService, brokerClient, settingsService, logger);
        return new TestContext(service, libraryService, logger);
    }

    /**
     * Await the first terminal task Raven records for the queued download.
     *
     * @param downloaderService service under test
     * @return terminal task snapshot
     * @throws Exception when the task never finishes
     */
    private Map<String, Object> awaitTerminalTask(DownloaderService downloaderService) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(20).toNanos();
        while (System.nanoTime() < deadline) {
            List<Map<String, Object>> tasks = downloaderService.snapshot();
            if (!tasks.isEmpty()) {
                Map<String, Object> task = tasks.getFirst();
                String status = String.valueOf(task.getOrDefault("status", ""));
                if ("completed".equals(status) || "failed".equals(status)) {
                    return task;
                }
            }
            Thread.sleep(50L);
        }
        throw new IllegalStateException("Raven task did not reach a terminal state in time.");
    }

    /**
     * Start a tiny local image server for retrying downloader tests.
     *
     * @param requestCount counter for image requests
     * @param rateLimitFirst whether the first request should return HTTP 429
     * @return started local HTTP server
     * @throws IOException when the server cannot start
     */
    private HttpServer startImageServer(AtomicInteger requestCount, boolean rateLimitFirst) throws IOException {
        HttpServer localServer = HttpServer.create(new InetSocketAddress(0), 0);
        localServer.createContext("/images/page-1.jpg", (exchange) -> {
            int attempt = requestCount.incrementAndGet();
            if (rateLimitFirst && attempt == 1) {
                respond(exchange, 429, "slow down");
                return;
            }
            exchange.getResponseHeaders().add("Content-Type", "image/jpeg");
            respond(exchange, 200, "fake-image");
        });
        localServer.start();
        return localServer;
    }

    /**
     * Send a fixed HTTP response for the lightweight local server.
     *
     * @param exchange active HTTP exchange
     * @param status response status code
     * @param body response body
     * @throws IOException when the response cannot be written
     */
    private void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status, payload.length);
        exchange.getResponseBody().write(payload);
        exchange.close();
    }

    /**
     * Shared test context for the downloader retry tests.
     *
     * @param downloaderService service under test
     * @param libraryService library projection used by the service
     * @param logger temporary filesystem logger
     */
    private record TestContext(
        DownloaderService downloaderService,
        LibraryService libraryService,
        TestLogger logger
    ) {
    }

    /**
     * Fake provider that exposes one chapter and caller-controlled page
     * resolution behavior.
     */
    private static final class FakeDownloadProvider implements DownloadProvider {
        private final PageSupplier pageSupplier;

        private FakeDownloadProvider(PageSupplier pageSupplier) {
            this.pageSupplier = pageSupplier;
        }

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
            return new BulkBrowseResult(List.of(), 0);
        }

        @Override
        public TitleDetails getTitleDetails(String titleUrl) {
            return new TitleDetails(
                "Retryable test title.",
                "Manga",
                List.of(),
                "ongoing",
                "2026",
                false,
                true,
                false,
                List.of()
            );
        }

        @Override
        public List<Map<String, String>> getChapters(String titleUrl) {
            return List.of(Map.of(
                "chapter_number", "1",
                "chapter_title", "Chapter 1",
                "href", "https://weebcentral.com/chapters/retry-demo-1"
            ));
        }

        @Override
        public List<String> resolvePages(String chapterUrl) {
            return pageSupplier.pages();
        }
    }

    /**
     * Minimal logger that keeps downloader tests inside the temporary test
     * workspace.
     */
    private static final class TestLogger extends ScriptarrLogger {
        private final Path downloadsRoot;
        private final Path logsRoot;

        private TestLogger(Path downloadsRoot, Path logsRoot) {
            this.downloadsRoot = downloadsRoot;
            this.logsRoot = logsRoot;
        }

        @Override
        public Path getDownloadsRoot() {
            return downloadsRoot;
        }

        @Override
        public Path getLogsRoot() {
            return logsRoot;
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
     * Functional interface for fake provider page resolution.
     */
    @FunctionalInterface
    private interface PageSupplier {
        List<String> pages();
    }
}
