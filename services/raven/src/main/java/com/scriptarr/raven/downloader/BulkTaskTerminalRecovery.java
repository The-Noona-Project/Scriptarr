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
            if (!sameSecond(text(local, "queuedAt"), text(durable, "queuedAt"))) return false;
            String started = text(durable, "startedAt");
            if (!started.isBlank() && !started.equals(text(local, "startedAt"))) return false;
            return !Instant.parse(text(durable, "updatedAt")).truncatedTo(ChronoUnit.SECONDS)
                .isAfter(Instant.parse(text(local, "updatedAt")).truncatedTo(ChronoUnit.SECONDS));
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

    private static boolean sameSecond(String left, String right) {
        return Instant.parse(left).truncatedTo(ChronoUnit.SECONDS).equals(Instant.parse(right).truncatedTo(ChronoUnit.SECONDS));
    }

    private static boolean cancelled(Map<String, Object> task) {
        return text(task, "message").toLowerCase(java.util.Locale.ROOT).startsWith("cancelled")
            || "cancelled".equals(text(task, "failureCode"));
    }

    private static String text(Map<String, Object> task, String key) {
        Object value = value(task, key);
        return value == null ? "" : String.valueOf(value);
    }

    private static Object value(Map<String, Object> task, String key) {
        Object value = task.get(key);
        return value == null && task.get("details") instanceof Map<?, ?> details ? details.get(key) : value;
    }

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
