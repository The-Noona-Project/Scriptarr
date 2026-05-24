package com.scriptarr.raven.settings;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Unit coverage for Raven's Sage broker HTTP client.
 */
class RavenSageClientTest {
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
            assertEquals(2, attempts.get());
        } finally {
            server.stop(0);
            executor.shutdownNow();
        }
    }

    /**
     * Verify HTTP error payloads are surfaced once instead of being retried as
     * transient network failures.
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
            exchange.sendResponseHeaders(503, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            RavenSageClient client = testClient(server, Duration.ofMillis(50));

            IOException error = assertThrows(IOException.class, () -> client.getSetting("raven.download.providers"));
            assertTrue(error.getMessage().contains("broker rejected setting read"));
            assertEquals(1, attempts.get());
        } finally {
            server.stop(0);
            executor.shutdownNow();
        }
    }

    private static RavenSageClient testClient(HttpServer server, Duration timeout) {
        return new RavenSageClient(
            "http://127.0.0.1:" + server.getAddress().getPort(),
            "test-token",
            HttpClient.newBuilder().connectTimeout(timeout).build(),
            timeout,
            timeout,
            Duration.ofMillis(1)
        );
    }
}
