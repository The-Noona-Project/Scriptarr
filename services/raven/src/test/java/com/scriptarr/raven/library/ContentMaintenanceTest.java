package com.scriptarr.raven.library;

import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.jupiter.api.Assertions.*;

/** Background duplicate reclamation yields to incoming writers without manufacturing failed work. */
class ContentMaintenanceTest {
    /** A waiting writer wins its scope before another background cleanup can reclaim it. */
    @Test void transientCleanupDefersWritersAndYieldsFairly() throws Exception {
        String key = "title:" + java.util.UUID.randomUUID();
        var fence = ContentMaintenance.tryQuiescent("gc_test_" + java.util.UUID.randomUUID(), List.of(key));
        assertNotNull(fence); var entered = new AtomicBoolean(); var failure = new AtomicReference<Throwable>();
        Thread writer = new Thread(() -> {try (var lease = ContentMaintenance.enter(key)) {entered.set(true);} catch (Throwable error) {failure.set(error);}});
        try {
            writer.start(); awaitWaiting(writer); assertFalse(entered.get()); assertTrue(ContentMaintenance.active(List.of(key)) > 0);
            synchronized (ContentMaintenance.class) {fence.close();assertNull(ContentMaintenance.tryQuiescent("gc_next", List.of(key)));}
            writer.join(2000);assertFalse(writer.isAlive());assertTrue(entered.get());assertNull(failure.get());
        } finally {fence.close();writer.interrupt();writer.join(2000);}
    }

    /** Owner cancellation aborts the transient wait and leaves no waiter which can starve later cleanup. */
    @Test void ownerCanCancelWaitingWriter() throws Exception {
        String key = "title:" + java.util.UUID.randomUUID();var cancelled = new AtomicBoolean();var failure = new AtomicReference<Throwable>();
        var fence = ContentMaintenance.tryQuiescent("gc_cancel", List.of(key));assertNotNull(fence);
        Thread writer = new Thread(() -> {try (var lease = ContentMaintenance.enter(cancelled::get, key)) {fail("Cancelled writer entered");} catch (Throwable error) {failure.set(error);}});
        try {writer.start();awaitWaiting(writer);cancelled.set(true);writer.join(2000);assertFalse(writer.isAlive());assertInstanceOf(java.util.concurrent.CancellationException.class, failure.get());}
        finally {fence.close();writer.interrupt();writer.join(2000);}
        try (var next = ContentMaintenance.tryQuiescent("gc_after_cancel", List.of(key))) {assertNotNull(next);}
    }

    /** @param thread waiting test writer @throws InterruptedException when the fixture is interrupted */
    private static void awaitWaiting(Thread thread) throws InterruptedException {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(2);
        while (thread.getState() != Thread.State.TIMED_WAITING && System.nanoTime() < deadline) Thread.sleep(1);
        assertEquals(Thread.State.TIMED_WAITING, thread.getState());
    }
}
