package com.scriptarr.raven.library;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;

/** Coordinate title catalog scans and ingest without replacing a lock that still has waiting callers. */
final class LibraryTitleLocks {
    private final ConcurrentHashMap<String, Entry> entries = new ConcurrentHashMap<>();

    /**
     * Acquire one title lease, counting callers before they wait for its lock.
     * The acquiring thread must close the lease after its protected operation finishes.
     *
     * @param titleId normalized catalog title identity
     * @return a lease held by the current thread
     */
    Lease acquire(String titleId) {
        String key = titleId == null ? "" : titleId.trim();
        Entry entry = entries.compute(key, (ignored, existing) -> {
            Entry selected = existing == null ? new Entry() : existing;
            selected.references++;
            return selected;
        });
        entry.lock.lock();
        return new Lease(key, entry);
    }

    /** One reentrant lock shared by all active and waiting leases for a title. */
    private static final class Entry {
        private final ReentrantLock lock = new ReentrantLock(true);
        private int references;
    }

    /** A title lock lease that can be closed once without checked exceptions. */
    final class Lease implements AutoCloseable {
        private final String key;
        private final Entry entry;
        private final AtomicBoolean closed = new AtomicBoolean();

        private Lease(String key, Entry entry) {
            this.key = key;
            this.entry = entry;
        }

        /** Release this lease, retaining the shared lock until its last active or waiting caller leaves. */
        @Override
        public void close() {
            if (closed.get()) return;
            if (!entry.lock.isHeldByCurrentThread()) {
                throw new IllegalStateException("A title lock lease must be closed by its acquiring thread.");
            }
            if (!closed.compareAndSet(false, true)) return;
            entry.lock.unlock();
            entries.compute(key, (ignored, current) -> {
                if (current != entry) throw new IllegalStateException("The active title lock changed unexpectedly.");
                entry.references--;
                return entry.references == 0 ? null : entry;
            });
        }
    }
}
