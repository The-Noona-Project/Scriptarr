package com.scriptarr.raven.downloader;

import org.junit.jupiter.api.Test;
import java.time.Instant;
import static org.junit.jupiter.api.Assertions.*;

/** Provider retry deadlines retain both standard Retry-After representations. */
class ProviderCooldownTest {
    /** Owner cancellation aborts even a long shared Retry-After without making another request. */
    @Test void cancellationAbortsCooldown() {
        ProviderCooldown gate = new ProviderCooldown();
        gate.limited("86400", System.currentTimeMillis());
        assertTimeoutPreemptively(java.time.Duration.ofSeconds(1), () ->
            assertThrows(java.util.concurrent.CancellationException.class, () -> gate.await(() -> true)));
    }
    /** Numeric seconds and HTTP dates share UTC semantics; malformed values do not invent a delay. */
    @Test void parsesRetryAfter() {
        long now = Instant.parse("2026-11-20T12:00:00Z").toEpochMilli();
        assertEquals(120000, ProviderCooldown.retryAfterMillis("120", now));
        assertEquals(60000, ProviderCooldown.retryAfterMillis("Fri, 20 Nov 2026 12:01:00 GMT", now));
        assertEquals(0, ProviderCooldown.retryAfterMillis("invalid", now));
        assertEquals(0, ProviderCooldown.retryAfterMillis("-1", now));
    }
}
