package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

/** Fault injection for selected ordinary intake acceptance, including ambiguous acknowledgements. */
class BoundedTaskIntakeTest {
    /** Partial preparation leaves a non-executable durable record and rejects without accepting it. */
    @Test void partialPreparationCannotAuthorizeWork() {
        var task = task();
        assertThrows(IllegalStateException.class, () -> BoundedTaskIntake.accept(task,
            () -> { throw new IllegalStateException("Job mirror unavailable."); }, () -> { fail("Preparation was not acknowledged."); return null; }));
        assertEquals(true, task.get("intakePending"));
    }

    /** A fully acknowledged acceptance can dispatch once; a lost final response can be verified from its primary row. */
    @Test void acknowledgedAndReconciledAcceptanceMayDispatch() {
        var acknowledged = task();
        AtomicInteger writes = new AtomicInteger();
        assertTrue(BoundedTaskIntake.accept(acknowledged, writes::incrementAndGet, () -> null));
        assertEquals(2, writes.get());
        var reconciled = task(); writes.set(0);
        assertTrue(BoundedTaskIntake.accept(reconciled, () -> { if (writes.incrementAndGet() == 2) throw new IllegalStateException("Lost response."); },
            () -> new ObjectMapper().valueToTree(List.of(Map.of("taskId", "task", "details", Map.of("intakePending", false))))));
    }

    /** A rejected acceptance remains gated, while an unreadable outcome retains a durable identity without dispatch. */
    @Test void pendingAndUnknownAcceptanceDoNotDispatchLocally() {
        var pending = task(); AtomicInteger writes = new AtomicInteger();
        Runnable persist = () -> { if (writes.incrementAndGet() == 2) throw new IllegalStateException("Acceptance write failed."); };
        assertThrows(IllegalStateException.class, () -> BoundedTaskIntake.accept(pending, persist,
            () -> new ObjectMapper().valueToTree(List.of(Map.of("taskId", "task", "details", Map.of("intakePending", true))))));
        var unknown = task(); writes.set(0);
        assertFalse(BoundedTaskIntake.accept(unknown, persist, () -> { throw new IllegalStateException("Broker unavailable."); }));
        assertEquals("task", unknown.get("taskId")); assertEquals("failed", unknown.get("status"));
        assertTrue(unknown.containsKey("persistenceError"));
    }

    private Map<String, Object> task() { return new HashMap<>(Map.of("taskId", "task", "status", "queued")); }
}
