package com.scriptarr.raven.library;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/** Verify title scans and ingest retain one lock across active, waiting and newly arriving callers. */
class LibraryTitleLocksTest {
    /** Verify releasing the first owner cannot detach its already-waiting successor from a new caller. */
    @Test
    void waitingSuccessorAndNewCallerShareTheSameTitleLock() throws Exception {
        LibraryTitleLocks locks = new LibraryTitleLocks();
        ExecutorService workers = Executors.newFixedThreadPool(2);
        LibraryTitleLocks.Lease first = locks.acquire("title");
        CountDownLatch successorEntered = new CountDownLatch(1);
        CountDownLatch releaseSuccessor = new CountDownLatch(1);
        CountDownLatch newcomerEntered = new CountDownLatch(1);
        AtomicReference<Thread> successorThread = new AtomicReference<>();
        try {
            Future<?> successor = workers.submit(() -> {
                successorThread.set(Thread.currentThread());
                try (var lease = locks.acquire("title")) {
                    successorEntered.countDown();
                    assertTrue(releaseSuccessor.await(5, TimeUnit.SECONDS));
                }
                return null;
            });
            awaitWaiting(successorThread);
            first.close();
            assertTrue(successorEntered.await(5, TimeUnit.SECONDS));
            Future<?> newcomer = workers.submit(() -> {
                try (var lease = locks.acquire("title")) { newcomerEntered.countDown(); }
            });
            assertFalse(newcomerEntered.await(150, TimeUnit.MILLISECONDS));
            releaseSuccessor.countDown();
            successor.get(5, TimeUnit.SECONDS);
            newcomer.get(5, TimeUnit.SECONDS);
            assertEquals(0, newcomerEntered.getCount());
        } finally {
            first.close();
            releaseSuccessor.countDown();
            workers.shutdownNow();
            assertTrue(workers.awaitTermination(5, TimeUnit.SECONDS));
        }
    }

    /** Verify a long ingest for one title never blocks an unrelated title scan. */
    @Test
    void differentTitlesCanRunIndependently() throws Exception {
        LibraryTitleLocks locks = new LibraryTitleLocks();
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try (var first = locks.acquire("one")) {
            worker.submit(() -> {
                try (var second = locks.acquire("two")) { return true; }
            }).get(5, TimeUnit.SECONDS);
        } finally {
            worker.shutdownNow();
            assertTrue(worker.awaitTermination(5, TimeUnit.SECONDS));
        }
    }

    /** Verify nested same-thread operations and repeated close never release a still-active outer lease. */
    @Test
    void nestedLeasesRemainExclusiveUntilTheLastClose() throws Exception {
        LibraryTitleLocks locks = new LibraryTitleLocks();
        ExecutorService worker = Executors.newSingleThreadExecutor();
        LibraryTitleLocks.Lease outer = locks.acquire("title");
        CountDownLatch entered = new CountDownLatch(1);
        try {
            LibraryTitleLocks.Lease inner = locks.acquire("title");
            inner.close();
            inner.close();
            Future<?> other = worker.submit(() -> {
                try (var lease = locks.acquire("title")) { entered.countDown(); }
            });
            assertFalse(entered.await(150, TimeUnit.MILLISECONDS));
            outer.close();
            other.get(5, TimeUnit.SECONDS);
            assertEquals(0, entered.getCount());
        } finally {
            outer.close();
            worker.shutdownNow();
            assertTrue(worker.awaitTermination(5, TimeUnit.SECONDS));
        }
    }

    private void awaitWaiting(AtomicReference<Thread> thread) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            Thread current = thread.get();
            if (current != null && current.getState() == Thread.State.WAITING) return;
            Thread.sleep(5);
        }
        fail("The successor never waited for the held title lock.");
    }
}
