package com.scriptarr.raven.settings;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.util.Map;

/**
 * Internal shared-state broker contract used by Raven.
 * Raven talks to Sage, and Sage owns the first-party hop to Vault.
 */
public interface RavenBrokerClient {
    /**
     * Load a non-secret setting value from the shared broker.
     *
     * @param key setting key to request
     * @return parsed JSON payload
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode getSetting(String key) throws IOException, InterruptedException;

    /**
     * Load a secret value from the shared broker.
     *
     * @param key secret key to request
     * @return parsed JSON payload
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode getSecret(String key) throws IOException, InterruptedException;

    /**
     * Load a single moderated request record persisted behind the broker.
     *
     * @param requestId stable request id
     * @return parsed JSON request payload
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode getRequest(String requestId) throws IOException, InterruptedException;

    /**
     * Persist an update to an existing moderated request record.
     *
     * @param requestId stable request id
     * @param payload request mutation payload
     * @return parsed JSON response
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode patchRequest(String requestId, Map<String, Object> payload) throws IOException, InterruptedException;

    /**
     * Load every Raven library title persisted behind the broker.
     *
     * @return parsed JSON array payload
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode listLibraryTitles() throws IOException, InterruptedException;

    /**
     * Load one Raven library title persisted behind the broker.
     *
     * @param titleId stable title id
     * @return parsed JSON title payload
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode getLibraryTitle(String titleId) throws IOException, InterruptedException;

    /**
     * Persist a Raven library title summary.
     *
     * @param titleId stable title id
     * @param payload title payload to store
     * @return parsed JSON response
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode putLibraryTitle(String titleId, Map<String, Object> payload) throws IOException, InterruptedException;

    /**
     * Replace the stored chapter list for a Raven title.
     *
     * @param titleId stable title id
     * @param payload chapter payload wrapper
     * @return parsed JSON response
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode putLibraryChapters(String titleId, Map<String, Object> payload) throws IOException, InterruptedException;

    /**
     * Load persisted Raven download tasks.
     *
     * @return parsed JSON array payload
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode listDownloadTasks() throws IOException, InterruptedException;

    /**
     * Persist a Raven download task snapshot.
     *
     * @param taskId stable task id
     * @param payload task payload to store
     * @return parsed JSON response
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode putDownloadTask(String taskId, Map<String, Object> payload) throws IOException, InterruptedException;

    /**
     * Load a persisted Raven metadata match.
     *
     * @param titleId stable title id
     * @return parsed JSON payload
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode getMetadataMatch(String titleId) throws IOException, InterruptedException;

    /**
     * Persist the selected Raven metadata match for a title.
     *
     * @param titleId stable title id
     * @param payload metadata payload to store
     * @return parsed JSON response
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode putMetadataMatch(String titleId, Map<String, Object> payload) throws IOException, InterruptedException;

    /**
     * List durable generic jobs owned by a specific service.
     *
     * @param ownerService owning service filter
     * @param kind job kind filter
     * @param status optional status filter
     * @return parsed JSON job array
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode listJobs(String ownerService, String kind, String status) throws IOException, InterruptedException;

    /**
     * Persist a durable generic job.
     *
     * @param jobId stable job id
     * @param payload job payload to store
     * @return parsed JSON response
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode putJob(String jobId, Map<String, Object> payload) throws IOException, InterruptedException;

    /**
     * List durable generic tasks for a job.
     *
     * @param jobId stable job id
     * @param status optional status filter
     * @return parsed JSON task array
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode listJobTasks(String jobId, String status) throws IOException, InterruptedException;

    /**
     * Persist a durable generic task for a job.
     *
     * @param jobId stable job id
     * @param taskId stable task id
     * @param payload task payload to store
     * @return parsed JSON response
     * @throws IOException when the response cannot be read
     * @throws InterruptedException when the request is interrupted
     */
    JsonNode putJobTask(String jobId, String taskId, Map<String, Object> payload) throws IOException, InterruptedException;
}
