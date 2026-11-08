package com.scriptarr.raven.api;

import com.scriptarr.raven.library.RemoteChapterProcessor;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Sage-only streaming endpoints for leased conversion inputs and uncommitted result artifacts. */
@RestController
public final class IngestWorkController {
    private final RemoteChapterProcessor remote;

    /** @param remote coordinator-owned fenced artifact processor */
    public IngestWorkController(RemoteChapterProcessor remote) { this.remote = remote; }

    /** @param id immutable job @param workerId assigned worker @param epoch lease fence @return exact read-only canonical input */
    @GetMapping("/v1/ingest/work/jobs/{id}/input")
    public ResponseEntity<?> input(@PathVariable String id, @RequestParam String workerId, @RequestParam long epoch,
        @RequestHeader(value = "Authorization", required = false) String authorization) {
        if (!CoordinatorIngress.allowed(authorization)) return ResponseEntity.status(403).build();
        if (!remote.required()) return ResponseEntity.notFound().build();
        try { return ResponseEntity.ok().contentType(MediaType.parseMediaType("application/zip")).body(new FileSystemResource(remote.input(id, workerId, epoch))); }
        catch (Exception rejected) { return ResponseEntity.status(409).body(java.util.Map.of("error", "Assigned input is unavailable or its lease is stale.")); }
    }

    /** @param id immutable job @param workerId assigned worker @param epoch fence @param token forwarded transient lease secret @param request streamed ZIP body @return durable acceptance, never reader completion */
    @PostMapping(value = "/v1/ingest/work/jobs/{id}/artifact", consumes = {"application/zip", "application/octet-stream"})
    public ResponseEntity<?> artifact(@PathVariable String id, @RequestParam String workerId, @RequestParam long epoch,
        @RequestHeader("X-Scriptarr-Lease-Token") String token, @RequestHeader(value = "Authorization", required = false) String authorization, HttpServletRequest request) {
        if (!CoordinatorIngress.allowed(authorization)) return ResponseEntity.status(403).build();
        if (!remote.required()) return ResponseEntity.notFound().build();
        try { return ResponseEntity.ok(remote.accept(id, workerId, epoch, token, request.getInputStream())); }
        catch (Exception rejected) { return ResponseEntity.status(409).body(java.util.Map.of("error", "Chapter artifact was rejected or its lease is stale.")); }
    }
}
