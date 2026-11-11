package com.scriptarr.raven.downloader;

import org.junit.jupiter.api.Test;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

/** Observation must remain complete and stable after a paused parent's accepted work changes. */
class BulkOwnedTaskObservationTest {
    /** More than local history retention, ancient queues and fresh failures remain accurately scoped. */
    @Test void fullHistoryAndQueuesRemainObservational() {
        List<Map<String, Object>> tasks = new ArrayList<>();
        for (int i = 0; i < 250; i++) tasks.add(Map.of("taskId", "done-" + i, "status", "completed", "titleId", "title-" + i));
        tasks.add(Map.of("taskId", "waiting", "status", "queued", "queuedAt", "2000-01-01T00:00:00Z"));
        tasks.add(Map.of("taskId", "pending", "status", "pending", "queuedAt", "2000-01-01T00:00:00Z"));
        tasks.add(Map.of("taskId", "failed", "status", "failed"));
        tasks.add(Map.of("taskId", "encoder", "status", "running", "stage", "waiting-for-encoder"));
        Map<String, Object> previous = Map.of("approvalAttempts", Map.of("failed", 2), "unresolvedPlanIds", List.of("source-plan"));
        var first = BulkOwnedTaskObservation.reconcile(previous, tasks, ignored -> false, "2026-11-11T00:00:00Z");
        assertEquals(250, ((List<?>) first.get("completedTaskIds")).size());
        assertEquals(List.of("failed"), first.get("failedTaskIds")); assertEquals(2, first.get("queuedTitleTaskCount"));
        assertEquals(1, first.get("runningTitleTaskCount")); assertEquals(List.of(), first.get("staleTaskIds"));
        assertEquals(previous.get("approvalAttempts"), first.get("approvalAttempts"));
        assertEquals(previous.get("unresolvedPlanIds"), first.get("unresolvedPlanIds"));
        assertEquals(first, BulkOwnedTaskObservation.reconcile(first, tasks, ignored -> false, "2026-11-11T00:01:00Z"));
        assertEquals(2, previous.size());
    }

    /** A durable completion survives pruning; missing identities remain unresolved rather than completed. */
    @Test void pruningDoesNotLoseTerminalEvidence() {
        var first = BulkOwnedTaskObservation.reconcile(Map.of("taskIds", List.of("done", "missing")),
            List.of(Map.of("taskId", "done", "status", "completed")), ignored -> false, "2026-11-11T00:00:00Z");
        var next = BulkOwnedTaskObservation.reconcile(first, List.of(), ignored -> false, "2026-11-11T00:02:00Z");
        assertEquals(List.of("done"), next.get("completedTaskIds")); assertEquals(List.of("missing"), next.get("missingTaskIds"));
    }
}
