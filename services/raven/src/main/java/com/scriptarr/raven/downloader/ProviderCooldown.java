package com.scriptarr.raven.downloader;

import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;

/** Shared source HTML pacing and Retry-After cooldown; waiting never holds a provider request open. */
final class ProviderCooldown {
    private long nextRequest, blockedUntil;
    private int rateLimitCount;
    /** Create a source request gate with an independent cooldown clock. */
    ProviderCooldown() { }
    static final ProviderCooldown SOURCE = new ProviderCooldown();

    /** @param cancelled durable owner cancellation predicate; waiting holds no provider connection */
    void await(BooleanSupplier cancelled) {
        while (true) {
            if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new CancellationException("Provider wait cancelled.");
            long wait;
            synchronized (this) {
                long now = System.currentTimeMillis(); wait = Math.max(nextRequest, blockedUntil) - now;
                if (wait <= 0) { nextRequest = now + 500; return; }
            }
            try { Thread.sleep(Math.min(wait, 250)); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new CancellationException("Provider wait cancelled."); }
        }
    }

    /** @param retryAfter provider seconds or HTTP date @param now current clock @return computed shared cooldown in milliseconds */
    synchronized long limited(String retryAfter, long now) {
        long delay = Math.min(900000L, 30000L << Math.min(5, rateLimitCount++));
        long requested = retryAfterMillis(retryAfter, now);
        blockedUntil = Math.max(blockedUntil, now + Math.max(delay, requested));
        return blockedUntil - now;
    }

    /** @param value Retry-After header @param now UTC milliseconds @return nonnegative provider-requested delay */
    static long retryAfterMillis(String value, long now) {
        if (value == null) return 0;
        try { return Math.max(0, Math.min(86400000L, Math.multiplyExact(Long.parseLong(value.trim()), 1000L))); }
        catch (RuntimeException notSeconds) {
            try { return Math.max(0, Math.min(86400000L, ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() - now)); }
            catch (RuntimeException invalid) { return 0; }
        }
    }

    /** Reset only the exponential backoff counter after a successful provider response. */
    synchronized void succeeded() { rateLimitCount = 0; }
}
