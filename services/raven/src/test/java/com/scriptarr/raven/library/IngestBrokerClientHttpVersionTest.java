package com.scriptarr.raven.library;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/** Real wire-level broker requests cannot enter Sage's unrelated WebSocket upgrade listener. */
class IngestBrokerClientHttpVersionTest {
    /** The coordinator JSON transport sends HTTP/1.1 without h2c upgrade headers on its first request. */
    @Test void jsonRequestUsesPlainHttpOneWithoutUpgrade() throws Exception {
        try (Fixture fixture = new Fixture("{\"ok\":true}".getBytes(StandardCharsets.UTF_8))) {
            assertTrue(fixture.client().json("GET", "/jobs/example", null, null).path("ok").asBoolean());
            fixture.assertHttpOne();
        }
    }

    /** A first streamed-input request uses the same explicit protocol and completes its exact byte transfer. */
    @Test void streamedInputUsesPlainHttpOneWithoutUpgrade(@TempDir Path root) throws Exception {
        byte[] input = new byte[]{1, 2, 3, 4}; Path target = root.resolve("assigned.cbz");
        try (Fixture fixture = new Fixture(input)) {
            fixture.client().download("/jobs/example/input?workerId=worker&epoch=1", target, "isolated-lease", input.length);
            assertArrayEquals(input, Files.readAllBytes(target)); fixture.assertHttpOne();
        }
    }

    /** One fresh loopback connection per test captures the actual request protocol and headers. */
    private static final class Fixture implements AutoCloseable {
        private final HttpServer server;
        private final byte[] response;
        private final ArrayBlockingQueue<Request> requests = new ArrayBlockingQueue<>(1);

        /** @param response bounded test response @throws IOException when loopback binding fails */
        private Fixture(byte[] response) throws IOException {
            this.response = response; server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/api/internal/raven-ingest", this::handle); server.start();
        }

        /** @return fresh production client using only the isolated loopback broker */
        private IngestBrokerClient client() { return new IngestBrokerClient(Map.of("SCRIPTARR_SAGE_BASE_URL", "http://127.0.0.1:" + server.getAddress().getPort())); }

        /** @param exchange actual HTTP exchange @throws IOException when the isolated response fails */
        private void handle(HttpExchange exchange) throws IOException {
            requests.add(new Request(exchange.getProtocol(), exchange.getRequestHeaders().getFirst("Upgrade"),
                exchange.getRequestHeaders().getFirst("HTTP2-Settings"), exchange.getRequestHeaders().getOrDefault("Connection", List.of())));
            exchange.sendResponseHeaders(200, response.length); exchange.getResponseBody().write(response); exchange.close();
        }

        /** @throws InterruptedException when waiting for the captured request is interrupted */
        private void assertHttpOne() throws InterruptedException {
            Request request = requests.poll(5, TimeUnit.SECONDS); assertNotNull(request); assertEquals("HTTP/1.1", request.protocol());
            assertNull(request.upgrade(), "Sage broker requests must not request h2c upgrade."); assertNull(request.settings(), "HTTP2-Settings cannot reach the plain Sage broker.");
            assertTrue(request.connection().stream().noneMatch(value -> value.toLowerCase(java.util.Locale.ROOT).contains("upgrade")));
        }

        /** Stop only this test's loopback server. */
        @Override public void close() { server.stop(0); }
    }

    /** Header snapshot of the actual request, excluding all authentication values. */
    private record Request(String protocol, String upgrade, String settings, List<String> connection) { }
}
