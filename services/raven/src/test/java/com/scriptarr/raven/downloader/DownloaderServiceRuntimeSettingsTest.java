package com.scriptarr.raven.downloader;

import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Unit coverage for Raven's live title-download runtime settings.
 */
class DownloaderServiceRuntimeSettingsTest {
    /**
     * Verify Raven keeps today's two-title default when no setting exists.
     */
    @Test
    void defaultActiveTitleDownloadsIsTwo() {
        DownloaderService service = createService(new FakeRavenBrokerClient());
        try {
            assertEquals(2, service.stats().get("activeSlots"));
            assertEquals(2, service.stats().get("totalSlots"));
        } finally {
            service.shutdown();
        }
    }

    /**
     * Verify brokered runtime settings resize the title worker live.
     */
    @Test
    void reloadDownloadRuntimeSettingsResizesTitleSlots() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        DownloaderService service = createService(brokerClient);
        try {
            brokerClient.setSetting("raven.download.runtime", Map.of("activeTitleDownloads", 4));
            Map<String, Object> expanded = service.reloadDownloadRuntimeSettings();
            assertEquals(4, expanded.get("activeTitleDownloads"));
            assertEquals(4, service.stats().get("activeSlots"));

            brokerClient.setSetting("raven.download.runtime", Map.of("activeTitleDownloads", 1));
            Map<String, Object> reduced = service.reloadDownloadRuntimeSettings();
            assertEquals(1, reduced.get("activeTitleDownloads"));
            assertEquals(1, service.stats().get("activeSlots"));
        } finally {
            service.shutdown();
        }
    }

    /**
     * Verify startup task restore applies the saved runtime setting first.
     */
    @Test
    void restorePersistedTasksAppliesSavedRuntimeSettingFirst() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        brokerClient.setSetting("raven.download.runtime", Map.of("activeTitleDownloads", 5));
        DownloaderService service = createService(brokerClient);
        try {
            service.restorePersistedTasks();
            assertEquals(5, service.stats().get("activeSlots"));
        } finally {
            service.shutdown();
        }
    }

    /**
     * Verify local Raven task history keeps active tasks and recent terminal
     * entries without deleting durable broker records.
     *
     * @throws Exception when private task state cannot be seeded
     */
    @Test
    void snapshotPrunesOldTerminalTasksButKeepsActiveTasks() throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        DownloaderService service = createService(brokerClient);
        try {
            Map<String, Map<String, Object>> tasks = taskMap(service);
            for (int index = 0; index < 210; index++) {
                tasks.put("failed-" + index, task("failed-" + index, "failed", index));
            }
            tasks.put("queued-active", task("queued-active", "queued", -1000));
            tasks.put("running-active", task("running-active", "running", -1000));

            List<Map<String, Object>> snapshot = service.snapshot();

            assertEquals(202, snapshot.size());
            assertTrue(snapshot.stream().anyMatch((task) -> "queued-active".equals(task.get("taskId"))));
            assertTrue(snapshot.stream().anyMatch((task) -> "running-active".equals(task.get("taskId"))));
            assertTrue(snapshot.stream().noneMatch((task) -> "failed-0".equals(task.get("taskId"))));
            assertTrue(brokerClient.listDownloadTasks().isArray());
        } finally {
            service.shutdown();
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Map<String, Object>> taskMap(DownloaderService service) throws Exception {
        Field field = DownloaderService.class.getDeclaredField("tasks");
        field.setAccessible(true);
        return (Map<String, Map<String, Object>>) field.get(service);
    }

    private Map<String, Object> task(String taskId, String status, int minutesOffset) {
        String timestamp = Instant.parse("2026-01-01T00:00:00Z").plusSeconds(minutesOffset * 60L).toString();
        Map<String, Object> task = new LinkedHashMap<>();
        task.put("taskId", taskId);
        task.put("jobId", taskId);
        task.put("titleName", taskId);
        task.put("status", status);
        task.put("message", status);
        task.put("percent", "completed".equals(status) ? 100 : 0);
        task.put("queuedAt", timestamp);
        task.put("updatedAt", timestamp);
        task.put("sortOrder", (long) minutesOffset);
        return task;
    }

    private DownloaderService createService(FakeRavenBrokerClient brokerClient) {
        TestLogger logger = new TestLogger();
        RavenSettingsService settingsService = new RavenSettingsService(brokerClient, logger, java.util.List.of());
        return new DownloaderService(null, null, null, null, null, brokerClient, settingsService, logger);
    }

    private static final class TestLogger extends ScriptarrLogger {
        @Override
        public Path getDownloadsRoot() {
            return Path.of("build/test-downloads");
        }

        @Override
        public Path getLogsRoot() {
            return Path.of("build/test-logs");
        }

        @Override
        public void warn(String tag, String message, String detail) {
        }
    }
}
