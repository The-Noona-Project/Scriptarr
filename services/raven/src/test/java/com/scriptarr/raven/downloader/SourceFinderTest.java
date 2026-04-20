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

/**
 * Unit coverage for Raven's chapter page source scraper retries.
 */
class SourceFinderTest {
    private HttpServer server;

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
