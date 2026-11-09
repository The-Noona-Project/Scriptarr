package com.scriptarr.raven.metadata;

import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/** Bounded metadata snapshots with concurrent lookup coalescing and no cached failures. */
final class MetadataLookupCache {
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final Clock clock;
    private final int capacity;
    private final long ttl;

    /** Supply bounded retention and a deterministic clock for cache tests. */
    MetadataLookupCache(Clock clock, int capacity, long ttl) { this.clock = clock; this.capacity = capacity; this.ttl = ttl; }

    /** Share one lookup per key, retaining successful snapshots only. */
    Map<String, Object> get(String key, Supplier<Map<String, Object>> loader) {
        Entry entry;
        boolean owner = false;
        synchronized (entries) {
            entries.entrySet().removeIf(row -> row.getValue().future.isDone() && clock.millis() - row.getValue().created >= ttl);
            entry = entries.get(key);
            if (entry == null) {
                if (entries.size() >= capacity) {
                    var removable = entries.entrySet().stream().filter(row -> row.getValue().future.isDone()).findFirst();
                    if (removable.isEmpty()) throw new IllegalStateException("Metadata lookup capacity is busy; retry later.");
                    entries.remove(removable.get().getKey());
                }
                entry = new Entry(clock.millis()); entries.put(key, entry); owner = true;
            }
        }
        if (owner) {
            try {
                Map<String, Object> value = Map.copyOf(loader.get());
                if (value.containsKey("error")) synchronized (entries) { entries.remove(key, entry); }
                entry.future.complete(value);
            } catch (Throwable failure) {
                synchronized (entries) { entries.remove(key, entry); }
                entry.future.completeExceptionally(failure);
            }
        }
        return entry.future.join();
    }

    /** One shared request or retained successful result. */
    private static final class Entry {
        private final long created;
        private final CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        private Entry(long created) { this.created = created; }
    }
}
