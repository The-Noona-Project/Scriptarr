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
import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Minimal Vault HTTP client used by Raven for shared settings and secrets.
 */
@Component
public class RavenVaultClient {
    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build();
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${SCRIPTARR_VAULT_BASE_URL:http://127.0.0.1:3005}")
    private String vaultBaseUrl;

    @Value("${SCRIPTARR_SERVICE_TOKEN:raven-dev-token}")
    private String serviceToken;

    /**
     * Load a non-secret setting value from Vault.
     *
     * @param key setting key to request
     * @return parsed JSON payload from Vault
     * @throws IOException when the Vault response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    public JsonNode getSetting(String key) throws IOException, InterruptedException {
        return get("/api/service/settings/" + encode(key));
    }

    /**
     * Load a secret value from Vault.
     *
     * @param key secret key to request
     * @return parsed JSON payload from Vault
     * @throws IOException when the Vault response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    public JsonNode getSecret(String key) throws IOException, InterruptedException {
        return get("/api/service/secrets/" + encode(key));
    }

    /**
     * Load every Raven library title persisted in Vault.
     *
     * @return parsed JSON array payload
     * @throws IOException when the Vault response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    public JsonNode listLibraryTitles() throws IOException, InterruptedException {
        return get("/api/service/raven/titles");
    }

    /**
     * Load one Raven library title persisted in Vault.
     *
     * @param titleId stable title id
     * @return parsed JSON title payload
     * @throws IOException when the Vault response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    public JsonNode getLibraryTitle(String titleId) throws IOException, InterruptedException {
        return get("/api/service/raven/titles/" + encode(titleId));
    }

    /**
     * Persist a Raven library title summary into Vault.
     *
     * @param titleId stable title id
     * @param payload title payload to store
     * @return parsed JSON response
     * @throws IOException when the Vault response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    public JsonNode putLibraryTitle(String titleId, Map<String, Object> payload) throws IOException, InterruptedException {
        return put("/api/service/raven/titles/" + encode(titleId), payload);
    }

    /**
     * Replace the stored chapter list for a Raven title.
     *
     * @param titleId stable title id
     * @param payload chapter payload wrapper
     * @return parsed JSON response
     * @throws IOException when the Vault response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    public JsonNode putLibraryChapters(String titleId, Map<String, Object> payload) throws IOException, InterruptedException {
        return put("/api/service/raven/titles/" + encode(titleId) + "/chapters", payload);
    }

    /**
     * Load persisted Raven download tasks from Vault.
     *
     * @return parsed JSON array payload
     * @throws IOException when the Vault response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    public JsonNode listDownloadTasks() throws IOException, InterruptedException {
        return get("/api/service/raven/download-tasks");
    }

    /**
     * Persist a Raven download task snapshot into Vault.
     *
     * @param taskId stable task id
     * @param payload task payload to store
     * @return parsed JSON response
     * @throws IOException when the Vault response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    public JsonNode putDownloadTask(String taskId, Map<String, Object> payload) throws IOException, InterruptedException {
        return put("/api/service/raven/download-tasks/" + encode(taskId), payload);
    }

    /**
     * Load a persisted Raven metadata match.
     *
     * @param titleId stable title id
     * @return parsed JSON payload
     * @throws IOException when the Vault response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    public JsonNode getMetadataMatch(String titleId) throws IOException, InterruptedException {
        return get("/api/service/raven/metadata-matches/" + encode(titleId));
    }

    /**
     * Persist the selected Raven metadata match for a title.
     *
     * @param titleId stable title id
     * @param payload metadata payload to store
     * @return parsed JSON response
     * @throws IOException when the Vault response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    public JsonNode putMetadataMatch(String titleId, Map<String, Object> payload) throws IOException, InterruptedException {
        return put("/api/service/raven/metadata-matches/" + encode(titleId), payload);
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
        return vaultBaseUrl.endsWith("/") ? vaultBaseUrl.substring(0, vaultBaseUrl.length() - 1) : vaultBaseUrl;
    }

    private String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
