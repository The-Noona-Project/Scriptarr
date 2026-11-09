package com.scriptarr.raven.downloader;

import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

/** Concurrent edition claims cannot enter a shared canonical write scope. */
class CanonicalSourceClaimsTest {
    /** Two distinct provider series cannot concurrently claim the same catalog identity. */
    @Test void differentEditionsCannotWriteSharedIdentity() {
        try (var first = CanonicalSourceClaims.acquire("https://weebcentral.com/series/01J76XYCH9QX9GSDFR6959N669/original", List.of("metadata:fixture"))) {
            assertThrows(IllegalStateException.class, () -> CanonicalSourceClaims.acquire("https://weebcentral.com/series/01J76XYDQHSY9H2V7050NC7843/reboot", List.of("metadata:fixture")));
            try (var replay = CanonicalSourceClaims.acquire("https://weebcentral.com/series/01J76XYCH9QX9GSDFR6959N669/new-slug", List.of("metadata:fixture"))) { assertNotNull(replay); }
            try (var unrelated = CanonicalSourceClaims.acquire("https://example.invalid/unrelated", List.of("metadata:unrelated"))) { assertNotNull(unrelated); }
        }
        try (var released = CanonicalSourceClaims.acquire("https://weebcentral.com/series/01J76XYDQHSY9H2V7050NC7843", List.of("metadata:fixture"))) { assertNotNull(released); }
    }
}
