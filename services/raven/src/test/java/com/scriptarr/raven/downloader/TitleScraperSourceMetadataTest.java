package com.scriptarr.raven.downloader;

import com.scriptarr.raven.support.ScriptarrLogger;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

/** Verify responsive headings and linked source metadata using the real HTML scraper. */
class TitleScraperSourceMetadataTest {
    /**
     * Read one source heading and retain linked creators/tags without unrelated navigation values.
     * @throws Exception when the isolated source server cannot start
     */
    @Test void readsResponsiveHeadingAndLinkedFacts() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        String html = """
            <html><body><h1 class="md:hidden">The King's Avatar (Reboot)</h1>
            <h1 class="hidden md:block">The King's Avatar (Reboot)</h1>
            <ul><li><strong>Author(s):</strong><span><a href="/search?author=one">Chang Pan Yongzhe</a>,</span>
            <span><a href="/search?author=two">Hudie Lan</a></span></li>
            <li><strong>Tags(s):</strong><span><a href="/search?included_tag=Action">Action</a>,</span>
            <span><a href="/search?included_tag=Adventure">Adventure</a></span></li>
            <li><strong>Type:</strong><a href="/search?type=Manhua">Manhua</a></li>
            <li><strong>Adult Content:</strong><a href="/search?adult=False">No</a></li></ul>
            <section><strong>Associated Name(s):</strong><ul><li>The King's Avatar (2020)</li></ul></section>
            <a href="/unrelated">Unrelated navigation</a></body></html>
            """;
        server.createContext("/series/title", exchange -> {
            byte[] bytes = html.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes); exchange.close();
        });
        server.start();
        try {
            TitleDetails details = new TitleScraper(mock(ScriptarrLogger.class)).getTitleDetails("http://127.0.0.1:" + server.getAddress().getPort() + "/series/title");
            assertNotNull(details);
            assertEquals("The King's Avatar (Reboot)", details.sourceTitle());
            assertEquals(List.of("Chang Pan Yongzhe", "Hudie Lan"), details.authors());
            assertEquals(List.of("Action", "Adventure"), details.tags());
            assertEquals(List.of("The King's Avatar (2020)"), details.associatedNames());
            assertEquals("Manhua", details.type());
            assertEquals(false, details.adultContent());
        } finally { server.stop(0); }
    }
}
