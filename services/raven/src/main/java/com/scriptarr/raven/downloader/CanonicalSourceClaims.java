package com.scriptarr.raven.downloader;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/** Prevent distinct source editions from concurrently writing one metadata identity or canonical folder. */
final class CanonicalSourceClaims implements AutoCloseable {
    private static final Map<String, Binding> ACTIVE = new LinkedHashMap<>();
    private final List<String> keys;
    private final AtomicBoolean closed = new AtomicBoolean();
    /** @param keys exact shared storage/metadata identities */
    private CanonicalSourceClaims(List<String> keys) { this.keys = keys; }
    /** @param sourceUrl requested stable provider source @param keys storage or metadata ownership claims @return claim held until actual task exit */
    static synchronized CanonicalSourceClaims acquire(String sourceUrl, List<String> keys) {
        String source = CanonicalSourceOwnership.sourceKey(sourceUrl); List<String> unique = keys.stream().filter(key -> !key.isBlank()).distinct().toList();
        for (String key : unique) if (ACTIVE.containsKey(key) && !ACTIVE.get(key).source.equals(source)) throw new IllegalStateException("source_identity_conflict: Concurrent source editions claim the same canonical identity.");
        for (String key : unique) { Binding prior = ACTIVE.get(key); ACTIVE.put(key, new Binding(source, prior == null ? 1 : prior.count + 1)); }
        return new CanonicalSourceClaims(unique);
    }
    /** Release claims only after the writer and its cancellation cleanup exit. */
    @Override public void close() { synchronized (CanonicalSourceClaims.class) { if (!closed.compareAndSet(false, true)) return; for (String key : keys) { Binding row = ACTIVE.get(key); if (row.count == 1) ACTIVE.remove(key); else ACTIVE.put(key, new Binding(row.source, row.count - 1)); } } }
    /** One stable source and the number of its actual writers. */
    private record Binding(String source, int count) { }
}
