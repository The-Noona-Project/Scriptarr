package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.time.Instant;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

/** Automatic windows enforce capacity, worker readiness, protected traffic and the explicit backup policy. */
class MassDownloadReadinessTest {
    /** @param root empty managed root @throws Exception when constructing proof or reading files fails */
    @Test void explicitNoBackupPolicySkipsEvidenceWithoutRelaxingOtherGates(@org.junit.jupiter.api.io.TempDir java.nio.file.Path root) throws Exception {
        ObjectMapper json = new ObjectMapper();var forecast = json.createObjectNode();
        assertTrue(MassDownloadReadiness.requiresBackup(forecast));
        forecast.put("backupRequired", false);assertFalse(MassDownloadReadiness.requiresBackup(forecast));
        var absent = MassDownloadReadiness.readBackup(root, false);assertTrue(absent.isNull());
        assertThrows(java.io.IOException.class, () -> MassDownloadReadiness.readBackup(root, true));
        var pool = json.valueToTree(Map.of("capacity", 1, "workers", java.util.List.of(Map.of("ready", true))));
        assertDoesNotThrow(() -> MassDownloadReadiness.validate(pool, Map.of("enabled", true, "protected", true), absent, Instant.now(), false));
        assertThrows(java.io.IOException.class, () -> MassDownloadReadiness.validate(pool, Map.of("enabled", true, "protected", false), absent, Instant.now(), false));
        assertThrows(java.io.IOException.class, () -> MassDownloadReadiness.validate(json.createObjectNode(), Map.of("enabled", false), absent, Instant.now(), false));
        forecast.put("backupRequired", "false");assertThrows(java.io.IOException.class, () -> MassDownloadReadiness.requiresBackup(forecast));
        forecast.putNull("backupRequired");assertThrows(java.io.IOException.class, () -> MassDownloadReadiness.requiresBackup(forecast));
        var capacity = json.valueToTree(Map.of("approved", true, "type", "all", "nsfw", false, "backupRequired", false, "perLetterEstimateBytes", 1L << 30));
        assertThrows(java.io.IOException.class, () -> MassDownloadReadiness.requireForecast(capacity, "A", 110L << 30));
    }

    /** @throws Exception when fixture JSON cannot be read */
    @Test void rejectsStaleBackupsAndUnavailableDependencies() throws Exception {
        ObjectMapper json = new ObjectMapper(); Instant now = Instant.parse("2026-11-20T12:00:00Z");
        var pool = json.valueToTree(Map.of("capacity", 1, "workers", java.util.List.of(Map.of("ready", true))));
        var backup = json.valueToTree(Map.of("state", "complete", "createdAt", "2026-11-20T11:00:00Z"));
        assertDoesNotThrow(() -> MassDownloadReadiness.validate(pool, Map.of("enabled", true, "protected", true), backup, now));
        assertThrows(java.io.IOException.class, () -> MassDownloadReadiness.validate(pool, Map.of("enabled", true, "protected", false), backup, now));
        assertThrows(java.io.IOException.class, () -> MassDownloadReadiness.validate(json.createObjectNode(), Map.of("enabled", false), backup, now));
        assertThrows(java.io.IOException.class, () -> MassDownloadReadiness.validate(pool, Map.of("enabled", false), backup, now.plusSeconds(31 * 3600)));
    }

    /** A forecast reserves the remaining alphabet and 25 percent estimation headroom. @throws Exception when fixture JSON cannot be created */
    @Test void reservesRemainingAlphabet() throws Exception {
        var proof = new ObjectMapper().valueToTree(Map.of("approved", true, "type", "all", "nsfw", false, "perLetterEstimateBytes", 1L << 30));
        assertDoesNotThrow(() -> MassDownloadReadiness.requireForecast(proof, "Z", 150L << 30));
        assertThrows(java.io.IOException.class, () -> MassDownloadReadiness.requireForecast(proof, "A", 110L << 30));
        assertThrows(java.io.IOException.class, () -> MassDownloadReadiness.requireForecast(proof, "all", Long.MAX_VALUE));
        ((com.fasterxml.jackson.databind.node.ObjectNode) proof).put("perLetterEstimateBytes", 1.5);
        assertThrows(java.io.IOException.class, () -> MassDownloadReadiness.requireForecast(proof, "A", Long.MAX_VALUE));
    }
}
