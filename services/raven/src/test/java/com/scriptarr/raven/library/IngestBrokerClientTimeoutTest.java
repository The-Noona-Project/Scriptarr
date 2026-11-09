package com.scriptarr.raven.library;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/** Capture real public-method requests without waiting for production-length deadlines. */
class IngestBrokerClientTimeoutTest {
    /** Control JSON retains its two-minute deadline and configured transport safeguards. */
    @Test void controlRequestsKeepTwoMinuteDeadline() throws Exception {
        Fixture fixture = new Fixture();
        assertTrue(fixture.client.json("POST", "/jobs/example/heartbeat", Map.of("epoch", 1), "isolated-lease").path("ok").asBoolean());
        HttpRequest request = fixture.onlyRequest("POST", "/jobs/example/heartbeat");
        assertEquals(Duration.ofSeconds(120), request.timeout().orElseThrow());
        assertEquals("application/json", request.headers().firstValue("Content-Type").orElseThrow());
    }

    /** Artifact upload includes coordinator validation within Sage's fifteen-minute stream budget. */
    @Test void artifactUploadUsesFifteenMinuteDeadline(@TempDir Path root) throws Exception {
        Fixture fixture = new Fixture(); Path artifact = Files.write(root.resolve("artifact.zip"), new byte[]{1, 2, 3, 4});
        assertTrue(fixture.client.upload("/jobs/example/artifact", artifact, "isolated-lease").path("ok").asBoolean());
        HttpRequest request = fixture.onlyRequest("POST", "/jobs/example/artifact");
        assertEquals(Duration.ofMinutes(15), request.timeout().orElseThrow());
        assertEquals("application/zip", request.headers().firstValue("Content-Type").orElseThrow());
        assertEquals(WebpChapterEncoder.sha256(artifact), request.headers().firstValue("X-Scriptarr-Artifact-Sha256").orElseThrow());
        assertEquals(Files.size(artifact), request.bodyPublisher().orElseThrow().contentLength());
    }

    /** Assigned archive input has the same stream deadline without changing exact-size validation. */
    @Test void chapterDownloadUsesFifteenMinuteDeadline(@TempDir Path root) throws Exception {
        Fixture fixture = new Fixture(); Path target = root.resolve("assigned.cbz");
        fixture.client.download("/jobs/example/input", target, "isolated-lease", Fixture.INPUT.length);
        HttpRequest request = fixture.onlyRequest("GET", "/jobs/example/input");
        assertEquals(Duration.ofMinutes(15), request.timeout().orElseThrow());
        assertArrayEquals(Fixture.INPUT, Files.readAllBytes(target));
    }

    /** Production-configured builder and public method calls share a non-network request capture. */
    private static final class Fixture {
        private static final byte[] INPUT = new byte[]{4, 3, 2, 1};
        private final List<HttpRequest> requests = new ArrayList<>();
        private final IngestBrokerClient client;

        /** @throws Exception when mocked transport setup fails */
        @SuppressWarnings("unchecked")
        private Fixture() throws Exception {
            HttpClient transport = mock(HttpClient.class);
            doAnswer(call -> {
                HttpRequest request = call.getArgument(0); requests.add(request);
                HttpResponse<Object> response = mock(HttpResponse.class);
                when(response.statusCode()).thenReturn(200);
                when(response.body()).thenReturn(request.uri().getPath().endsWith("/input")
                    ? new ByteArrayInputStream(INPUT) : "{\"ok\":true}".getBytes(StandardCharsets.UTF_8));
                return response;
            }).when(transport).send(any(HttpRequest.class), any(HttpResponse.BodyHandler.class));
            client = new IngestBrokerClient(Map.of("SCRIPTARR_SAGE_BASE_URL", "http://127.0.0.1:1", "SCRIPTARR_SERVICE_TOKEN", "isolated-service"), builder -> {
                try (HttpClient configured = builder.build()) {
                    assertEquals(Duration.ofSeconds(10), configured.connectTimeout().orElseThrow());
                    assertEquals(HttpClient.Version.HTTP_1_1, configured.version());
                    assertEquals(HttpClient.Redirect.NEVER, configured.followRedirects());
                }
                return transport;
            });
        }

        /**
         * Assert routing and authentication on the request emitted by the public operation.
         * @param method expected HTTP method
         * @param suffix expected focused broker suffix
         * @return captured request including its production deadline
         */
        private HttpRequest onlyRequest(String method, String suffix) {
            assertEquals(1, requests.size()); HttpRequest request = requests.getFirst();
            assertEquals(method, request.method()); assertEquals("/api/internal/raven-ingest" + suffix, request.uri().getPath());
            assertEquals("Bearer isolated-service", request.headers().firstValue("Authorization").orElseThrow());
            assertEquals("isolated-lease", request.headers().firstValue("X-Scriptarr-Lease-Token").orElseThrow());
            return request;
        }
    }
}
