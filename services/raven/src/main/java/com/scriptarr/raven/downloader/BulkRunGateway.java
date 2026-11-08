package com.scriptarr.raven.downloader;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** Durable, cancellable boundary between bulk runs and title downloads. */
public interface BulkRunGateway {
    /**
     * Return the stable startup barrier, completed only after full successful restoration.
     *
     * @return restoration completion, pending while a recoverable broker failure is retried
     */
    CompletableFuture<Void> restoreCompletion();

    /**
     * Discover or replay a batch and persist each owned title plan before enqueueing it.
     *
     * @param runId durable parent run id
     * @param batchId durable batch id
     * @param providerId allowed download provider
     * @param type exact requested content type
     * @param nsfw whether adult content is allowed
     * @param prefix visible title prefix
     * @param actor requesting owner
     * @param cancelled live cancellation predicate
     * @param checkpoint cumulative durable discovery and queue summary callback
     * @return queue summary, never a silently truncated discovery result
     */
    BulkQueueDownloadResult queueBatch(String runId, String batchId, String providerId, String type,
        boolean nsfw, String prefix, String actor, BooleanSupplier cancelled,
        Consumer<Map<String, Object>> checkpoint);

    /**
     * Load owned task evidence without the local terminal-history retention limit.
     *
     * @param runId durable parent run id
     * @param batchId batch id, or empty for every batch in the run
     * @return durable owned task snapshots
     */
    List<Map<String, Object>> ownedTasks(String runId, String batchId);

    /**
     * Close the run's enqueue gate and cancel only its durable owned work.
     *
     * @param runId durable run id
     */
    void cancelRun(String runId);
}
