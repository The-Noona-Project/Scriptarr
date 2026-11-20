package com.scriptarr.raven.support;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.*;

/** Capacity reads cannot release owner pauses or report an unavailable filesystem ready. */
class StorageBudgetTest {
    /** Approval and admission share one lock, so a waiter cannot recreate an already approved pressure marker.
     * @param root isolated managed filesystem
     * @throws Exception when fixture setup fails
     */
    @Test void approvalWinsBeforeWaitingAdmissionReadsState(@TempDir Path root) throws Exception {
        var status = StorageBudget.status(root);
        org.junit.jupiter.api.Assumptions.assumeTrue((long) status.get("availableBytes") >= (long) status.get("resumeBytes"));
        Files.writeString(root.resolve(".storage-pressure"), "pause");
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        Thread admission = new Thread(() -> {try {StorageBudget.require(root);} catch (Throwable error) {failure.set(error);}});
        synchronized (StorageBudget.class) {
            admission.start(); long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(2);
            while (admission.getState() != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.onSpinWait();
            assertEquals(Thread.State.BLOCKED, admission.getState());
            StorageBudget.approveResume(root);
        }
        admission.join(2000); assertFalse(admission.isAlive()); assertNull(failure.get()); assertFalse(Files.exists(root.resolve(".storage-pressure")));
    }
    /** @param root isolated managed filesystem @throws Exception when fixture setup fails */
    @Test void readsAreObservationalAndPressureRequiresApproval(@TempDir Path root) throws Exception {
        assertFalse((Boolean) StorageBudget.status(root, Long.MAX_VALUE).get("ready"));
        assertFalse(Files.exists(root.resolve(".storage-pressure")));
        Files.writeString(root.resolve(".storage-pressure"), "operator pause");
        for (int i = 0; i < 3; i++) assertFalse((Boolean) StorageBudget.status(root, 0).get("ready"));
        assertThrows(java.io.IOException.class, () -> StorageBudget.require(root));
        assertTrue(Files.exists(root.resolve(".storage-pressure")));
    }

    /** @param root isolated managed filesystem */
    @Test void missingStorageFailsClosed(@TempDir Path root) {
        assertFalse((Boolean) StorageBudget.status(root.resolve("absent"), 0).get("ready"));
    }
}
