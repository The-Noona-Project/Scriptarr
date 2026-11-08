package com.scriptarr.raven.api;

import com.scriptarr.raven.library.ScopedContentCleanup;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** Sage-governed exact-plan cleanup; deliberately separate from the unsupported global reset for this operation. */
@RestController
public final class ScopedContentCleanupController {
    private final ScopedContentCleanup cleanup;

    /** @param cleanup fenced exact-scope coordinator service */
    public ScopedContentCleanupController(ScopedContentCleanup cleanup) { this.cleanup = cleanup; }

    /** @param body durable run/plan selection @return reviewed filesystem scope or a bounded conflict */
    @PostMapping("/v1/system/scoped-content-reset/preview")
    public ResponseEntity<?> preview(@RequestBody Map<String, Object> body, @RequestHeader(value = "Authorization", required = false) String authorization) {
        if (!CoordinatorIngress.allowed(authorization)) return ResponseEntity.status(403).build();
        try { return ResponseEntity.ok(cleanup.preview(body)); }
        catch (Exception rejected) { return ResponseEntity.status(409).body(Map.of("error", "Scoped cleanup preview could not verify ownership or quiescence.")); }
    }

    /** @param body reviewed operation and scope digests @return acknowledged exact-scope cleanup */
    @PostMapping("/v1/system/scoped-content-reset/apply")
    public ResponseEntity<?> apply(@RequestBody Map<String, Object> body, @RequestHeader(value = "Authorization", required = false) String authorization) {
        if (!CoordinatorIngress.allowed(authorization)) return ResponseEntity.status(403).build();
        try { return ResponseEntity.ok(cleanup.apply(body)); }
        catch (Exception rejected) { return ResponseEntity.status(409).body(Map.of("error", "Scoped cleanup did not finish; any acquired maintenance fence remains active.")); }
    }
}
