package com.scriptarr.raven.settings;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.StringJoiner;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Minimal Sage HTTP client used by Raven for shared settings and durable state.
 * Sage is Raven's only first-party internal broker.
 */
@Component
public class RavenSageClient implements RavenBrokerClient {
    private static final int MAX_ATTEMPTS = 3;
    private final HttpClient httpClient;
    private final Duration getTimeout;
    private final Duration putTimeout;
    private final Duration retryDelay;
    private final Duration recoveryWindow;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${SCRIPTARR_SAGE_BASE_URL:http://127.0.0.1:3004}")
    private String sageBaseUrl;

    @Value("${SCRIPTARR_SERVICE_TOKEN:raven-dev-token}")
    private String serviceToken;

    /**
     * Create the default Raven-to-Sage broker client.
     */
    public RavenSageClient() {
        this(
            "http://127.0.0.1:3004",
            "raven-dev-token",
            HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(8))
                .version(HttpClient.Version.HTTP_1_1)
                .build(),
            Duration.ofSeconds(12),
            Duration.ofSeconds(20),
            Duration.ofSeconds(1), Duration.ofSeconds(120)
        );
    }

    /**
     * Create a Raven-to-Sage broker client with testable transport settings.
     *
     * @param sageBaseUrl Sage base URL
     * @param serviceToken first-party service token
     * @param httpClient HTTP transport
     * @param getTimeout GET request timeout
     * @param putTimeout mutation request timeout
     * @param retryDelay base retry delay for transient IO failures
     */
    RavenSageClient(
        String sageBaseUrl,
        String serviceToken,
        HttpClient httpClient,
        Duration getTimeout,
        Duration putTimeout,
        Duration retryDelay
    ) {
        this(sageBaseUrl, serviceToken, httpClient, getTimeout, putTimeout, retryDelay, Duration.ZERO);
    }

    /**
     * Create an explicitly bounded broker recovery transport.
     * @param sageBaseUrl configured broker origin @param serviceToken existing identity @param httpClient HTTP transport
     * @param getTimeout read timeout @param putTimeout checkpoint timeout @param retryDelay initial retry delay
     * @param recoveryWindow total recovery window for idempotent reads and checkpoint PUTs, or zero for three attempts
     */
    RavenSageClient(String sageBaseUrl, String serviceToken, HttpClient httpClient, Duration getTimeout,
                    Duration putTimeout, Duration retryDelay, Duration recoveryWindow) {
        this.sageBaseUrl = sageBaseUrl;
        this.serviceToken = serviceToken;
        this.httpClient = httpClient;
        this.getTimeout = getTimeout;
        this.putTimeout = putTimeout;
        this.retryDelay = retryDelay;
        this.recoveryWindow = recoveryWindow;
    }

    @Override
    public JsonNode getSetting(String key) throws IOException, InterruptedException {
        return get("/api/internal/vault/settings/" + encode(key));
    }

    @Override
    public JsonNode getSecret(String key) throws IOException, InterruptedException {
        return get("/api/internal/vault/secrets/" + encode(key));
    }

    @Override
    public JsonNode getRequest(String requestId) throws IOException, InterruptedException {
        return get("/api/internal/vault/requests/" + encode(requestId));
    }

    @Override
    public JsonNode patchRequest(String requestId, Map<String, Object> payload) throws IOException, InterruptedException {
        return patch("/api/internal/vault/requests/" + encode(requestId), payload);
    }

    @Override
    public JsonNode listLibraryTitles() throws IOException, InterruptedException {
        return get("/api/internal/vault/raven/titles");
    }

    @Override
    public JsonNode listLibraryTitleCards(Map<String, String> query) throws IOException, InterruptedException {
        StringJoiner params = new StringJoiner("&");
        for (Map.Entry<String, String> entry : query.entrySet()) {
            if (entry.getValue() != null && !entry.getValue().isBlank()) {
                params.add(encode(entry.getKey()) + "=" + encode(entry.getValue()));
            }
        }
        return get("/api/internal/vault/raven/title-cards" + (params.length() > 0 ? "?" + params : ""));
    }

    @Override
    public JsonNode getLibraryTitle(String titleId) throws IOException, InterruptedException {
        return get("/api/internal/vault/raven/titles/" + encode(titleId));
    }

