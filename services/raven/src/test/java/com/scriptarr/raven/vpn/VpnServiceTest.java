package com.scriptarr.raven.vpn;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
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
        service.advance(Duration.ofSeconds(20));
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
     * Verify enabled, capable VPN settings report an armed idle state before
     * any download or admin test starts OpenVPN.
     *
     * @param tempDir temporary test directory
     */
    @Test
    void statusReportsArmedWhenEnabledButIdle(@TempDir Path tempDir) {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        brokerClient.setSetting("raven.vpn", Map.of(
            "enabled", true,
            "region", "us_california",
            "piaUsername", "captain"
        ));
        brokerClient.setSecret("raven.vpn.piaPassword", "secret");

        TrackingVpnService service = new TrackingVpnService(new RavenSettingsService(brokerClient, logger, List.of()), logger);
        Map<String, Object> status = service.status();

        assertEquals("armed", status.get("state"));
        assertEquals(false, status.get("connected"));
        assertEquals(false, status.get("protected"));
        assertEquals(0, service.startCount());
    }

    /**
     * Verify an admin VPN test uses the real connection guard and leaves a
     * successful enabled tunnel protected.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void testConnectionStartsEnabledVpnAndReturnsProtected(@TempDir Path tempDir) throws Exception {
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

        TrackingVpnService service = new TrackingVpnService(new RavenSettingsService(brokerClient, logger, List.of()), logger);
        Map<String, Object> status = service.testConnection();

        assertEquals(true, status.get("ok"));
        assertEquals("protected", status.get("state"));
        assertEquals(true, status.get("protected"));
        assertEquals(1, service.startCount());
        assertTrue(String.valueOf(status.get("lastConnectionAttemptAt")).startsWith("2026-01-01T"));
        assertTrue(String.valueOf(status.get("lastConnectedAt")).startsWith("2026-01-01T"));
    }

    /**
     * Verify an admin VPN test reports disabled state without starting
     * OpenVPN when the setting is off.
     *
     * @param tempDir temporary test directory
     */
    @Test
    void testConnectionReturnsDisabledWithoutStartingOpenVpn(@TempDir Path tempDir) {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        brokerClient.setSetting("raven.vpn", Map.of(
            "enabled", false,
            "region", "us_california",
            "piaUsername", "captain"
        ));

        TrackingVpnService service = new TrackingVpnService(new RavenSettingsService(brokerClient, logger, List.of()), logger);
        Map<String, Object> status = service.testConnection();

        assertEquals(true, status.get("ok"));
        assertEquals("disabled", status.get("state"));
        assertEquals(0, service.startCount());
    }

    /**
     * Verify an admin VPN test reports a failed state without leaking raw
     * multi-line OpenVPN output.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void testConnectionReportsFailedStateForBadCredentials(@TempDir Path tempDir) throws Exception {
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
            "AUTH FAILED\nusername rejected"
        );
        Map<String, Object> status = service.testConnection();

        assertEquals(false, status.get("ok"));
        assertEquals("failed", status.get("state"));
        assertTrue(String.valueOf(status.get("lastError")).contains("PIA authentication failed."));
        assertEquals(false, String.valueOf(status.get("lastError")).contains("\n"));
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

    /**
     * Verify Raven refuses VPN-backed downloads when the container lacks TUN or
     * NET_ADMIN runtime support.
     *
     * @param tempDir temporary test directory
     */
    @Test
    void ensureConnectedIfEnabledRequiresVpnRuntimeSupport(@TempDir Path tempDir) {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        brokerClient.setSetting("raven.vpn", Map.of(
            "enabled", true,
            "region", "us_california",
            "piaUsername", "captain"
        ));
        brokerClient.setSecret("raven.vpn.piaPassword", "secret");

        TrackingVpnService service = new TrackingVpnService(
            new RavenSettingsService(brokerClient, logger, List.of()),
            logger,
            "Initialization Sequence Completed",
            true,
            "Raven VPN runtime is missing NET_ADMIN."
        );

        IllegalStateException error = assertThrows(IllegalStateException.class, service::ensureConnectedIfEnabled);

        assertTrue(error.getMessage().contains("NET_ADMIN"));
        assertEquals(0, service.startCount());
    }

    /**
     * Verify a fresh last-known disabled state allows direct downloads during a
     * short broker outage.
     *
     * @param tempDir temporary test directory
     */
    @Test
    void ensureConnectedIfEnabledAllowsFreshDisabledCacheDuringSettingsOutage(@TempDir Path tempDir) {
        SwitchableVpnBrokerClient brokerClient = new SwitchableVpnBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        brokerClient.setSetting("raven.vpn", Map.of(
            "enabled", false,
            "region", "us_california",
            "piaUsername", ""
        ));

        TrackingVpnService service = new TrackingVpnService(new RavenSettingsService(brokerClient, logger, List.of()), logger);
        service.ensureConnectedIfEnabled();
        brokerClient.failReads(true);
        service.advance(Duration.ofSeconds(20));

        service.ensureConnectedIfEnabled();

        assertEquals(0, service.startCount());
    }

    /**
     * Verify stale disabled settings no longer allow direct downloads when the
     * broker cannot be reached.
     *
     * @param tempDir temporary test directory
     */
    @Test
    void ensureConnectedIfEnabledBlocksStaleDisabledCacheDuringSettingsOutage(@TempDir Path tempDir) {
        SwitchableVpnBrokerClient brokerClient = new SwitchableVpnBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        brokerClient.setSetting("raven.vpn", Map.of(
            "enabled", false,
            "region", "us_california",
            "piaUsername", ""
        ));

        TrackingVpnService service = new TrackingVpnService(new RavenSettingsService(brokerClient, logger, List.of()), logger);
        service.ensureConnectedIfEnabled();
        brokerClient.failReads(true);
        service.advance(Duration.ofMinutes(6));

        IllegalStateException error = assertThrows(IllegalStateException.class, service::ensureConnectedIfEnabled);

        assertTrue(error.getMessage().contains("Failed to load Raven VPN settings."));
    }

    /**
     * Verify a dead tunnel is reconnected on the next protection check.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void ensureConnectedIfEnabledReconnectsWhenTunnelDies(@TempDir Path tempDir) throws Exception {
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

        TrackingVpnService service = new TrackingVpnService(new RavenSettingsService(brokerClient, logger, List.of()), logger);
        service.ensureConnectedIfEnabled();
        service.lastProcess().alive(false);
        service.ensureConnectedIfEnabled();

        assertEquals(2, service.startCount());
    }

    /**
     * Verify status notices a dead OpenVPN process and deletes credential
     * scratch files.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the fixture cannot be prepared
     */
    @Test
    void statusClearsDeadProcessAndCredentialFiles(@TempDir Path tempDir) throws Exception {
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

        TrackingVpnService service = new TrackingVpnService(new RavenSettingsService(brokerClient, logger, List.of()), logger);
        service.ensureConnectedIfEnabled();
        try (java.util.stream.Stream<Path> files = Files.list(tempDir.resolve("vpn").resolve("pia"))) {
            assertTrue(files.anyMatch((path) -> path.getFileName().toString().startsWith("credentials-")));
        }

        service.lastProcess().alive(false);
        Map<String, Object> status = service.status();

        assertEquals(false, status.get("connected"));
        try (java.util.stream.Stream<Path> files = Files.list(tempDir.resolve("vpn").resolve("pia"))) {
            assertTrue(files.noneMatch((path) -> path.getFileName().toString().startsWith("credentials-")));
        }
    }

    /**
     * Verify a corrupt or partial PIA archive response is rejected before it
     * can replace the last known good cached profile archive.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the fixture cannot start the local archive server
     */
    @Test
    void downloadArchiveKeepsLastGoodArchiveWhenFreshDownloadIsCorrupt(@TempDir Path tempDir) throws Exception {
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        writeProfileArchive(tempDir, Map.of("us_california.ovpn", "client"));
        Path archivePath = tempDir.resolve("vpn").resolve("pia").resolve("openvpn-ip.zip");
        byte[] originalArchive = Files.readAllBytes(archivePath);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/openvpn.zip", (exchange) -> {
            byte[] body = "not a zip".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream output = exchange.getResponseBody()) {
                output.write(body);
            }
        });
        server.start();
        try {
            URI archiveUri = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/openvpn.zip");
            ArchiveUriVpnService service = new ArchiveUriVpnService(
                new RavenSettingsService(new FakeRavenBrokerClient(), logger, List.of()),
                logger,
                archiveUri
            );

            IOException error = assertThrows(IOException.class, () -> service.downloadArchive(archivePath));

            assertTrue(error.getMessage().contains("corrupt") || error.getMessage().contains("OpenVPN profiles"));
            assertArrayEquals(originalArchive, Files.readAllBytes(archivePath));
        } finally {
            server.stop(0);
        }
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
        private final String runtimeProblem;
        private final AtomicInteger startCount = new AtomicInteger();
        private Instant currentInstant = Instant.parse("2026-01-01T00:00:00Z");
        private String lastProfileName = "";
        private final List<FakeProcess> processes = new java.util.ArrayList<>();

        private TrackingVpnService(RavenSettingsService settingsService, ScriptarrLogger logger) {
            this(settingsService, logger, "Initialization Sequence Completed", true);
        }

        private TrackingVpnService(RavenSettingsService settingsService, ScriptarrLogger logger, String processOutput) {
            this(settingsService, logger, processOutput, true);
        }

        private TrackingVpnService(RavenSettingsService settingsService, ScriptarrLogger logger, String processOutput, boolean alive) {
            this(settingsService, logger, processOutput, alive, "");
        }

        private TrackingVpnService(RavenSettingsService settingsService, ScriptarrLogger logger, String processOutput, boolean alive, String runtimeProblem) {
            super(settingsService, logger);
            this.processOutput = processOutput;
            this.alive = alive;
            this.runtimeProblem = runtimeProblem;
        }

        @Override
        protected Process startOpenVpnProcess(Path profile, Path credentialsFile) {
            startCount.incrementAndGet();
            lastProfileName = profile.getFileName().toString();
            FakeProcess process = new FakeProcess(processOutput, alive);
            processes.add(process);
            return process;
        }

        @Override
        protected String detectVpnRuntimeProblem() {
            return runtimeProblem;
        }

        @Override
        protected Instant now() {
            return currentInstant;
        }

        private void advance(Duration duration) {
            currentInstant = currentInstant.plus(duration);
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

        private FakeProcess lastProcess() {
            return processes.get(processes.size() - 1);
        }
    }

    /**
     * Test-specific VPN service that redirects profile archive downloads.
     */
    private static final class ArchiveUriVpnService extends VpnService {
        private final URI archiveUri;

        private ArchiveUriVpnService(RavenSettingsService settingsService, ScriptarrLogger logger, URI archiveUri) {
            super(settingsService, logger);
            this.archiveUri = archiveUri;
        }

        @Override
        protected URI profileArchiveUri() {
            return archiveUri;
        }
    }

    /**
     * Minimal process stub for Raven VPN tests.
     */
    private static final class FakeProcess extends Process {
        private final byte[] output;
        private boolean alive;
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

        private void alive(boolean nextAlive) {
            alive = nextAlive;
        }
    }

    /**
     * Broker client that can switch from normal VPN reads to a read outage.
     */
    private static final class SwitchableVpnBrokerClient implements RavenBrokerClient {
        private final com.fasterxml.jackson.databind.ObjectMapper objectMapper = new com.fasterxml.jackson.databind.ObjectMapper();
        private final Map<String, JsonNode> settings = new java.util.LinkedHashMap<>();
        private boolean failReads;

        private void setSetting(String key, Object value) {
            settings.put(key, objectMapper.valueToTree(Map.of("key", key, "value", value)));
        }

        private void failReads(boolean nextFailReads) {
            failReads = nextFailReads;
        }

        @Override
        public JsonNode getSetting(String key) throws IOException {
            if (failReads) {
                throw new IOException("settings offline");
            }
            return settings.getOrDefault(key, objectMapper.valueToTree(Map.of("error", "Setting not found.")));
        }

        @Override
        public JsonNode getSecret(String key) throws IOException {
            if (failReads) {
                throw new IOException("secrets offline");
            }
            return objectMapper.valueToTree(Map.of("key", key, "value", ""));
        }

        @Override
        public JsonNode getRequest(String requestId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode patchRequest(String requestId, Map<String, Object> payload) {
            throw new UnsupportedOperationException();
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
        public JsonNode deleteDownloadTask(String taskId) {
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
        public JsonNode getRequest(String requestId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JsonNode patchRequest(String requestId, Map<String, Object> payload) {
            throw new UnsupportedOperationException();
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
        public JsonNode deleteDownloadTask(String taskId) {
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
