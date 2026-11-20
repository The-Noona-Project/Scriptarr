package com.scriptarr.raven.api;

import com.scriptarr.raven.library.RemoteChapterProcessor;
import com.scriptarr.raven.support.ScriptarrLogger;
import com.scriptarr.raven.support.StorageBudget;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import java.util.Map;

/** Authenticated operational storage diagnostics and bounded duplicate-artifact reclamation. */
@RestController
public final class StorageController {
    private final ScriptarrLogger logger;
    private final RemoteChapterProcessor remote;
    /** @param logger managed storage root @param remote fenced conversion owner */
    public StorageController(ScriptarrLogger logger, RemoteChapterProcessor remote) { this.logger = logger; this.remote = remote; }
    /** @return observational storage state without clearing a pressure latch */
    @GetMapping("/v1/storage")
    public Map<String, Object> storage() { return StorageBudget.status(logger.getDownloadsRoot()); }
    /** @return bounded exact-artifact reclamation counts @throws Exception on root inspection failure */
    @PostMapping("/v1/ingest/artifacts/reclaim")
    public Map<String, Object> reclaim() throws Exception { return remote.reclaimArtifacts(128); }
}
