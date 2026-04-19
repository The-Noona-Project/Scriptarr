package com.scriptarr.raven.vpn;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Unit tests for Raven's hardened VPN connection flow.
 */
class VpnServiceTest {
    /**
     * Verify Raven reconnects when the requested VPN region changes.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void ensureConnectedIfEnabledReconnectsWhenRegionChanges(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        writeProfile(tempDir, "us_california.ovpn");
        writeProfile(tempDir, "us_texas.ovpn");
        brokerClient.setSetting("raven.vpn", Map.of(
            "enabled", true,
            "region", "us_california",
            "piaUsername", "captain"
        ));
        brokerClient.setSecret("raven.vpn.piaPassword", "secret");

        TrackingVpnService service = new TrackingVpnService(new RavenSettingsService(brokerClient, logger, List.of()), logger);
        service.ensureConnectedIfEnabled();

        brokerClient.setSetting("raven.vpn", Map.of(
            "enabled", true,
            "region", "us_texas",
            "piaUsername", "captain"
        ));
        service.ensureConnectedIfEnabled();

        assertEquals(2, service.startCount());
        assertEquals("us_texas.ovpn", service.lastProfileName());
        assertEquals(1, service.destroyedProcessCount());
    }

    /**
     * Verify Raven prefers an exact region profile name and refreshes the
     * extracted profiles from the cached archive when the local profile set is
     * stale.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void ensureConnectedIfEnabledRefreshesProfilesFromArchive(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        writeProfile(tempDir, "us_texas_private.ovpn");
        writeProfileArchive(tempDir, Map.of("us_texas.ovpn", "client"));
        brokerClient.setSetting("raven.vpn", Map.of(
            "enabled", true,
            "region", "us_texas",
            "piaUsername", "captain"
        ));
        brokerClient.setSecret("raven.vpn.piaPassword", "secret");

        TrackingVpnService service = new TrackingVpnService(new RavenSettingsService(brokerClient, logger, List.of()), logger);
        service.ensureConnectedIfEnabled();

        assertEquals("us_texas.ovpn", service.lastProfileName());
    }

    /**
     * Verify Raven fails closed when broker-backed VPN settings cannot be read.
     *
     * @param tempDir temporary test directory
     */
    @Test
    void ensureConnectedIfEnabledFailsClosedWhenSettingsCannotBeLoaded(@TempDir Path tempDir) {
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        RavenBrokerClient brokerClient = new ThrowingVpnBrokerClient();
        VpnService service = new TrackingVpnService(new RavenSettingsService(brokerClient, logger, List.of()), logger);

        IllegalStateException error = assertThrows(IllegalStateException.class, service::ensureConnectedIfEnabled);

        assertTrue(error.getMessage().contains("Failed to load Raven VPN settings."));
    }

    /**
     * Verify Raven surfaces authentication failures instead of waiting for the
     * full VPN startup timeout.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void ensureConnectedIfEnabledDetectsAuthenticationFailures(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        writeProfile(tempDir, "us_california.ovpn");
        brokerClient.setSetting("raven.vpn", Map.of(
            "enabled", true,
            "region", "us_california",
            "piaUsername", "captain"
        ));
        brokerClient.setSecret("raven.vpn.piaPassword", "secret");

        TrackingVpnService service = new TrackingVpnService(
            new RavenSettingsService(brokerClient, logger, List.of()),
            logger,
            "AUTH FAILED"
        );

        IllegalStateException error = assertThrows(IllegalStateException.class, service::ensureConnectedIfEnabled);

        assertTrue(error.getMessage().contains("PIA authentication failed."));
    }

    /**
     * Verify Raven fails fast when OpenVPN exits before initialization.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void ensureConnectedIfEnabledFailsWhenProcessDiesEarly(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        writeProfile(tempDir, "us_california.ovpn");
        brokerClient.setSetting("raven.vpn", Map.of(
            "enabled", true,
            "region", "us_california",
            "piaUsername", "captain"
        ));
        brokerClient.setSecret("raven.vpn.piaPassword", "secret");

        TrackingVpnService service = new TrackingVpnService(
            new RavenSettingsService(brokerClient, logger, List.of()),
            logger,
            "",
            false
        );

        IllegalStateException error = assertThrows(IllegalStateException.class, service::ensureConnectedIfEnabled);

        assertTrue(error.getMessage().contains("OpenVPN exited before initialization completed."));
    }

    private void writeProfile(Path tempDir, String fileName) throws IOException {
        Path profilePath = tempDir.resolve("vpn").resolve("pia").resolve("profiles").resolve(fileName);
        Files.createDirectories(profilePath.getParent());
        Files.writeString(profilePath, "client");
    }

    private void writeProfileArchive(Path tempDir, Map<String, String> entries) throws IOException {
        Path archivePath = tempDir.resolve("vpn").resolve("pia").resolve("openvpn-ip.zip");
        Files.createDirectories(archivePath.getParent());
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archivePath))) {
            for (Map.Entry<String, String> entry : entries.entrySet()) {
                zip.putNextEntry(new ZipEntry(entry.getKey()));
                zip.write(entry.getValue().getBytes());
                zip.closeEntry();
            }
        }
    }

    /**
     * Test-specific VPN service that replaces OpenVPN with a fake process.
     */
    private static final class TrackingVpnService extends VpnService {
        private final String processOutput;
        private final boolean alive;
        private final AtomicInteger startCount = new AtomicInteger();
        private String lastProfileName = "";
        private final List<FakeProcess> processes = new java.util.ArrayList<>();

