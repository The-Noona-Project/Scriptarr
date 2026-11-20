package com.scriptarr.raven.downloader;

import com.sun.net.httpserver.HttpServer;
import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.jsoup.Connection;
import org.jsoup.Jsoup;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Real JSON throttling and deterministic response ownership checks. */
class SourceHtmlResponseTest {
    /** @throws Exception on fixture HTTP failure */
    @Test void jsonThrottlingIsHandledBeforeMimeAndSuccessfulJsonRemainsRejected() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/limited", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.getResponseHeaders().set("Retry-After", "123");
            exchange.sendResponseHeaders(429, 2);
            try (var output = exchange.getResponseBody()) { output.write("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
        });
        server.createContext("/json", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, 2);
            try (var output = exchange.getResponseBody()) { output.write("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
        });
        server.start();
        try {
            String base = "http://127.0.0.1:" + server.getAddress().getPort();
            AtomicReference<String> retry = new AtomicReference<>();
            var error = assertThrows(org.jsoup.HttpStatusException.class, () -> SourceHtmlResponse.fetch(Jsoup.connect(base + "/limited"), () -> false, retry::set));
            assertEquals(429, error.getStatusCode()); assertEquals("123", retry.get());
            assertThrows(org.jsoup.UnsupportedMimeTypeException.class, () -> SourceHtmlResponse.fetch(Jsoup.connect(base + "/json"), () -> false, retry::set));
        } finally { server.stop(0); }
    }

    /** @throws Exception on fixture setup failure */
    @Test void errorAndCancellationCloseWithoutReadingBody() throws Exception {
        for (boolean cancel : new boolean[]{false, true}) {
            Connection connection = mock(Connection.class, RETURNS_SELF);
            Connection.Response response = mock(Connection.Response.class);
            AtomicBoolean closed = new AtomicBoolean();
            BufferedInputStream body = new BufferedInputStream(new ByteArrayInputStream(new byte[0])) {
                /** Close the fixture without reading rejected bytes. */
                @Override public void close() { closed.set(true); }
                /** @return never returns rejected response bytes */
                @Override public synchronized int read() { fail("Rejected body must not be read"); return -1; }
            };
            when(connection.execute()).thenReturn(response); when(response.bodyStream()).thenReturn(body);
            when(response.statusCode()).thenReturn(429); when(response.url()).thenReturn(URI.create("http://127.0.0.1/source").toURL());
            if (cancel) assertThrows(CancellationException.class, () -> SourceHtmlResponse.fetch(connection, () -> true, ignored -> {}));
            else assertThrows(org.jsoup.HttpStatusException.class, () -> SourceHtmlResponse.fetch(connection, () -> false, ignored -> {}));
            assertTrue(closed.get());
        }
    }
}