    @Override
    public JsonNode putLibraryTitle(String titleId, Map<String, Object> payload) throws IOException, InterruptedException {
        return put("/api/internal/vault/raven/titles/" + encode(titleId), payload);
    }

    @Override
    public JsonNode putLibraryChapters(String titleId, Map<String, Object> payload) throws IOException, InterruptedException {
        return put("/api/internal/vault/raven/titles/" + encode(titleId) + "/chapters", payload);
    }

    @Override
    public JsonNode putLibraryChapter(String titleId, String chapterId, Map<String, Object> payload) throws IOException, InterruptedException {
        return put("/api/internal/vault/raven/titles/" + encode(titleId) + "/chapters/" + encode(chapterId), payload);
    }

    @Override
    public JsonNode listDownloadTasks() throws IOException, InterruptedException {
        return get("/api/internal/vault/raven/download-tasks");
    }

    @Override
    public JsonNode putDownloadTask(String taskId, Map<String, Object> payload) throws IOException, InterruptedException {
        return put("/api/internal/vault/raven/download-tasks/" + encode(taskId), payload);
    }

    @Override
    public JsonNode deleteDownloadTask(String taskId) throws IOException, InterruptedException {
        return delete("/api/internal/vault/raven/download-tasks/" + encode(taskId));
    }

    @Override
    public JsonNode getMetadataMatch(String titleId) throws IOException, InterruptedException {
        return get("/api/internal/vault/raven/metadata-matches/" + encode(titleId));
    }

    @Override
    public JsonNode putMetadataMatch(String titleId, Map<String, Object> payload) throws IOException, InterruptedException {
        return put("/api/internal/vault/raven/metadata-matches/" + encode(titleId), payload);
    }

    @Override
    public JsonNode listJobs(String ownerService, String kind, String status) throws IOException, InterruptedException {
        StringJoiner query = new StringJoiner("&");
        if (ownerService != null && !ownerService.isBlank()) {
          query.add("ownerService=" + encode(ownerService));
        }
        if (kind != null && !kind.isBlank()) {
          query.add("kind=" + encode(kind));
        }
        if (status != null && !status.isBlank()) {
          query.add("status=" + encode(status));
        }
        String suffix = query.length() > 0 ? "?" + query : "";
        return get("/api/internal/jobs" + suffix);
    }

    @Override
    public JsonNode putJob(String jobId, Map<String, Object> payload) throws IOException, InterruptedException {
        return put("/api/internal/jobs/" + encode(jobId), payload);
    }

    @Override
    public JsonNode listJobTasks(String jobId, String status) throws IOException, InterruptedException {
        String suffix = status != null && !status.isBlank() ? "?status=" + encode(status) : "";
        return get("/api/internal/jobs/" + encode(jobId) + "/tasks" + suffix);
    }

    @Override
    public JsonNode putJobTask(String jobId, String taskId, Map<String, Object> payload) throws IOException, InterruptedException {
        return put("/api/internal/jobs/" + encode(jobId) + "/tasks/" + encode(taskId), payload);
    }

