package com.scriptarr.raven.support;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.settings.RavenBrokerClient;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * In-memory Raven broker test double used by Raven unit tests.
 */
public final class FakeRavenBrokerClient implements RavenBrokerClient {
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final Map<String, JsonNode> settings = new LinkedHashMap<>();
    private final Map<String, JsonNode> secrets = new LinkedHashMap<>();
    private final Map<String, JsonNode> titles = new LinkedHashMap<>();
    private final Map<String, JsonNode> titleChapters = new LinkedHashMap<>();
    private final Map<String, JsonNode> downloadTasks = new LinkedHashMap<>();
    private final Map<String, JsonNode> metadataMatches = new LinkedHashMap<>();
    private final Map<String, JsonNode> jobs = new LinkedHashMap<>();
    private final Map<String, Map<String, JsonNode>> jobTasks = new LinkedHashMap<>();

    /**
     * Seed a setting value in the fake broker.
     *
     * @param key setting key
     * @param value setting value
     */
    public void setSetting(String key, Object value) {
        settings.put(key, objectMapper.valueToTree(Map.of("key", key, "value", value)));
    }

    /**
     * Seed a secret value in the fake broker.
     *
     * @param key secret key
     * @param value secret value
     */
    public void setSecret(String key, Object value) {
        secrets.put(key, objectMapper.valueToTree(Map.of("key", key, "value", value)));
    }

    /**
     * Seed a Raven title directly in the fake broker.
     *
     * @param title title payload to store
     */
    public void setLibraryTitle(LibraryTitle title) {
        titles.put(title.id(), objectMapper.valueToTree(title));
        titleChapters.put(title.id(), objectMapper.valueToTree(title.chapters()));
    }

    @Override
    public JsonNode getSetting(String key) {
        return settings.getOrDefault(key, objectMapper.valueToTree(Map.of("error", "Setting not found.")));
    }

    @Override
    public JsonNode getSecret(String key) {
        return secrets.getOrDefault(key, objectMapper.valueToTree(Map.of("error", "Secret not found.")));
    }

    @Override
    public JsonNode getRequest(String requestId) {
        return objectMapper.valueToTree(Map.of("error", "Request not found."));
    }

    @Override
    public JsonNode patchRequest(String requestId, Map<String, Object> payload) {
        return objectMapper.valueToTree(payload);
    }

    @Override
    public JsonNode listLibraryTitles() {
        List<JsonNode> payload = new ArrayList<>();
        for (String titleId : titles.keySet()) {
            payload.add(withChapters(titleId));
        }
        return objectMapper.valueToTree(payload);
    }

    @Override
    public JsonNode getLibraryTitle(String titleId) {
        if (!titles.containsKey(titleId)) {
            return objectMapper.valueToTree(Map.of("error", "Title not found."));
        }
        return withChapters(titleId);
    }

    @Override
    public JsonNode putLibraryTitle(String titleId, Map<String, Object> payload) {
        titles.put(titleId, objectMapper.valueToTree(payload));
        return withChapters(titleId);
    }

    @Override
    public JsonNode putLibraryChapters(String titleId, Map<String, Object> payload) {
        titleChapters.put(titleId, objectMapper.valueToTree(payload.getOrDefault("chapters", List.of())));
        return titleChapters.get(titleId);
    }

    @Override
    public JsonNode listDownloadTasks() {
        return objectMapper.valueToTree(downloadTasks.values());
    }

    @Override
    public JsonNode putDownloadTask(String taskId, Map<String, Object> payload) {
        downloadTasks.put(taskId, objectMapper.valueToTree(payload));
        return downloadTasks.get(taskId);
    }

    @Override
    public JsonNode getMetadataMatch(String titleId) {
        return metadataMatches.getOrDefault(titleId, objectMapper.valueToTree(Map.of("error", "Metadata match not found.")));
    }

    @Override
    public JsonNode putMetadataMatch(String titleId, Map<String, Object> payload) {
        metadataMatches.put(titleId, objectMapper.valueToTree(payload));
        return metadataMatches.get(titleId);
    }

    @Override
    public JsonNode listJobs(String ownerService, String kind, String status) {
        return objectMapper.valueToTree(jobs.values().stream().filter((job) -> {
            String jobOwner = job.path("ownerService").asText("");
            String jobKind = job.path("kind").asText("");
            String jobStatus = job.path("status").asText("");
            return (ownerService == null || ownerService.isBlank() || ownerService.equals(jobOwner))
                && (kind == null || kind.isBlank() || kind.equals(jobKind))
                && (status == null || status.isBlank() || status.equals(jobStatus));
        }).toList());
    }

    @Override
    public JsonNode putJob(String jobId, Map<String, Object> payload) {
        jobs.put(jobId, objectMapper.valueToTree(payload));
        return jobs.get(jobId);
    }

    @Override
    public JsonNode listJobTasks(String jobId, String status) {
        Map<String, JsonNode> tasks = jobTasks.getOrDefault(jobId, Map.of());
        return objectMapper.valueToTree(tasks.values().stream().filter((task) ->
            status == null || status.isBlank() || status.equals(task.path("status").asText(""))
        ).toList());
    }

    @Override
    public JsonNode putJobTask(String jobId, String taskId, Map<String, Object> payload) {
        jobTasks.computeIfAbsent(jobId, (ignored) -> new LinkedHashMap<>()).put(taskId, objectMapper.valueToTree(payload));
        return jobTasks.get(jobId).get(taskId);
    }

    private JsonNode withChapters(String titleId) {
        Map<String, Object> payload = objectMapper.convertValue(titles.get(titleId), Map.class);
        payload.put("chapters", objectMapper.convertValue(titleChapters.getOrDefault(titleId, objectMapper.valueToTree(List.of())), List.class));
        return objectMapper.valueToTree(payload);
    }
}
