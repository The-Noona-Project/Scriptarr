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
    private static final int MAX_RECENT_LOG_LINES = 20;

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
    private volatile RavenVpnSettings lastKnownSettings = new RavenVpnSettings(false, "us_california", "", "");
    private volatile boolean hasLastKnownSettings;
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
            throw new IllegalStateException("PIA username and password are required before Raven can use VPN-backed downloads.");
        }

        String requestedRegion = normalizeRegionKey(settings.region());
        if (canReuseActiveConnection(requestedRegion)) {
            return;
        }

        destroyActiveProcess("Preparing a fresh OpenVPN session.");
        try {
            Path profile = ensureProfile(requestedRegion);
            Path credentialsFile = writeCredentials(settings);
            openVpnProcess = startOpenVpnProcess(profile, credentialsFile);
            activeCredentialsFile = credentialsFile;
            consumeOutput(openVpnProcess.getInputStream());
            waitForInitialization(requestedRegion);
            connected = true;
            activeRegion = requestedRegion;
            lastError = "";
            logger.info("VPN", "PIA/OpenVPN connection ready.", "region=" + activeRegion);
        } catch (Exception error) {
            destroyActiveProcess("Cleaning up after VPN failure.");
            connected = false;
            activeRegion = "";
            lastError = error.getMessage() == null ? "Unknown VPN error." : error.getMessage();
            logger.error("VPN", "Failed to establish PIA/OpenVPN session.", error);
            throw new IllegalStateException(lastError, error);
        }
    }

    /**
     * Build the VPN status payload exposed by Raven health endpoints.
     *
     * @return VPN status snapshot
     */
    public synchronized Map<String, Object> status() {
        boolean enabled = false;
        String region = activeRegion;
        try {
            RavenVpnSettings settings = settingsService.getVpnSettings();
            enabled = settings.enabled();
            if (region.isBlank()) {
                region = normalizeRegionKey(settings.region());
            }
        } catch (Exception ignored) {
        }

        if (openVpnProcess != null && !openVpnProcess.isAlive()) {
            connected = false;
        }

        Map<String, Object> payload = new HashMap<>();
        payload.put("enabled", enabled);
        payload.put("connected", connected && openVpnProcess != null && openVpnProcess.isAlive());
        payload.put("region", region.isBlank() ? "us_california" : region);
        payload.put("lastError", lastError);
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
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(PIA_OPENVPN_ZIP_URL))
            .timeout(Duration.ofSeconds(60))
            .GET()
            .build();
        HttpResponse<InputStream> response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IOException("PIA OpenVPN profile download failed with status " + response.statusCode());
        }
        Files.copy(response.body(), archivePath, StandardCopyOption.REPLACE_EXISTING);
    }

    private RavenVpnSettings loadRequiredSettings() {
        try {
            RavenVpnSettings settings = settingsService.requireVpnSettings();
            lastKnownSettings = settings;
            hasLastKnownSettings = true;
            return settings;
        } catch (Exception error) {
            if (hasLastKnownSettings && !lastKnownSettings.enabled()) {
                logger.warn("VPN", "Raven could not refresh VPN settings and will keep the last known disabled state.", error.getMessage());
                return lastKnownSettings;
            }
            String message = hasLastKnownSettings && lastKnownSettings.enabled()
                ? "Failed to load Raven VPN settings while VPN is enabled."
                : "Failed to load Raven VPN settings.";
            throw new IllegalStateException(message, error);
        }
    }

    private boolean canReuseActiveConnection(String requestedRegion) {
        if (!connected || openVpnProcess == null || !openVpnProcess.isAlive()) {
            return false;
        }
        return normalizeRegionKey(activeRegion).equals(requestedRegion);
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
            return lastModified.isBefore(Instant.now().minus(PROFILE_ARCHIVE_STALE_AFTER));
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
