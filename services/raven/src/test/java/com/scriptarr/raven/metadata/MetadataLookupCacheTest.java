package com.scriptarr.raven.metadata;

import org.junit.jupiter.api.Test;
import java.time.Clock;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

/** Bounded caching must not multiply provider requests or retain failures. */
class MetadataLookupCacheTest {
    /** Concurrent callers share one in-flight result. */
    @Test void coalescesConcurrentLookups() throws Exception {
        MetadataLookupCache cache = new MetadataLookupCache(Clock.systemUTC(), 2, 30_000);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        java.util.function.Supplier<Map<String, Object>> loader = () -> {
            calls.incrementAndGet(); entered.countDown();
            try { if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Fixture timed out"); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException(error); }
            return Map.of("title", "Verified title");
        };
        CompletableFuture<Map<String, Object>> first = CompletableFuture.supplyAsync(() -> cache.get("same", loader));
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        CompletableFuture<Map<String, Object>> second = CompletableFuture.supplyAsync(() -> cache.get("same", loader));
        release.countDown();
        assertEquals(first.get(5, TimeUnit.SECONDS), second.get(5, TimeUnit.SECONDS));
        assertEquals(1, calls.get());
    }

    /** Errors are retried, capacity evicts completed results, and zero retention expires immediately. */
    @Test void expiresAndDoesNotCacheFailures() {
        MetadataLookupCache cache = new MetadataLookupCache(Clock.systemUTC(), 1, 30_000);
        assertTrue(cache.get("a", () -> Map.of("error", "offline")).containsKey("error"));
        assertEquals("online", cache.get("a", () -> Map.of("title", "online")).get("title"));
        cache.get("b", () -> Map.of("title", "b"));
        assertEquals("refreshed", cache.get("a", () -> Map.of("title", "refreshed")).get("title"));
        MetadataLookupCache expired = new MetadataLookupCache(Clock.systemUTC(), 1, 0);
        expired.get("a", () -> Map.of("title", "old"));
        assertEquals("new", expired.get("a", () -> Map.of("title", "new")).get("title"));
    }
}
