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

    private String trimBaseUrl() {
        return vaultBaseUrl.endsWith("/") ? vaultBaseUrl.substring(0, vaultBaseUrl.length() - 1) : vaultBaseUrl;
    }

    private String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
