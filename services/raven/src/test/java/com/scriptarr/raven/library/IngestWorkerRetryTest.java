package com.scriptarr.raven.library;

import org.junit.jupiter.api.Test;
import java.net.ConnectException;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;

/** Retry windows never start another binary transfer after expiry or lease loss. */
class IngestWorkerRetryTest {
    /** A backoff reaching the recovery deadline must retain the failure without another transfer. */
    @Test void recoveryDeadlineStopsBeforeAnotherTransfer() {
        AtomicInteger calls = new AtomicInteger();
        ConnectException failure = new ConnectException("isolated outage");
        assertSame(failure, assertThrows(ConnectException.class, () -> IngestWorkerRuntime.retryTransfer(() -> {
            calls.incrementAndGet(); throw failure;
        }, new AtomicLong(System.currentTimeMillis() + 10000), Duration.ofMillis(25))));
        assertEquals(1, calls.get());
    }

    /** An expired lease prevents even the first attempt. */
    @Test void expiredLeaseStopsBeforeAnyTransfer() {
        AtomicInteger calls = new AtomicInteger();
        assertThrows(InterruptedException.class, () -> IngestWorkerRuntime.retryTransfer(calls::incrementAndGet,
            new AtomicLong(System.currentTimeMillis() - 1), Duration.ofMillis(25)));
        assertEquals(0, calls.get());
    }
}
