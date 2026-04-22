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
     * Verify chapter list scraping carries upstream release dates through the
     * normalized chapter payload.
     *
     * @throws Exception when the local test server cannot start
     */
    @Test
    void getChaptersCapturesReleaseDateMetadata() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/series/demo/full-chapter-list", (exchange) -> respond(
            exchange,
            200,
            """
                <html><body>
                  <div class="chapter-row">
                    <a href="https://weebcentral.com/chapters/one">Chapter 1</a>
                    <time datetime="2026-04-17T20:37:44.947792Z">Apr 17</time>
                  </div>
                </body></html>
                """
        ));
        server.start();

        TitleScraper scraper = new TitleScraper(new TestLogger());
        String titleUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/series/demo/Example-Title";

        List<Map<String, String>> chapters = scraper.getChapters(titleUrl);

        assertEquals(1, chapters.size());
        assertEquals("2026-04-17T20:37:44.947792Z", chapters.getFirst().get("release_date"));
    }

    /**
     * Verify chapter discovery follows the source page's HTMX full-list link so
     * long-running series are not truncated to the visible subset.
     *
     * @throws Exception when the local test server cannot start
     */
    @Test
    void getChaptersUsesHtmxFullListRequestWhenAvailable() throws Exception {
        AtomicInteger preflightRequests = new AtomicInteger();
        AtomicInteger htmxListRequests = new AtomicInteger();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/series/demo/Example-Title", (exchange) -> {
            preflightRequests.incrementAndGet();
            respond(
                exchange,
                200,
                """
                    <html><body>
                      <button
                        hx-get="/series/demo/full-chapter-list"
                        hx-target="chapter-list"
                      >Show All Chapters</button>
                    </body></html>
                    """
            );
        });
        server.createContext("/series/demo/full-chapter-list", (exchange) -> {
            htmxListRequests.incrementAndGet();
            String hxRequest = exchange.getRequestHeaders().getFirst("HX-Request");
            String hxTarget = exchange.getRequestHeaders().getFirst("HX-Target");
            if (!"true".equalsIgnoreCase(hxRequest) || !"chapter-list".equalsIgnoreCase(hxTarget)) {
                respond(exchange, 400, "missing htmx headers");
                return;
            }
            respond(
                exchange,
                200,
                """
                    <html><body>
                      <a href="https://weebcentral.com/chapters/chapter-001">Chapter 1</a>
                      <a href="https://weebcentral.com/chapters/chapter-206">Chapter 206</a>
                      <a href="https://weebcentral.com/chapters/chapter-411">Chapter 411</a>
                    </body></html>
                    """
            );
        });
        server.start();

        TitleScraper scraper = new TitleScraper(new TestLogger());
        String titleUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/series/demo/Example-Title";

        List<Map<String, String>> chapters = scraper.getChapters(titleUrl);

        assertEquals(1, preflightRequests.get());
        assertEquals(1, htmxListRequests.get());
        assertEquals(3, chapters.size());
        assertEquals("1", chapters.getFirst().get("chapter_number"));
        assertEquals("411", chapters.getLast().get("chapter_number"));
    }

    /**
     * Verify long WeebCentral full-list responses are not truncated at the old
     * Jsoup default body-size cap, which previously clipped long series like
     * Tomb Raider King down to the later chapter range only.
     *
     * @throws Exception when the local test server cannot start
     */
    @Test
    void getChaptersHandlesLargeFullChapterListResponses() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/series/demo/Example-Title", (exchange) -> respond(
            exchange,
            200,
            """
                <html><body>
                  <button
                    hx-get="/series/demo/full-chapter-list"
                    hx-target="chapter-list"
                  >Show All Chapters</button>
                </body></html>
                """
        ));
        server.createContext("/series/demo/full-chapter-list", (exchange) -> {
            StringBuilder body = new StringBuilder("<html><body>");
            for (int chapter = 1; chapter <= 205; chapter++) {
                body
                    .append("<a href=\"https://weebcentral.com/chapters/chapter-")
                    .append(String.format("%03d", chapter))
                    .append("\">Chapter ")
                    .append(chapter)
                    .append("</a>");
            }
            body.append("<!--");
            body.append("x".repeat(2_300_000));
            body.append("-->");
            for (int chapter = 206; chapter <= 411; chapter++) {
                body
                    .append("<a href=\"https://weebcentral.com/chapters/chapter-")
                    .append(String.format("%03d", chapter))
                    .append("\">Chapter ")
                    .append(chapter)
                    .append("</a>");
            }
            body.append("</body></html>");
            respond(exchange, 200, body.toString());
        });
        server.start();

        TitleScraper scraper = new TitleScraper(new TestLogger());
        String titleUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/series/demo/Example-Title";

        List<Map<String, String>> chapters = scraper.getChapters(titleUrl);

        assertEquals(411, chapters.size());
        assertEquals("1", chapters.getFirst().get("chapter_number"));
        assertEquals("206", chapters.get(205).get("chapter_number"));
        assertEquals("411", chapters.getLast().get("chapter_number"));
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
