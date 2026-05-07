package com.scriptarr.raven.vpn;

import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.settings.RavenVpnSettings;
import com.scriptarr.raven.support.ScriptarrLogger;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Manages optional PIA/OpenVPN sessions for Raven downloads.
 */
@Service
public class VpnService {
    private static final String PIA_OPENVPN_ZIP_URL = "https://www.privateinternetaccess.com/openvpn/openvpn-ip.zip";
    private static final Duration PROFILE_ARCHIVE_STALE_AFTER = Duration.ofDays(7);
    private static final Duration OPENVPN_START_TIMEOUT = Duration.ofSeconds(90);
    private static final Duration SETTINGS_REFRESH_INTERVAL = Duration.ofSeconds(15);
    private static final Duration STATUS_REFRESH_INTERVAL = Duration.ofSeconds(30);
    private static final Duration DISABLED_SETTINGS_GRACE = Duration.ofMinutes(5);
    private static final Duration RUNTIME_CHECK_INTERVAL = Duration.ofMinutes(1);
    private static final int MAX_RECENT_LOG_LINES = 20;
    private static final int CONNECT_ATTEMPTS = 3;

    private final RavenSettingsService settingsService;
    private final ScriptarrLogger logger;
    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build();

    private final Deque<String> recentLogLines = new ArrayDeque<>();

    private Process openVpnProcess;
    private volatile boolean connected;
    private volatile String activeRegion = "";
    private volatile String lastError = "";
    private volatile String lastSettingsError = "";
    private volatile String lastRuntimeError = "";
    private volatile RavenVpnSettings lastKnownSettings = new RavenVpnSettings(false, "us_california", "", "");
    private volatile boolean hasLastKnownSettings;
    private volatile Instant lastSettingsLoadedAt = Instant.EPOCH;
    private volatile Instant lastSettingsRefreshAttemptAt = Instant.EPOCH;
    private volatile Instant lastRuntimeCheckedAt = Instant.EPOCH;
    private volatile boolean lastRuntimeCapable;
    private volatile boolean connecting;
    private volatile Instant lastConnectionAttemptAt = Instant.EPOCH;
    private volatile Instant lastConnectedAt = Instant.EPOCH;
    private volatile Instant lastDisconnectedAt = Instant.EPOCH;
    private volatile String lastDisconnectReason = "";
    private Path activeCredentialsFile;

    /**
     * Create the VPN service.
     *
     * @param settingsService Raven settings service
     * @param logger shared Raven logger
     */
    public VpnService(RavenSettingsService settingsService, ScriptarrLogger logger) {
        this.settingsService = settingsService;
        this.logger = logger;
    }

    /**
     * Ensure an enabled VPN profile is connected before Raven starts a download.
     */
    public synchronized void ensureConnectedIfEnabled() {
        RavenVpnSettings settings = loadRequiredSettings();
        if (!settings.enabled()) {
            if (openVpnProcess != null && openVpnProcess.isAlive()) {
                destroyActiveProcess("VPN disabled in settings.");
            }
            return;
        }
        if (settings.piaUsername().isBlank() || settings.piaPassword().isBlank()) {
            lastError = "PIA username and password are required before Raven can use VPN-backed downloads.";
            throw new IllegalStateException(lastError);
        }
        String runtimeProblem = vpnRuntimeProblem();
        if (!runtimeProblem.isBlank()) {
            lastError = runtimeProblem;
            throw new IllegalStateException(runtimeProblem);
        }

        String requestedRegion = normalizeRegionKey(settings.region());
        if (canReuseActiveConnection(requestedRegion)) {
            return;
        }

        IllegalStateException lastFailure = null;
        connecting = true;
        try {
            for (int attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
                lastConnectionAttemptAt = now();
                destroyActiveProcess(attempt == 1 ? "Preparing a fresh OpenVPN session." : "Retrying Raven VPN connection.");
                try {
                    Path profile = ensureProfile(requestedRegion);
                    Path credentialsFile = writeCredentials(settings);
                    openVpnProcess = startOpenVpnProcess(profile, credentialsFile);
                    activeCredentialsFile = credentialsFile;
                    consumeOutput(openVpnProcess.getInputStream());
                    waitForInitialization(requestedRegion);
                    connected = true;
                    activeRegion = requestedRegion;
                    lastConnectedAt = now();
                    lastDisconnectReason = "";
                    lastError = "";
                    logger.info("VPN", "PIA/OpenVPN connection ready.", "region=" + activeRegion);
                    return;
                } catch (Exception error) {
                    destroyActiveProcess("Cleaning up after VPN failure.");
                    connected = false;
                    activeRegion = "";
                    lastError = sanitizeError(error.getMessage() == null ? "Unknown VPN error." : error.getMessage());
                    lastFailure = new IllegalStateException(lastError, error);
                    logger.error("VPN", "Failed to establish PIA/OpenVPN session.", error);
                    if (isAuthenticationFailure(lastError.toLowerCase(Locale.ROOT)) || attempt == CONNECT_ATTEMPTS) {
                        break;
                    }
                    sleepBeforeReconnect();
                }
            }
        } finally {
            connecting = false;
        }
        throw lastFailure == null ? new IllegalStateException("Raven could not establish the VPN tunnel.") : lastFailure;
    }

