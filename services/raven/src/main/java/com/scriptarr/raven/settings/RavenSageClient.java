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

/**
 * Minimal Sage HTTP client used by Raven for shared settings and durable state.
 * Sage is Raven's only first-party internal broker.
 */
@Component
public class RavenSageClient implements RavenBrokerClient {
    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build();
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${SCRIPTARR_SAGE_BASE_URL:http://127.0.0.1:3004}")
    private String sageBaseUrl;

    @Value("${SCRIPTARR_SERVICE_TOKEN:raven-dev-token}")
    private String serviceToken;

    @Override
    public JsonNode getSetting(String key) throws IOException, InterruptedException {
        return get("/api/internal/vault/settings/" + encode(key));
    }

    @Override
    public JsonNode getSecret(String key) throws IOException, InterruptedException {
        return get("/api/internal/vault/secrets/" + encode(key));
    }

    @Override
    public JsonNode listLibraryTitles() throws IOException, InterruptedException {
        return get("/api/internal/vault/raven/titles");
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
    public JsonNode listDownloadTasks() throws IOException, InterruptedException {
        return get("/api/internal/vault/raven/download-tasks");
    }

    @Override
    public JsonNode putDownloadTask(String taskId, Map<String, Object> payload) throws IOException, InterruptedException {
        return put("/api/internal/vault/raven/download-tasks/" + encode(taskId), payload);
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
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(trimBaseUrl() + path))
            .timeout(Duration.ofSeconds(5))
            .header("Authorization", "Bearer " + serviceToken)
            .header("Content-Type", "application/json")
            .GET()
            .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.body() == null || response.body().isBlank()) {
            return objectMapper.createObjectNode();
        }
        return objectMapper.readTree(response.body());
    }

    private JsonNode put(String path, Map<String, Object> payload) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(trimBaseUrl() + path))
            .timeout(Duration.ofSeconds(10))
            .header("Authorization", "Bearer " + serviceToken)
            .header("Content-Type", "application/json")
            .PUT(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(payload)))
            .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.body() == null || response.body().isBlank()) {
            return objectMapper.createObjectNode();
        }
        return objectMapper.readTree(response.body());
    }

    private String trimBaseUrl() {
        return sageBaseUrl.endsWith("/") ? sageBaseUrl.substring(0, sageBaseUrl.length() - 1) : sageBaseUrl;
    }

    private String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
