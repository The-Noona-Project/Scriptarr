package com.scriptarr.raven.api;

import com.scriptarr.raven.library.LibraryIngestRunService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import java.util.Map;

/** Protected operator controls for opt-in durable whole-library migration. */
@RestController
public final class WebpMigrationController {
    private final LibraryIngestRunService runs;
    /** @param runs durable chapter-fair scheduler */
    public WebpMigrationController(LibraryIngestRunService runs) { this.runs = runs; }
    /** @param action explicit scheduling decision @param body operator attribution @param authorization main-service token @return durable intent or bounded rejection */
    @PostMapping("/v1/ingest/migration/{action}")
    public ResponseEntity<?> action(@PathVariable String action, @RequestBody(required = false) Map<String, Object> body,
        @RequestHeader(value = "Authorization", required = false) String authorization) {
        if (!CoordinatorIngress.allowed(authorization)) return ResponseEntity.status(403).build();
        try { return ResponseEntity.ok(runs.migrationAction(action, body)); }
        catch (RuntimeException rejected) { return ResponseEntity.status(409).body(Map.of("error", "Migration control could not acknowledge the requested decision.")); }
    }
}