    /**
     * Test the configured VPN path through the same fail-closed guard used by
     * downloads. If VPN is enabled, a successful test leaves OpenVPN connected
     * for later protected work.
     *
     * @return VPN test result with a refreshed status payload
     */
    public synchronized Map<String, Object> testConnection() {
        try {
            ensureConnectedIfEnabled();
            Map<String, Object> payload = status();
            payload.put("ok", true);
            return payload;
        } catch (Exception error) {
            lastError = sanitizeError(error.getMessage() == null ? "Raven VPN test failed." : error.getMessage());
            Map<String, Object> payload = status();
            payload.put("ok", false);
            payload.put("error", lastError);
            return payload;
        }
    }

    /**
     * Build the VPN status payload exposed by Raven health endpoints.
     *
     * @return VPN status snapshot
     */
    public synchronized Map<String, Object> status() {
        refreshSettingsForStatus();
        boolean enabled = hasLastKnownSettings && lastKnownSettings.enabled();
        String region = activeRegion;
        if (region.isBlank()) {
            region = normalizeRegionKey(lastKnownSettings.region());
        }

        if (openVpnProcess != null && !openVpnProcess.isAlive()) {
            destroyActiveProcess("OpenVPN process exited before status check.");
            lastError = "OpenVPN process exited.";
        }

        String runtimeProblem = vpnRuntimeProblem();
        boolean runtimeCapable = runtimeProblem.isBlank();
        boolean connectedNow = connected && openVpnProcess != null && openVpnProcess.isAlive();
        boolean settingsFresh = settingsFresh(now());
        String displayedError = enabled
            ? firstNonBlank(lastError, lastSettingsError, lastRuntimeError)
            : firstNonBlank(lastError, lastSettingsError);
        displayedError = sanitizeError(displayedError);
        String state = resolveState(enabled, connectedNow, runtimeCapable, settingsFresh, displayedError);
        Map<String, Object> payload = new HashMap<>();
        payload.put("state", state);
        payload.put("enabled", enabled);
        payload.put("connected", connectedNow);
        payload.put("protected", enabled && connectedNow && runtimeCapable);
        payload.put("settingsFresh", settingsFresh);
        payload.put("runtimeCapable", runtimeCapable);
        payload.put("region", region.isBlank() ? "us_california" : region);
        payload.put("lastCheckedAt", now().toString());
        payload.put("settingsLastLoadedAt", hasLastKnownSettings ? lastSettingsLoadedAt.toString() : "");
        payload.put("lastConnectionAttemptAt", instantOrBlank(lastConnectionAttemptAt));
        payload.put("lastConnectedAt", instantOrBlank(lastConnectedAt));
        payload.put("lastDisconnectedAt", instantOrBlank(lastDisconnectedAt));
        payload.put("lastDisconnectReason", sanitizeError(lastDisconnectReason));
        payload.put("lastError", displayedError);
        return payload;
    }

    /**
     * Stop the active OpenVPN process during shutdown.
     */
    @PreDestroy
    public synchronized void stop() {
        destroyActiveProcess("Stopping Raven VPN.");
    }