        private TrackingVpnService(RavenSettingsService settingsService, ScriptarrLogger logger) {
            this(settingsService, logger, "Initialization Sequence Completed", true);
        }

        private TrackingVpnService(RavenSettingsService settingsService, ScriptarrLogger logger, String processOutput) {
            this(settingsService, logger, processOutput, true);
        }

        private TrackingVpnService(RavenSettingsService settingsService, ScriptarrLogger logger, String processOutput, boolean alive) {
            super(settingsService, logger);
            this.processOutput = processOutput;
            this.alive = alive;
        }

        @Override
        protected Process startOpenVpnProcess(Path profile, Path credentialsFile) {
            startCount.incrementAndGet();
            lastProfileName = profile.getFileName().toString();
            FakeProcess process = new FakeProcess(processOutput, alive);
            processes.add(process);
            return process;
        }

        private int startCount() {
            return startCount.get();
        }

        private String lastProfileName() {
            return lastProfileName;
        }

        private int destroyedProcessCount() {
            return (int) processes.stream().filter(FakeProcess::destroyed).count();
        }
    }

    /**
     * Minimal process stub for Raven VPN tests.
     */
    private static final class FakeProcess extends Process {
        private final byte[] output;
        private final boolean alive;
        private boolean destroyed;

        private FakeProcess(String output, boolean alive) {
            this.output = output.getBytes();
            this.alive = alive;
        }

        @Override
        public OutputStream getOutputStream() {
            return OutputStream.nullOutputStream();
        }

        @Override
        public InputStream getInputStream() {
            return new ByteArrayInputStream(output);
        }

        @Override
        public InputStream getErrorStream() {
            return InputStream.nullInputStream();
        }

        @Override
        public int waitFor() {
            return 0;
        }

        @Override
        public boolean waitFor(long timeout, java.util.concurrent.TimeUnit unit) {
            return true;
        }

        @Override
        public int exitValue() {
            return 0;
        }

        @Override
        public void destroy() {
            destroyed = true;
        }

        @Override
        public Process destroyForcibly() {
            destroyed = true;
            return this;
        }

        @Override
        public boolean isAlive() {
            return alive && !destroyed;
        }

        private boolean destroyed() {
            return destroyed;
        }
    }

    /**
     * Broker client that simulates a shared-state read failure.
     */
    private static final class ThrowingVpnBrokerClient implements RavenBrokerClient {
        @Override
        public JsonNode getSetting(String key) throws IOException {
            throw new IOException("settings offline");
        }

        @Override
        public JsonNode getSecret(String key) throws IOException {
            throw new IOException("secrets offline");
        }

        @Override
        public JsonNode listLibraryTitles() {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode getLibraryTitle(String titleId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode putLibraryTitle(String titleId, Map<String, Object> payload) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode putLibraryChapters(String titleId, Map<String, Object> payload) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode listDownloadTasks() {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode putDownloadTask(String taskId, Map<String, Object> payload) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode getMetadataMatch(String titleId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode putMetadataMatch(String titleId, Map<String, Object> payload) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode listJobs(String ownerService, String kind, String status) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode putJob(String jobId, Map<String, Object> payload) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode listJobTasks(String jobId, String status) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode putJobTask(String jobId, String taskId, Map<String, Object> payload) {
            throw new UnsupportedOperationException();
        }
    }
}
