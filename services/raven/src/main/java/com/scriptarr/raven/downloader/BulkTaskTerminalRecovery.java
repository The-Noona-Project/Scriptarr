package com.scriptarr.raven.downloader;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.List;
import java.util.Objects;

/** Match a quiescent failed local execution to its unchanged durable bulk identity. */
final class BulkTaskTerminalRecovery {
    private BulkTaskTerminalRecovery() { }

    /** Retain only failed owned snapshots whose authoritative write is still outstanding. */
    static boolean pendingFailure(Map<String, Object> task) {
        return "failed".equals(text(task, "status")) && !text(task, "persistenceError").isBlank()
            && !text(task, "bulkRunId").isBlank();
    }

    /** Select complete, non-cancelled bulk identities eligible for terminal persistence repair. */
    static boolean dirtyFailure(Map<String, Object> task) {
        return pendingFailure(task) && !text(task, "bulkBatchId").isBlank()
            && !text(task, "bulkPlanId").isBlank() && !cancelled(task);
    }

    /** Reject a different owner, accepted attempt or execution before repairing a stale durable row. */
    static boolean sameExecution(Map<String, Object> local, Map<String, Object> durable) {
        if (!dirtyFailure(local) || durable == null || cancelled(durable)) return false;
        for (String key : new String[]{"taskId", "bulkRunId", "bulkBatchId", "bulkPlanId", "titleName", "titleUrl", "requestType", "providerId", "requestedBy", "requestId"}) {
            if (!text(local, key).equals(text(durable, key))) return false;
        }
        for (String key : new String[]{"selectedDownload", "selectedMetadata"}) {
            if (!equalValue(value(local, key), value(durable, key))) return false;
        }
        try {
            if (!Objects.equals(BulkRetryAttemptReceipt.from(local), BulkRetryAttemptReceipt.from(durable))) return false;
            if (!sameStoredTimestamp(text(local, "queuedAt"), text(durable, "queuedAt"))) return false;
            String started = text(durable, "startedAt");
            if (!started.isBlank() && !started.equals(text(local, "startedAt"))) return false;
            return !Instant.parse(text(durable, "updatedAt")).isAfter(Instant.parse(text(local, "updatedAt")))
                || sameStoredTimestamp(text(local, "updatedAt"), text(durable, "updatedAt"));
        } catch (RuntimeException invalid) { return false; }
    }

    /** Only an unchanged queued/running shadow can be replaced by its failed local execution. */
    static boolean writableShadow(Map<String, Object> local, Map<String, Object> durable) {
        return sameExecution(local, durable) && ("queued".equals(text(durable, "status")) || "running".equals(text(durable, "status")));
    }

    /** Retry all checkpoint writes only when an already-failed row is the same complete snapshot. */
    static boolean matchingFailure(Map<String, Object> local, Map<String, Object> durable) {
        return sameExecution(local, durable) && "failed".equals(text(durable, "status"))
            && text(local, "message").equals(text(durable, "message")) && text(local, "percent").equals(text(durable, "percent"))
            && text(local, "titleId").equals(text(durable, "titleId")) && equalValue(local.get("details"), durable.get("details"));
    }

    /** Match the submitted instant or Vault's millisecond Date value rounded/truncated by a whole-second SQL column. */
    private static boolean sameStoredTimestamp(String submitted, String persisted) {
        Instant original = Instant.parse(submitted);
        Instant stored = Instant.parse(persisted);
        Instant milliseconds = Instant.ofEpochMilli(original.toEpochMilli());
        return stored.equals(original) || stored.equals(milliseconds)
            || stored.equals(milliseconds.truncatedTo(ChronoUnit.SECONDS))
            || stored.equals(milliseconds.plusMillis(500).truncatedTo(ChronoUnit.SECONDS));
    }

    /** Cancellation evidence is not an ordinary failed execution eligible for automatic persistence repair. */
    private static boolean cancelled(Map<String, Object> task) {
        return text(task, "message").toLowerCase(java.util.Locale.ROOT).startsWith("cancelled")
            || "cancelled".equals(text(task, "failureCode"));
    }

    /** Read a scalar consistently from a live task or broker-persisted details. */
    private static String text(Map<String, Object> task, String key) {
        Object value = value(task, key);
        return value == null ? "" : String.valueOf(value);
    }

    /** Prefer explicit live values while supporting the durable nested-details representation. */
    private static Object value(Map<String, Object> task, String key) {
        Object value = task.get(key);
        return value == null && task.get("details") instanceof Map<?, ?> details ? details.get(key) : value;
    }

    /** Compare frozen JSON values without treating integral Java numeric wrapper differences as changed requests. */
    private static boolean equalValue(Object left, Object right) {
        if (left instanceof Number && right instanceof Number) {
            return new java.math.BigDecimal(left.toString()).compareTo(new java.math.BigDecimal(right.toString())) == 0;
        }
        if (left instanceof Map<?, ?> a && right instanceof Map<?, ?> b) {
            return a.keySet().equals(b.keySet()) && a.keySet().stream().allMatch(key -> equalValue(a.get(key), b.get(key)));
        }
        if (left instanceof List<?> a && right instanceof List<?> b) {
            if (a.size() != b.size()) return false;
            for (int index = 0; index < a.size(); index++) if (!equalValue(a.get(index), b.get(index))) return false;
            return true;
        }
        return Objects.equals(left, right);
    }
}