    /**
     * Ensure Raven has a current OpenVPN profile for the requested region.
     *
     * @param region requested PIA region key
     * @return path to the resolved profile
     * @throws IOException when the profile archive cannot be prepared
     * @throws InterruptedException when the network request is interrupted
     */
    protected Path ensureProfile(String region) throws IOException, InterruptedException {
        Path vpnRoot = logger.getDownloadsRoot().resolve("vpn").resolve("pia");
        Path archivePath = vpnRoot.resolve("openvpn-ip.zip");
        Path profilesRoot = vpnRoot.resolve("profiles");
        Files.createDirectories(profilesRoot);

        boolean archiveMissing = !Files.exists(archivePath);
        boolean profilesMissing = profilesAreMissing(profilesRoot);
        boolean archiveStale = isArchiveStale(archivePath);
        if (archiveMissing || (profilesMissing && archiveStale)) {
            downloadArchive(archivePath);
        }
        if (profilesMissing) {
            extractProfiles(archivePath, profilesRoot, true);
        }

        Path profile = findExactRegionProfile(profilesRoot, region);
        if (profile != null) {
            return profile;
        }

        if (Files.exists(archivePath)) {
            extractProfiles(archivePath, profilesRoot, true);
            profile = findExactRegionProfile(profilesRoot, region);
            if (profile != null) {
                return profile;
            }
        }

        downloadArchive(archivePath);
        extractProfiles(archivePath, profilesRoot, true);
        profile = findExactRegionProfile(profilesRoot, region);
        if (profile != null) {
            return profile;
        }
        throw new IOException("PIA region profile not found: " + region);
    }

    /**
     * Start the OpenVPN process for a resolved profile and credential file.
     *
     * @param profile resolved profile path
     * @param credentialsFile short-lived credentials file
     * @return started process
     * @throws IOException when OpenVPN cannot be started
     */
    protected Process startOpenVpnProcess(Path profile, Path credentialsFile) throws IOException {
        ProcessBuilder builder = new ProcessBuilder(
            "openvpn",
            "--config",
            profile.toString(),
            "--auth-user-pass",
            credentialsFile.toString(),
            "--auth-nocache"
        );
        builder.redirectErrorStream(true);
        return builder.start();
    }

