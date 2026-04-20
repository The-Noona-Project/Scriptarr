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
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Unit coverage for Raven's title scraper retry handling.
 */
class TitleScraperRetryTest {
    private HttpServer server;

    /**
     * Stop the temporary HTTP server after each test.
     */
    @AfterEach
    void tearDown() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
    }

    /**
     * Verify chapter list scraping retries after a transient upstream rate
     * limit and still returns normalized chapters.
     *
     * @throws Exception when the local test server cannot start
     */
    @Test
    void getChaptersRetriesAfterTransientRateLimit() throws Exception {
        AtomicInteger chapterListRequests = new AtomicInteger();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/series/demo/full-chapter-list", (exchange) -> {
            int attempt = chapterListRequests.incrementAndGet();
            if (attempt == 1) {
                respond(exchange, 429, "too many requests");
                return;
            }
            respond(
                exchange,
                200,
                """
                    <html><body>
                      <a href="https://weebcentral.com/chapters/one">Chapter 1</a>
                      <a href="https://weebcentral.com/chapters/two">Chapter 2</a>
                    </body></html>
                    """
            );
        });
        server.start();

        TitleScraper scraper = new TitleScraper(new TestLogger());
        String titleUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/series/demo/Example-Title";

        List<Map<String, String>> chapters = scraper.getChapters(titleUrl);

        assertEquals(2, chapters.size());
        assertEquals(2, chapterListRequests.get());
        assertEquals("1", chapters.getFirst().get("chapter_number"));
        assertEquals("https://weebcentral.com/chapters/one", chapters.getFirst().get("href"));
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
        exchange.getResponseHeaders().add("Content-Type", "text/html; charset=utf-8");
        exchange.sendResponseHeaders(status, payload.length);
        exchange.getResponseBody().write(payload);
        exchange.close();
    }

    /**
     * Minimal test logger that keeps Raven scraper tests off the real disk.
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
