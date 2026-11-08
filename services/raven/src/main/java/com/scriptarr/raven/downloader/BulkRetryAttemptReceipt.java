package com.scriptarr.raven.downloader;

import java.util.Map;

/** Durable identity and execution counters for the latest accepted owned title retry. */
record BulkRetryAttemptReceipt(String attemptId, int cumulativeAttempt, int approvalGeneration, int approvalAttempt, String acceptedAt) {
    /** Validate a bounded attempt identity and its per-approval execution allowance. */
    BulkRetryAttemptReceipt {
        if (attemptId == null || attemptId.isBlank() || attemptId.length() > 200 || attemptId.chars().anyMatch(Character::isISOControl)
            || cumulativeAttempt < 2 || approvalGeneration < 0 || approvalAttempt < 1 || approvalAttempt > 3) {
            throw new BulkRetryBlockedException("Invalid bulk retry attempt identity or execution counters.");
        }
    }

    /** Read the authoritative receipt from a task snapshot or its broker-persisted details. */
    static BulkRetryAttemptReceipt from(Map<String, Object> task) {
        Object value = task.get("bulkRetryAttempt");
        if (!(value instanceof Map<?, ?>) && task.get("details") instanceof Map<?, ?> details) value = details.get("bulkRetryAttempt");
        if (!(value instanceof Map<?, ?> receipt)) return null;
        return new BulkRetryAttemptReceipt(text(receipt.get("attemptId")), integer(receipt.get("cumulativeAttempt")),
            integer(receipt.get("approvalGeneration")), integer(receipt.get("approvalAttempt")), text(receipt.get("acceptedAt")));
    }

    /** Compare request identity without treating a replay timestamp as another attempt. */
    boolean same(BulkRetryAttemptReceipt other) {
        return other != null && attemptId.equals(other.attemptId) && cumulativeAttempt == other.cumulativeAttempt
            && approvalGeneration == other.approvalGeneration && approvalAttempt == other.approvalAttempt;
    }

    /** Reject stale identities and skipped or reused ordinals before any durable acceptance. */
    void requireSuccessor(BulkRetryAttemptReceipt previous) {
        if (previous == null) return;
        boolean nextApproval = approvalGeneration > previous.approvalGeneration && approvalAttempt == 1;
        boolean sameApproval = approvalGeneration == previous.approvalGeneration && approvalAttempt == previous.approvalAttempt + 1;
        if (attemptId.equals(previous.attemptId) || cumulativeAttempt != previous.cumulativeAttempt + 1 || (!nextApproval && !sameApproval)) {
            throw new BulkRetryBlockedException("Bulk retry identity conflicts with the latest accepted attempt.");
        }
    }

    /** Persist the receipt atomically inside the authoritative queued download-task record. */
    Map<String, Object> payload() {
        return Map.of("attemptId", attemptId, "cumulativeAttempt", cumulativeAttempt, "approvalGeneration", approvalGeneration,
            "approvalAttempt", approvalAttempt, "acceptedAt", acceptedAt);
    }

    private static int integer(Object value) {
        try { return Integer.parseInt(String.valueOf(value)); }
        catch (NumberFormatException error) { throw new BulkRetryBlockedException("Invalid durable bulk retry counters."); }
    }

    private static String text(Object value) { return value == null ? "" : String.valueOf(value); }
}
