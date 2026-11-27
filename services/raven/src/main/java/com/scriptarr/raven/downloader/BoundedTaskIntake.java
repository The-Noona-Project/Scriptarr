package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;
import java.util.function.Supplier;

/** A prepared ordinary selection is durable but cannot execute until its acceptance checkpoint is acknowledged. */
final class BoundedTaskIntake {
    private BoundedTaskIntake() { }

    /**
     * Persist non-executable preparation before accepting a selection. A lost acceptance response is reconciled by
     * identity; an unreadable outcome returns its already-durable identity for explicit recovery without local dispatch.
     * @param task mutable task whose identity and selection are already frozen
     * @param persist strict checkpoint writer
     * @param read authoritative durable task reader
     * @return whether the local executor may start
     */
    static boolean accept(Map<String, Object> task, Runnable persist, Supplier<JsonNode> read) {
        task.put("intakePending", true);
        try { persist.run(); }
        catch (RuntimeException failure) { task.put("status", "failed"); task.put("message", "Download intake preparation failed."); throw failure; }
        task.put("intakePending", false);
        try { persist.run(); return true; }
        catch (RuntimeException failure) {
            JsonNode rows;
            try {
                rows = read.get();
                if (rows == null || !rows.isArray()) throw new IllegalStateException("Invalid durable intake snapshot.");
            } catch (RuntimeException unavailable) {
                task.put("status", "failed"); task.put("intakePending", true);
                task.put("message", "Download intake is durable, but acceptance could not be verified. Retry this task after service recovery.");
                task.put("persistenceError", "Intake acceptance requires reconciliation.");
                return false;
            }
            for (JsonNode row : rows) if (task.get("taskId").equals(row.path("taskId").asText())
                && row.path("details").has("intakePending") && !row.path("details").path("intakePending").asBoolean(true)) return true;
            task.put("intakePending", true);
            throw failure;
        }
    }
}
