package com.scriptarr.raven.api;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Authenticate new broker-only binary and destructive routes without exposing coordinator credentials to workers. */
final class CoordinatorIngress {
    /** Prevent construction of this constant-time ingress check. */
    private CoordinatorIngress() { }

    /** @param authorization incoming bearer header @return whether Sage supplied the coordinator's own nonblank service token */
    static boolean allowed(String authorization) {
        String expected = System.getenv("SCRIPTARR_SERVICE_TOKEN");
        if (expected == null || expected.isBlank() || authorization == null || !authorization.startsWith("Bearer ")) return false;
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), authorization.substring(7).getBytes(StandardCharsets.UTF_8));
    }
}