    /**
     * Download the current PIA OpenVPN profile archive.
     *
     * @param archivePath target archive path
     * @throws IOException when the archive cannot be downloaded
     * @throws InterruptedException when the request is interrupted
     */
    protected void downloadArchive(Path archivePath) throws IOException, InterruptedException {
        Files.createDirectories(archivePath.getParent());
        Path tempArchive = Files.createTempFile(archivePath.getParent(), "openvpn-ip-", ".zip.tmp");
        HttpRequest request = HttpRequest.newBuilder()
            .uri(profileArchiveUri())
            .timeout(Duration.ofSeconds(60))
            .GET()
            .build();
        try {
            HttpResponse<InputStream> response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new IOException("PIA OpenVPN profile download failed with status " + response.statusCode());
            }
            Files.copy(response.body(), tempArchive, StandardCopyOption.REPLACE_EXISTING);
            validateProfileArchive(tempArchive);
            moveArchiveIntoPlace(tempArchive, archivePath);
        } finally {
            Files.deleteIfExists(tempArchive);
        }
    }

    /**
     * Resolve the PIA OpenVPN archive URI, overridable for download tests.
     *
     * @return PIA profile archive URI
     */
    protected URI profileArchiveUri() {
        return URI.create(PIA_OPENVPN_ZIP_URL);
    }

    private RavenVpnSettings loadRequiredSettings() {
        Instant now = now();
        if (hasLastKnownSettings && Duration.between(lastSettingsLoadedAt, now).compareTo(SETTINGS_REFRESH_INTERVAL) <= 0) {
            return lastKnownSettings;
        }
        try {
            RavenVpnSettings settings = settingsService.requireVpnSettings();
            lastKnownSettings = settings;
            hasLastKnownSettings = true;
            lastSettingsLoadedAt = now();
            lastSettingsRefreshAttemptAt = lastSettingsLoadedAt;
            lastSettingsError = "";
            return settings;
        } catch (Exception error) {
            lastSettingsRefreshAttemptAt = now();
            lastSettingsError = error.getMessage() == null ? "Failed to load Raven VPN settings." : error.getMessage();
            if (hasFreshDisabledSettingsCache()) {
                logger.warn("VPN", "Raven could not refresh VPN settings and will keep the fresh last-known disabled state.", lastSettingsError);
                return lastKnownSettings;
            }
            String message = hasLastKnownSettings && lastKnownSettings.enabled()
                ? "Failed to load Raven VPN settings while VPN is enabled."
                : "Failed to load Raven VPN settings.";
            throw new IllegalStateException(message, error);
        }
    }

    private void refreshSettingsForStatus() {
        Instant now = now();
        if (Duration.between(lastSettingsRefreshAttemptAt, now).compareTo(STATUS_REFRESH_INTERVAL) < 0) {
            return;
        }
        try {
            RavenVpnSettings settings = settingsService.requireVpnSettings();
            lastKnownSettings = settings;
            hasLastKnownSettings = true;
            lastSettingsLoadedAt = now;
            lastSettingsRefreshAttemptAt = now;
            lastSettingsError = "";
        } catch (Exception error) {
            lastSettingsRefreshAttemptAt = now;
            lastSettingsError = error.getMessage() == null ? "Failed to load Raven VPN settings." : error.getMessage();
            logger.warn("VPN", "Raven could not refresh VPN settings for status.", lastSettingsError);
        }
    }

    private boolean hasFreshDisabledSettingsCache() {
        return hasLastKnownSettings
            && !lastKnownSettings.enabled()
            && settingsFresh(now());
    }

    private boolean settingsFresh(Instant now) {
        return hasLastKnownSettings
            && Duration.between(lastSettingsLoadedAt, now).compareTo(DISABLED_SETTINGS_GRACE) <= 0;
    }

    private boolean canReuseActiveConnection(String requestedRegion) {
        if (!connected || openVpnProcess == null || !openVpnProcess.isAlive()) {
            return false;
        }
        return normalizeRegionKey(activeRegion).equals(requestedRegion);
    }

    private String resolveState(boolean enabled, boolean connectedNow, boolean runtimeCapable, boolean settingsFresh, String displayedError) {
        if (!enabled) {
            return "disabled";
        }
        if (!runtimeCapable) {
            return "runtime_unsupported";
        }
        if (!settingsFresh) {
            return "settings_stale";
        }
        if (connectedNow) {
            return "protected";
        }
        if (connecting || (openVpnProcess != null && openVpnProcess.isAlive())) {
            return "connecting";
        }
        if (!displayedError.isBlank()) {
            return "failed";
        }
        return "armed";
    }

    private String vpnRuntimeProblem() {
        Instant now = now();
        if (Duration.between(lastRuntimeCheckedAt, now).compareTo(RUNTIME_CHECK_INTERVAL) < 0) {
            return lastRuntimeCapable ? "" : lastRuntimeError;
        }
        lastRuntimeCheckedAt = now;
        lastRuntimeError = detectVpnRuntimeProblem();
        lastRuntimeCapable = lastRuntimeError.isBlank();
        return lastRuntimeError;
    }

    /**
     * Detect whether the current container can run OpenVPN with a TUN device.
     *
     * @return blank when supported, otherwise a human-readable runtime problem
     */
    protected String detectVpnRuntimeProblem() {
        if (!Files.exists(Path.of("/dev/net/tun"))) {
            return "Raven VPN runtime is missing /dev/net/tun in the container.";
        }
        if (!hasNetAdminCapability()) {
            return "Raven VPN runtime is missing NET_ADMIN.";
        }
        if (!openVpnBinaryAvailable()) {
            return "Raven VPN runtime is missing openvpn.";
        }
        return "";
    }

    /**
     * Resolve the current timestamp, overridable by deterministic tests.
     *
     * @return current instant
     */
    protected Instant now() {
        return Instant.now();
    }

    private boolean hasNetAdminCapability() {
        Path statusPath = Path.of("/proc/self/status");
        if (!Files.exists(statusPath)) {
            return false;
        }
        try (Stream<String> lines = Files.lines(statusPath, StandardCharsets.UTF_8)) {
            return lines
                .filter((line) -> line.startsWith("CapEff:"))
                .findFirst()
                .map((line) -> line.replace("CapEff:", "").trim())
                .filter((hex) -> !hex.isBlank())
                .map((hex) -> new BigInteger(hex, 16).testBit(12))
                .orElse(false);
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean openVpnBinaryAvailable() {
        try {
            Process process = new ProcessBuilder("openvpn", "--version")
                .redirectErrorStream(true)
                .start();
            boolean finished = process.waitFor(2, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return false;
            }
            return process.exitValue() == 0;
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean profilesAreMissing(Path profilesRoot) throws IOException {
        try (Stream<Path> files = Files.list(profilesRoot)) {
            return files.noneMatch((path) -> path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".ovpn"));
        }
    }

    private boolean isArchiveStale(Path archivePath) {
        if (!Files.exists(archivePath)) {
            return true;
        }
        try {
            Instant lastModified = Files.getLastModifiedTime(archivePath).toInstant();
            return lastModified.isBefore(now().minus(PROFILE_ARCHIVE_STALE_AFTER));
        } catch (IOException ignored) {
            return true;
        }
    }

    private Path findExactRegionProfile(Path profilesRoot, String region) throws IOException {
        try (Stream<Path> paths = Files.walk(profilesRoot)) {
            return paths
                .filter((path) -> path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".ovpn"))
                .sorted(Comparator.comparing((Path path) -> path.getFileName().toString()))
                .filter((path) -> normalizeRegionKey(path.getFileName().toString().replaceFirst("(?i)\\.ovpn$", "")).equals(region))
                .findFirst()
                .orElse(null);
        }
    }

    private void extractProfiles(Path archivePath, Path profilesRoot, boolean replaceExisting) throws IOException {
        if (!Files.exists(archivePath)) {
            throw new IOException("PIA profile archive is missing.");
        }
        validateProfileArchive(archivePath);

        if (replaceExisting) {
            try (Stream<Path> files = Files.list(profilesRoot)) {
                for (Path path : files.filter((entry) -> entry.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".ovpn")).toList()) {
                    Files.deleteIfExists(path);
                }
            }
        }

        try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(archivePath))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory() || !entry.getName().toLowerCase(Locale.ROOT).endsWith(".ovpn")) {
                    continue;
                }
                Path output = profilesRoot.resolve(Path.of(entry.getName()).getFileName().toString());
                Files.copy(zip, output, StandardCopyOption.REPLACE_EXISTING);
            }
        }
    }

    private void validateProfileArchive(Path archivePath) throws IOException {
        int profiles = 0;
        try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(archivePath))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (!entry.isDirectory() && entry.getName().toLowerCase(Locale.ROOT).endsWith(".ovpn")) {
                    profiles += 1;
                }
            }
        } catch (IOException error) {
            throw new IOException("PIA profile archive is corrupt or incomplete.", error);
        }
        if (profiles == 0) {
            throw new IOException("PIA profile archive did not contain any OpenVPN profiles.");
        }
    }

    private void moveArchiveIntoPlace(Path tempArchive, Path archivePath) throws IOException {
        try {
            Files.move(tempArchive, archivePath, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException atomicMoveError) {
            Files.move(tempArchive, archivePath, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private Path writeCredentials(RavenVpnSettings settings) throws IOException {
        Path credentialsRoot = logger.getDownloadsRoot().resolve("vpn").resolve("pia");
        Files.createDirectories(credentialsRoot);
        Path credentialsPath = Files.createTempFile(credentialsRoot, "credentials-", ".txt");
        try (BufferedWriter writer = Files.newBufferedWriter(credentialsPath, StandardCharsets.UTF_8)) {
            writer.write(settings.piaUsername());
            writer.newLine();
            writer.write(settings.piaPassword());
            writer.newLine();
        }
        tightenCredentialPermissions(credentialsPath);
        return credentialsPath;
    }

    private void tightenCredentialPermissions(Path credentialsPath) {
        try {
            Files.setPosixFilePermissions(credentialsPath, Set.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE
            ));
        } catch (Exception ignored) {
        }
    }

    private void consumeOutput(InputStream stream) {
        Thread reader = new Thread(() -> {
            try (BufferedReader input = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = input.readLine()) != null) {
                    recordLogLine(line);
                    String normalized = line.toLowerCase(Locale.ROOT);
                    if (normalized.contains("initialization sequence completed")) {
                        connected = true;
                    }
                    if (isAuthenticationFailure(normalized)) {
                        lastError = "PIA authentication failed.";
                    }
                }
            } catch (IOException ignored) {
            }
        });
        reader.setDaemon(true);
        reader.start();
    }

    private void recordLogLine(String line) {
        String sanitized = Optional.ofNullable(line).orElse("").replaceAll("[\\r\\n]+", " ").trim();
        if (sanitized.isBlank()) {
            return;
        }
        synchronized (recentLogLines) {
            recentLogLines.addLast(sanitized);
            while (recentLogLines.size() > MAX_RECENT_LOG_LINES) {
                recentLogLines.removeFirst();
            }
        }
    }

    private boolean isAuthenticationFailure(String normalizedLine) {
        return normalizedLine.contains("auth failed")
            || normalizedLine.contains("authentication failed")
            || normalizedLine.contains("auth-failure")
            || normalizedLine.contains("user auth failed");
    }

    private void waitForInitialization(String requestedRegion) throws InterruptedException {
        long deadline = System.currentTimeMillis() + OPENVPN_START_TIMEOUT.toMillis();
        while (System.currentTimeMillis() < deadline) {
            if (connected && openVpnProcess != null && openVpnProcess.isAlive()) {
                return;
            }
            if (lastError != null && !lastError.isBlank()) {
                throw new IllegalStateException(lastError + recentLogPreview());
            }
            if (openVpnProcess == null || !openVpnProcess.isAlive()) {
                throw new IllegalStateException("OpenVPN exited before initialization completed." + recentLogPreview());
            }
            Thread.sleep(500L);
        }
        throw new IllegalStateException("OpenVPN did not complete initialization in time for region " + requestedRegion + "." + recentLogPreview());
    }

    private String recentLogPreview() {
        synchronized (recentLogLines) {
            if (recentLogLines.isEmpty()) {
                return "";
            }
            return " Recent logs: " + String.join(" | ", List.copyOf(recentLogLines));
        }
    }

    private void destroyActiveProcess(String reason) {
        if (!reason.isBlank()) {
            logger.debug("VPN", reason);
        }
        if (openVpnProcess != null || connected) {
            lastDisconnectedAt = now();
            lastDisconnectReason = sanitizeError(reason);
        }
        connected = false;
        lastError = "";
        activeRegion = "";
        synchronized (recentLogLines) {
            recentLogLines.clear();
        }
        if (openVpnProcess != null) {
            openVpnProcess.destroyForcibly();
            openVpnProcess = null;
        }
        if (activeCredentialsFile != null) {
            try {
                Files.deleteIfExists(activeCredentialsFile);
            } catch (IOException ignored) {
            }
            activeCredentialsFile = null;
        }
        deleteCredentialFiles();
    }

    private void deleteCredentialFiles() {
        Path credentialsRoot = logger.getDownloadsRoot().resolve("vpn").resolve("pia");
        if (!Files.exists(credentialsRoot)) {
            return;
        }
        try (Stream<Path> files = Files.list(credentialsRoot)) {
            for (Path path : files.filter((entry) -> entry.getFileName().toString().startsWith("credentials-")).toList()) {
                Files.deleteIfExists(path);
            }
        } catch (IOException ignored) {
        }
    }

    private void sleepBeforeReconnect() {
        try {
            Thread.sleep(1000L);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while retrying the Raven VPN connection.", interrupted);
        }
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            String normalized = Optional.ofNullable(value).orElse("").trim();
            if (!normalized.isBlank()) {
                return normalized;
            }
        }
        return "";
    }

    private String instantOrBlank(Instant instant) {
        return instant == null || Instant.EPOCH.equals(instant) ? "" : instant.toString();
    }

    private String sanitizeError(String value) {
        String normalized = Optional.ofNullable(value).orElse("")
            .replaceAll("[\\r\\n\\t]+", " ")
            .replaceAll("\\s+", " ")
            .trim();
        if (normalized.length() > 500) {
            return normalized.substring(0, 500) + "...";
        }
        return normalized;
    }

    private String normalizeRegionKey(String region) {
        String normalized = Optional.ofNullable(region).orElse("us_california")
            .trim()
            .toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9]+", "_")
            .replaceAll("^_+", "")
            .replaceAll("_+$", "")
            .replaceAll("_+", "_");
        return normalized.isBlank() ? "us_california" : normalized;
    }
}
