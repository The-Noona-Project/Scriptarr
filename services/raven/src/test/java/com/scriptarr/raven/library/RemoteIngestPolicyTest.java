package com.scriptarr.raven.library;

import com.scriptarr.raven.support.FakeRavenBrokerClient;
import org.junit.jupiter.api.Test;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

/** A WebP deployment never silently falls back to local AVIF when its optional worker is absent. */
class RemoteIngestPolicyTest {
    /** Configured WebP implies remote wait and opt-in migration, independently of worker assignment or legacy NVENC values. */
    @Test void configuredWebpAlwaysRequiresRemoteWorkerAndStartsPaused() {
        Map<String, String> env = Map.of("SCRIPTARR_RAVEN_DERIVED_IMAGE_FORMAT", "webp", "SCRIPTARR_RAVEN_AVIF_ENCODER", "nvenc", "SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED", "false");
        assertTrue(RemoteChapterProcessor.remoteRequired(env)); assertFalse(new WebpMigrationControl(new FakeRavenBrokerClient(), env).enabled());
    }

    /** Existing explicit remote policy remains valid when the additive output-format setting is absent. */
    @Test void explicitRemotePolicyRemainsRemoteOnly() {
        assertTrue(RemoteChapterProcessor.remoteRequired(Map.of("SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED", "true")));
        assertTrue(RemoteChapterProcessor.remoteRequired(Map.of("SCRIPTARR_RAVEN_DERIVED_IMAGE_FORMAT", " WebP ")));
    }

    /** Explicit standalone AVIF retains its compatibility path when no remote policy was requested. */
    @Test void explicitlyLegacyAvifRetainsCompatibility() {
        Map<String, String> env = Map.of("SCRIPTARR_RAVEN_DERIVED_IMAGE_FORMAT", "avif", "SCRIPTARR_RAVEN_REMOTE_INGEST_REQUIRED", "false");
        assertFalse(RemoteChapterProcessor.remoteRequired(env)); assertTrue(new WebpMigrationControl(new FakeRavenBrokerClient(), env).enabled());
        assertFalse(RemoteChapterProcessor.remoteRequired(Map.of()));
    }
}