    private JsonNode get(String path) throws IOException, InterruptedException {
        Duration timeout = getTimeout;
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(trimBaseUrl() + path))
            .timeout(timeout)
            .header("Authorization", "Bearer " + serviceToken)
            .header("Content-Type", "application/json")
            .GET()
            .build();
        return sendParsed(path, request, timeout);
    }

    private JsonNode put(String path, Map<String, Object> payload) throws IOException, InterruptedException {
        Duration timeout = putTimeout;
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(trimBaseUrl() + path))
            .timeout(timeout)
            .header("Authorization", "Bearer " + serviceToken)
            .header("Content-Type", "application/json")
            .PUT(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(payload)))
            .build();
        return sendParsed(path, request, timeout);
    }

    private JsonNode patch(String path, Map<String, Object> payload) throws IOException, InterruptedException {
        Duration timeout = putTimeout;
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(trimBaseUrl() + path))
            .timeout(timeout)
            .header("Authorization", "Bearer " + serviceToken)
            .header("Content-Type", "application/json")
            .method("PATCH", HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(payload)))
            .build();
        return sendParsed(path, request, timeout);
    }

    private JsonNode delete(String path) throws IOException, InterruptedException {
        Duration timeout = putTimeout;
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(trimBaseUrl() + path))
            .timeout(timeout)
            .header("Authorization", "Bearer " + serviceToken)
            .header("Content-Type", "application/json")
            .DELETE()
            .build();
        return sendParsed(path, request, timeout);
    }

    private JsonNode sendParsed(String path, HttpRequest request, Duration timeout) throws IOException, InterruptedException {
        IOException lastError = null;
        boolean recover = !recoveryWindow.isZero() && ("GET".equals(request.method()) || "PUT".equals(request.method()));
        long deadline = System.nanoTime() + recoveryWindow.toNanos();
        for (int attempt = 1; recover || attempt <= MAX_ATTEMPTS; attempt += 1) {
            try {
                long remaining = deadline - System.nanoTime();
                if (recover && remaining <= 0) break;
                Duration bounded = recover && remaining < timeout.toNanos() ? Duration.ofNanos(remaining) : timeout;
                return parseResponse(path, sendOnce(path, request, bounded));
            } catch (IOException error) {
                lastError = error;
                if ((!recover && attempt >= MAX_ATTEMPTS) || !isRetryableBrokerError(error)) {
                    throw error;
                }
                long delay = recover ? Math.min(10000, Math.max(1, retryDelay.toMillis()) * (1L << Math.min(10, attempt - 1)))
                    : Math.max(1, retryDelay.toMillis()) * attempt;
                if (recover) delay = Math.min(delay, Math.max(0, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())));
                TimeUnit.MILLISECONDS.sleep(delay);
            }
        }
        throw lastError == null ? new IOException("Sage request failed for " + path + ".") : lastError;
    }

    private HttpResponse<String> send(String path, HttpRequest request, Duration timeout) throws IOException, InterruptedException {
        IOException lastError = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            try {
                return sendOnce(path, request, timeout);
            } catch (IOException error) {
                lastError = error;
                if (attempt >= MAX_ATTEMPTS) {
                    throw error;
                }
                TimeUnit.MILLISECONDS.sleep(Math.max(1, retryDelay.toMillis()) * attempt);
            }
        }
        throw lastError == null ? new IOException("Sage request failed for " + path + ".") : lastError;
    }

    private HttpResponse<String> sendOnce(String path, HttpRequest request, Duration timeout) throws IOException, InterruptedException {
        var future = httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString());
        try {
            return future.get(timeout.plusSeconds(1).toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException error) {
            future.cancel(true);
            throw new IOException("Sage request timed out for " + path + ".", error);
        } catch (InterruptedException error) {
            future.cancel(true);
            Thread.currentThread().interrupt();
            throw error;
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof IOException ioException) {
                throw ioException;
            }
            if (cause instanceof InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw interrupted;
            }
            throw new IOException("Sage request failed for " + path + ".", cause);
        }
    }

    private JsonNode parseResponse(String path, HttpResponse<String> response) throws IOException {
        if (response.body() == null || response.body().isBlank()) {
            if (response.statusCode() >= 400) {
                throw new BrokerRequestException(response.statusCode(), "Sage returned " + response.statusCode() + " for " + path + ".");
            }
            return objectMapper.createObjectNode();
        }
        JsonNode payload = objectMapper.readTree(response.body());
        if (response.statusCode() >= 400) {
            String message = payload.path("error").asText().trim();
            if (message.isBlank()) {
                message = "Sage returned " + response.statusCode() + " for " + path + ".";
            }
            throw new BrokerRequestException(response.statusCode(), message);
        }
        return payload;
    }

    private boolean isRetryableBrokerError(IOException error) {
        if (error instanceof BrokerRequestException rejected) return rejected.transientFailure();
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof java.net.ConnectException || cause instanceof java.net.SocketException
                || cause instanceof java.net.http.HttpTimeoutException || cause instanceof java.io.EOFException) return true;
        }
        String message = error.getMessage() == null ? "" : error.getMessage().toLowerCase();
        return message.contains("timed out")
            || message.contains("timeout")
            || message.contains("fetch failed")
            || message.contains("connection reset")
            || message.contains("connection refused")
            || message.contains("returned 500")
            || message.contains("returned 502")
            || message.contains("returned 503")
            || message.contains("returned 504");
    }

    private String trimBaseUrl() {
        return sageBaseUrl.endsWith("/") ? sageBaseUrl.substring(0, sageBaseUrl.length() - 1) : sageBaseUrl;
    }

    private String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
