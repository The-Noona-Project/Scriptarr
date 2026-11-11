package com.scriptarr.raven.settings;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Field;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Unit coverage for Raven's Sage broker HTTP client.
 */
class RavenSageClientTest {
    /** Status-based recovery tolerates an outage beyond three responses without replaying a different checkpoint.
     * @throws Exception when the isolated server fails
     */
    @Test void recoveryWindowRetriesTypedUnavailableResponses() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/internal/jobs/run/tasks/task", exchange -> {
            assertEquals("{\"status\":\"running\"}", new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            boolean unavailable = attempts.incrementAndGet() < 5;
            byte[] body = (unavailable ? "{\"error\":\"Temporarily unavailable\"}" : "{\"ok\":true}").getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(unavailable ? 503 : 200, body.length); exchange.getResponseBody().write(body); exchange.close();
        });
        server.start();
        try {
            var client = new RavenSageClient("http://127.0.0.1:" + server.getAddress().getPort(), "isolated",
                HttpClient.newHttpClient(), Duration.ofMillis(500), Duration.ofMillis(500), Duration.ofMillis(1), Duration.ofSeconds(2));
            assertTrue(client.putJobTask("run", "task", Map.of("status", "running")).path("ok").asBoolean());
            assertEquals(5, attempts.get());
        } finally { server.stop(0); }
    }
    /**
     * Verify transient transport timeouts are retried for durable job-task
     * writes.
     *
     * @throws Exception when the test HTTP server cannot be started
     */
    @Test
    void putJobTaskRetriesTransientTimeout() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        var executor = Executors.newCachedThreadPool();
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.setExecutor(executor);
        server.createContext("/api/internal/jobs/run-1/tasks/task-1", (exchange) -> {
            if (attempts.incrementAndGet() == 1) {
                try {
                    TimeUnit.MILLISECONDS.sleep(150);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                }
                exchange.close();
                return;
            }
            byte[] body = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            RavenSageClient client = testClient(server, Duration.ofMillis(50));

            assertTrue(client.putJobTask("run-1", "task-1", Map.of("status", "queued")).path("ok").asBoolean());
            assertTrue(attempts.get() >= 2);
            assertTrue(attempts.get() <= 3);
        } finally {
            server.stop(0);
            executor.shutdownNow();
        }
    }

    /**
     * Verify single-chapter checkpoints use the bounded broker route and retry
     * transient Sage/Vault status responses.
     *
     * @throws Exception when the test HTTP server cannot be started
     */
    @Test
    void putLibraryChapterUsesSingleChapterRouteAndRetriesTransientStatus() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        AtomicReference<String> requestBody = new AtomicReference<>("");
        var executor = Executors.newCachedThreadPool();
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.setExecutor(executor);
        server.createContext("/api/internal/vault/raven/titles/title-1/chapters/chapter-1", (exchange) -> {
            int attempt = attempts.incrementAndGet();
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            if (attempt == 1) {
                byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(503, body.length);
                exchange.getResponseBody().write(body);
                exchange.close();
                return;
            }
            byte[] body = "{\"id\":\"chapter-1\",\"ingestStatus\":\"ready\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            RavenSageClient client = testClient(server, Duration.ofMillis(500));

            assertEquals("ready", client.putLibraryChapter(
                "title-1",
                "chapter-1",
                Map.of("chapter", Map.of("id", "chapter-1", "ingestStatus", "running"))
            ).path("ingestStatus").asText());
            assertEquals(2, attempts.get());
            assertTrue(requestBody.get().contains("\"chapter\""));
        } finally {
            server.stop(0);
            executor.shutdownNow();
        }
    }

    /**
     * Verify permanent HTTP error payloads are surfaced once instead of being retried as transient failures.
     *
     * @throws Exception when the test HTTP server cannot be started
     */
    @Test
    void httpErrorsAreNotRetried() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        var executor = Executors.newCachedThreadPool();
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.setExecutor(executor);
        server.createContext("/api/internal/vault/settings/raven.download.providers", (exchange) -> {
            attempts.incrementAndGet();
            byte[] body = "{\"error\":\"broker rejected setting read\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(403, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            RavenSageClient client = testClient(server, Duration.ofMillis(500));

            IOException error = assertThrows(IOException.class, () -> client.getSetting("raven.download.providers"));
            assertTrue(error.getMessage().contains("broker rejected setting read"));
            assertEquals(1, attempts.get());
        } finally {
            server.stop(0);
            executor.shutdownNow();
        }
    }

    /**
     * Verify the production broker client pins internal Sage HTTP calls to
     * HTTP/1.1 so Java does not try HTTP/2 negotiation against Sage's plain
     * Node HTTP server.
     *
     * @throws Exception when the private transport field cannot be inspected
     */
    @Test
    void defaultClientUsesHttp11() throws Exception {
        RavenSageClient client = new RavenSageClient();
        Field field = RavenSageClient.class.getDeclaredField("httpClient");
        field.setAccessible(true);
        HttpClient httpClient = (HttpClient) field.get(client);

        assertEquals(HttpClient.Version.HTTP_1_1, httpClient.version());
    }

    private static RavenSageClient testClient(HttpServer server, Duration timeout) {
        return new RavenSageClient(
            "http://127.0.0.1:" + server.getAddress().getPort(),
            "test-token",
            HttpClient.newBuilder().connectTimeout(timeout).version(HttpClient.Version.HTTP_1_1).build(),
            timeout,
            timeout,
            Duration.ofMillis(1)
        );
    }
}
