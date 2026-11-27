package com.scriptarr.raven.downloader;

import com.scriptarr.raven.support.ScriptarrLogger;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Unit coverage for Raven's chapter page source scraper retries.
 */
class SourceFinderTest {
    private HttpServer server;

    /** Page discovery passes provider cooldown headers through the same gate used for title browsing. */
    @Test void pageDiscoverySharesRetryAfterAndPacing() throws Exception {
        ProviderCooldown gate = org.mockito.Mockito.mock(ProviderCooldown.class);
        AtomicInteger requests = new AtomicInteger();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/chapters/paced/images", exchange -> {
            if (requests.incrementAndGet() == 1) {
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.getResponseHeaders().set("Retry-After", "75");
                respond(exchange, 429, "{}");
            } else respond(exchange, 200, "<img src='https://example.invalid/page.webp'>");
        });
        server.start();
        SourceFinder finder = new SourceFinder(new TestLogger()) {
            /** @param connection fixture source request @return paced fixture HTML @throws Exception on fixture failure */
            @Override org.jsoup.nodes.Document fetch(org.jsoup.Connection connection) throws Exception {
                return SourceRequests.fetch(connection, () -> false, gate);
            }
        };
        assertEquals(List.of("https://example.invalid/page.webp"), finder.scrapeWeebCentralChapter("http://127.0.0.1:" + server.getAddress().getPort() + "/chapters/paced"));
        org.mockito.Mockito.verify(gate, org.mockito.Mockito.times(2)).await(org.mockito.ArgumentMatchers.any());
        org.mockito.Mockito.verify(gate).limited(org.mockito.ArgumentMatchers.eq("75"), org.mockito.ArgumentMatchers.anyLong());
        org.mockito.Mockito.verify(gate).succeeded();
    }

    /** Cancellation while waiting on the shared gate opens no HTTP connection. */
    @Test void cancellationBeforePageDiscoveryDoesNotRequestSource() throws Exception {
        ProviderCooldown gate = org.mockito.Mockito.mock(ProviderCooldown.class);
        org.mockito.Mockito.doThrow(new java.util.concurrent.CancellationException("Cancelled.")).when(gate).await(org.mockito.ArgumentMatchers.any());
        server = HttpServer.create(new InetSocketAddress(0), 0);
        AtomicInteger requests = new AtomicInteger();
        server.createContext("/cancelled", exchange -> { requests.incrementAndGet(); respond(exchange, 200, "<img src='/page.webp'>"); });
        server.start();
        assertThrows(java.util.concurrent.CancellationException.class, () -> SourceRequests.fetch(
            org.jsoup.Jsoup.connect("http://127.0.0.1:" + server.getAddress().getPort() + "/cancelled"), () -> false, gate));
        assertEquals(0, requests.get());
    }

    /** Exhausted HTTP failures cannot masquerade as an authoritative empty chapter. */
    @Test
    void exhaustedSourceFailureRemainsRecoverable() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/chapters/demo/images", exchange -> respond(exchange, 503, "unavailable"));
        server.start();
        SourceFinder finder = new SourceFinder(new TestLogger());
        assertThrows(SourcePageLookupException.class, () -> finder.scrapeWeebCentralChapter(
            "http://127.0.0.1:" + server.getAddress().getPort() + "/chapters/demo"));
    }

    /** A challenge illustration is not a chapter page, and an empty response is unverified. */
    @Test
    void challengeAndEmptyResponsesRemainRecoverable() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/chapters/challenge/images", exchange -> respond(exchange, 200,
            "<html><head><title>Just a moment...</title></head><body><img src='/challenge.png'></body></html>"));
        server.createContext("/chapters/empty/images", exchange -> respond(exchange, 200, "<html><body></body></html>"));
        server.start();
        SourceFinder finder = new SourceFinder(new TestLogger());
        for (String name : List.of("challenge", "empty")) assertThrows(SourcePageLookupException.class,
            () -> finder.scrapeWeebCentralChapter("http://127.0.0.1:" + server.getAddress().getPort() + "/chapters/" + name));
    }

    /**
     * Stop the temporary HTTP server after each test.
     *
     * @throws Exception when shutdown fails
     */
    @AfterEach
    void tearDown() throws Exception {
        if (server != null) {
            server.stop(0);
            server = null;
        }
    }

    /**
     * Verify the WeebCentral image scrape retries after a transient rate limit.
     *
     * @throws Exception when the local test server cannot be used
     */
    @Test
    void scrapeWeebCentralChapterRetriesAfterRateLimit() throws Exception {
        AtomicInteger requestCount = new AtomicInteger();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/chapters/demo/images", (exchange) -> {
            int attempt = requestCount.incrementAndGet();
            if (attempt == 1) {
                respond(exchange, 429, "rate limited");
                return;
            }
            respond(
                exchange,
                200,
                """
                    <html><body>
                      <img src="/media/page-1.jpg">
                      <img src="/media/page-2.jpg">
                    </body></html>
                    """
            );
        });
        server.start();

        SourceFinder finder = new SourceFinder(new TestLogger());
        String chapterUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/chapters/demo";

        List<String> pages = finder.scrapeWeebCentralChapter(chapterUrl);

        assertEquals(2, pages.size());
        assertEquals(2, requestCount.get());
        assertEquals("http://127.0.0.1:" + server.getAddress().getPort() + "/media/page-1.jpg", pages.getFirst());
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
     * Minimal test logger that keeps Raven downloader tests off the real disk.
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
}
