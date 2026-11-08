package com.scriptarr.raven.library;

import com.scriptarr.raven.settings.RavenBrokerClient;

import java.util.Map;

/** Durable opt-in migration switch; initial deployment serves cleanup without scheduling background encodes. */
final class WebpMigrationControl {
    private static final String KIND = "raven-webp-migration-control";
    private static final String ID = "raven_webp_migration_control";
    private final RavenBrokerClient broker;
    private final boolean remote;
    private final boolean defaultEnabled;

    /** @param broker existing Sage generic-job transport */
    WebpMigrationControl(RavenBrokerClient broker) { this(broker, System.getenv()); }

    /** @param broker isolated durable broker @param env explicit deployment settings */
    WebpMigrationControl(RavenBrokerClient broker, Map<String, String> env) {
        this.broker = broker; remote = RemoteChapterProcessor.remoteRequired(env); defaultEnabled = "true".equalsIgnoreCase(env.get("SCRIPTARR_RAVEN_WEBP_MIGRATION_ENABLED"));
    }

    /** @return whether this deployment requires remote WebP output */
    static boolean webp() { return RemoteChapterProcessor.remoteRequired(System.getenv()); }

    /** @return persisted scheduler intent; false is the initial remote deployment default */
    boolean enabled() {
        if (!remote) return true;
        try {
            var jobs = broker.listJobs("scriptarr-raven", KIND, "");
            if (jobs == null || !jobs.isArray()) throw new IllegalStateException("Migration control is unavailable.");
            for (var job : jobs) if (ID.equals(job.path("jobId").asText())) {
                if (!job.path("payload").path("enabled").isBoolean()) throw new IllegalStateException("Durable migration intent is malformed.");
                return job.path("payload").path("enabled").asBoolean();
            }
            return defaultEnabled;
        } catch (Exception unavailable) { throw new IllegalStateException("Could not read durable migration intent.", unavailable); }
    }

    /** @param enabled explicit operator intent @param actor requesting operator */
    void set(boolean enabled, String actor) {
        try { var saved = broker.putJob(ID, Map.of("jobId", ID, "kind", KIND, "ownerService", "scriptarr-raven", "status", enabled ? "running" : "paused",
            "label", "WebP migration control", "requestedBy", actor, "payload", Map.of("enabled", enabled), "result", Map.of()));
            if (saved == null || !ID.equals(saved.path("jobId").asText()) || !saved.path("payload").path("enabled").isBoolean() || saved.path("payload").path("enabled").asBoolean() != enabled) throw new IllegalStateException("Migration intent was not acknowledged."); }
        catch (Exception unavailable) { throw new IllegalStateException("Could not persist migration intent.", unavailable); }
    }
}
