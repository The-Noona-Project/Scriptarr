package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.library.IngestBrokerClient;
import com.scriptarr.raven.support.StorageBudget;
import com.scriptarr.raven.vpn.VpnService;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.Duration;
import java.util.Map;

/** Owner-approved automatic windows enforce capacity, protected traffic, worker readiness and the explicit backup policy. */
final class MassDownloadReadiness {
    private MassDownloadReadiness() { }

    /** @param root managed data root @param vpn configured fail-closed VPN @param group current A-Z window @throws Exception when a dependency is unavailable */
    static void require(Path root, VpnService vpn, String group) throws Exception {
        StorageBudget.require(root);
        JsonNode forecast = new ObjectMapper().readTree(Files.readString(root.resolve(".operations/mass-capacity.json")));
        requireForecast(forecast, group, Files.getFileStore(root).getUsableSpace());
        boolean backupRequired = requiresBackup(forecast);
        JsonNode backup = readBackup(root, backupRequired);
        JsonNode pool = new IngestBrokerClient(System.getenv()).jsonUntil("GET", "/pool", null, null, System.currentTimeMillis() + 5000);
        if (pool != null && pool.has("payload")) pool = pool.path("payload");
        validate(pool, vpn == null ? Map.of("enabled", false) : vpn.status(), backup, Instant.now(), backupRequired);
    }

    /** @param forecast owner-reviewed capacity and policy proof @return whether a fresh backup is required, defaulting to true @throws IOException when an explicit policy is not Boolean */
    static boolean requiresBackup(JsonNode forecast) throws IOException {
        JsonNode policy = forecast.path("backupRequired");
        if (policy.isMissingNode()) return true;
        if (!policy.isBoolean()) throw new IOException("mass_download_gate: Backup policy must be an explicit Boolean.");
        return policy.booleanValue();
    }

    /** @param root managed data root @param required explicit backup policy @return committed evidence or no evidence when backups are disabled @throws IOException when required evidence is unavailable */
    static JsonNode readBackup(Path root, boolean required) throws IOException {
        return required ? new ObjectMapper().readTree(Files.readString(root.resolve(".operations/core-backup.json"))) : com.fasterxml.jackson.databind.node.NullNode.instance;
    }

    /** @param forecast reviewed A-based capacity proof @param group current letter @param available actual free bytes @throws IOException when the remaining estimate cannot fit with headroom */
    static void requireForecast(JsonNode forecast, String group, long available) throws IOException {
        if (group == null || !group.matches("[A-Z]") || !forecast.path("approved").isBoolean() || !forecast.path("approved").asBoolean()
            || !forecast.path("nsfw").isBoolean() || forecast.path("nsfw").asBoolean()
            || !"all".equals(forecast.path("type").asText()) || !forecast.path("perLetterEstimateBytes").isIntegralNumber()
            || !forecast.path("perLetterEstimateBytes").canConvertToLong()) throw new IOException("mass_download_gate: A reviewed capacity forecast is required.");
        long estimate = forecast.path("perLetterEstimateBytes").asLong();
        double required = estimate * (double) ('Z' - group.charAt(0) + 1) * 1.25 + 100L * (1L << 30);
        if (estimate <= 0 || available < required) throw new IOException("mass_download_gate: Remaining A-Z estimate exceeds available array capacity with 25% headroom.");
    }

    /** @param pool live pool @param vpn live protection @param backup committed backup proof @param now current UTC time @throws IOException when a gate fails */
    static void validate(JsonNode pool, Map<String, Object> vpn, JsonNode backup, Instant now) throws IOException {
        validate(pool, vpn, backup, now, true);
    }

    /** @param pool live pool @param vpn live protection @param backup optional committed evidence @param now current UTC time @param backupRequired explicit owner policy @throws IOException when any required gate fails */
    static void validate(JsonNode pool, Map<String, Object> vpn, JsonNode backup, Instant now, boolean backupRequired) throws IOException {
        try {
            if (backupRequired) {
                Duration age = Duration.between(Instant.parse(backup.path("createdAt").asText()), now);
                if (!"complete".equals(backup.path("state").asText()) || age.isNegative() || age.compareTo(Duration.ofHours(30)) >= 0) throw new IOException("mass_download_gate: A fresh committed core backup is required.");
            }
            if (Boolean.TRUE.equals(vpn.get("enabled")) && !Boolean.TRUE.equals(vpn.get("protected"))) throw new IOException("mass_download_gate: VPN protection is unavailable.");
            boolean ready = false;
            if (pool != null && pool.path("capacity").asInt() > 0) for (JsonNode worker : pool.path("workers")) if (worker.path("ready").asBoolean()) ready = true;
            if (!ready) throw new IOException("mass_download_gate: No ready remote WebP worker is available.");
        } catch (RuntimeException invalid) { throw new IOException("mass_download_gate: Readiness evidence is malformed.", invalid); }
    }
}
