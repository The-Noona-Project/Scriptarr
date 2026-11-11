package com.scriptarr.raven.downloader;

import com.sun.net.httpserver.HttpServer;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

/** Complete title pages must prove unavailability; empty, challenged, or available sources cannot masquerade as skips. */
class ChapterDiscoveryResultTest {
    /** @throws Exception when the isolated fixture cannot start */
    @Test void sourceMarkerRequiresARealTitleAndNoChapterControls() throws Exception {
        String marker = "<p>This series is currently unavailable. Subscribe to get notified when a new chapter is released!</p>";
        String details = "<h1>The Duplicate</h1><ul><li><strong>Type:</strong><a>Manhua</a></li></ul>";
        AtomicReference<String> body = new AtomicReference<>(details + marker);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/series/example", exchange -> {
            byte[] bytes = body.get().getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, bytes.length); exchange.getResponseBody().write(bytes); exchange.close();
        });
        server.start();
        try {
            String base = "http://127.0.0.1:" + server.getAddress().getPort();
            TitleScraper scraper = new TitleScraper(mock(ScriptarrLogger.class), base);
            assertTrue(scraper.discoverChapters(base + "/series/example").unavailable());
            body.set(marker); assertFalse(scraper.discoverChapters(base + "/series/example").unavailable());
            body.set(details); assertFalse(scraper.discoverChapters(base + "/series/example").error().isBlank());
            body.set(details + marker + "<a href='/chapters/chapter-one'>Episode 1</a>");
            assertFalse(scraper.discoverChapters(base + "/series/example").unavailable());
            body.set("<h1>Checking your browser</h1>" + marker);
            assertFalse(scraper.discoverChapters(base + "/series/example").unavailable());
        } finally { server.stop(0); }
    }
}
