package com.scriptarr.raven.downloader;

import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Rechecking metadata is durable repair, never a second bulk creation or implicit approval. */
class BulkMetadataRecheckTest {
    /** Replays retain exact receipts and preserve accepted tasks and old decisions. */
    @Test void rechecksOnlySkippedMetadataIdempotently() {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient();
        broker.putJob("run", Map.of("jobId", "run", "ownerService", "scriptarr-raven", "kind", "raven-bulk-downloadall",
            "status", "paused", "payload", Map.of("approvalId", "approval")));
        seed(broker, "skip", "noMetadata", false); seed(broker, "accepted", "queued", true);
        DownloaderService downloader = mock(DownloaderService.class);
        BulkRunGateway gateway = mock(BulkRunGateway.class);
        BulkRunService service = new BulkRunService(downloader, broker, mock(ScriptarrLogger.class), gateway, Clock.systemUTC(), Duration.ofMillis(1));
        try {
            Map<String, Object> first = service.recheckMetadata("run", "approval", "request");
            assertEquals(List.of("skip"), first.get("recheckedPlanIds"));
            assertEquals(first, service.recheckMetadata("run", "approval", "request"));
            var rows = broker.listJobTasks("run", "");
            for (var row : rows) {
                if (row.path("taskId").asText().equals("skip")) {
                    assertEquals("unresolved", row.path("result").path("category").asText());
                    assertEquals("noMetadata", row.path("payload").path("metadataRecheckHistory").path("request").path("result").path("category").asText());
                } else assertEquals("queued", row.path("result").path("category").asText());
            }
            assertThrows(BulkRunConflictException.class, () -> service.recheckMetadata("run", "stale", "another"));
            verifyNoInteractions(downloader, gateway);
        } finally { service.shutdown(); }
    }

    /** A lost plan write leaves a replayable durable intent, never missing work or a started run. */
    @Test void repairsInterruptedPlanWrites() {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient();
        broker.putJob("run", Map.of("jobId", "run", "ownerService", "scriptarr-raven", "kind", "raven-bulk-downloadall",
            "status", "paused", "payload", Map.of("approvalId", "approval")));
        seed(broker, "skip", "ambiguous", false);
        BulkRunService service = new BulkRunService(mock(DownloaderService.class), broker, mock(ScriptarrLogger.class), mock(BulkRunGateway.class), Clock.systemUTC(), Duration.ofMillis(1));
        try {
            broker.failNextJobTaskWriteAndFollowingList();
            assertThrows(IllegalStateException.class, () -> service.recheckMetadata("run", "approval", "request"));
            assertThrows(IllegalStateException.class, () -> service.recheckMetadata("run", "approval", "request"));
            assertEquals(List.of("skip"), service.recheckMetadata("run", "approval", "request").get("recheckedPlanIds"));
            assertEquals("paused", broker.listJobs("scriptarr-raven", "raven-bulk-downloadall", "").get(0).path("status").asText());
        } finally { service.shutdown(); }
    }

    private void seed(FakeRavenBrokerClient broker, String id, String category, boolean accepted) {
        Map<String, Object> payload = new java.util.LinkedHashMap<>(); payload.put("kind", "bulk-title-plan");
        if (accepted) payload.put("request", Map.of("owned", true));
        broker.putJobTask("run", id, Map.of("taskId", id, "taskKey", "bulk-title-plan", "status", "completed", "payload", payload, "result", Map.of("category", category)));
    }
}
