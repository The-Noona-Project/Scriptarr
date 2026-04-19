package com.scriptarr.raven.vpn;

import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.settings.RavenVpnSettings;
import com.scriptarr.raven.support.ScriptarrLogger;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Service;

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
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Manages optional PIA/OpenVPN sessions for Raven downloads.
 */
@Service
public class VpnService {
    private static final String PIA_OPENVPN_ZIP_URL = "https://www.privateinternetaccess.com/openvpn/openvpn-ip.zip";

    private final RavenSettingsService settingsService;
    private final ScriptarrLogger logger;
    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build();

    private Process openVpnProcess;
    private volatile boolean connected;
    private volatile String activeRegion = "";
    private volatile String lastError = "";

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
        RavenVpnSettings settings = settingsService.getVpnSettings();
        if (!settings.enabled()) {
            return;
        }
        if (connected && openVpnProcess != null && openVpnProcess.isAlive()) {
            return;
        }
        if (settings.piaUsername().isBlank() || settings.piaPassword().isBlank()) {
            throw new IllegalStateException("PIA username and password are required before Raven can use VPN-backed downloads.");
        }

        try {
            Path profile = ensureProfile(settings.region());
            Path credentialsFile = writeCredentials(settings);
            ProcessBuilder builder = new ProcessBuilder(
                "openvpn",
                "--config",
                profile.toString(),
                "--auth-user-pass",
                credentialsFile.toString()
            );
            builder.redirectErrorStream(true);
            openVpnProcess = builder.start();
            consumeOutput(openVpnProcess.getInputStream());
            waitForInitialization();
            connected = true;
            activeRegion = settings.region();
            lastError = "";
            logger.info("VPN", "PIA/OpenVPN connection ready.", "region=" + activeRegion);
        } catch (Exception error) {
            connected = false;
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
    public Map<String, Object> status() {
        Map<String, Object> payload = new HashMap<>();
        payload.put("enabled", settingsService.getVpnSettings().enabled());
        payload.put("connected", connected && openVpnProcess != null && openVpnProcess.isAlive());
        payload.put("region", activeRegion.isBlank() ? settingsService.getVpnSettings().region() : activeRegion);
        payload.put("lastError", lastError);
        return payload;
    }

    /**
     * Stop the active OpenVPN process during shutdown.
     */
    @PreDestroy
    public synchronized void stop() {
        if (openVpnProcess != null) {
            openVpnProcess.destroyForcibly();
        }
    }

    private Path ensureProfile(String region) throws IOException, InterruptedException {
        Path vpnRoot = logger.getDownloadsRoot().resolve("vpn").resolve("pia");
        Path archivePath = vpnRoot.resolve("openvpn-ip.zip");
        Path profilesRoot = vpnRoot.resolve("profiles");
        Files.createDirectories(profilesRoot);

        if (!Files.exists(archivePath)) {
            downloadArchive(archivePath);
        }
        try (var files = Files.list(profilesRoot)) {
            if (files.findAny().isEmpty()) {
                extractProfiles(archivePath, profilesRoot);
            }
        }

        String normalizedRegion = Optional.ofNullable(region).orElse("us_california").trim().toLowerCase(Locale.ROOT);
        try (var paths = Files.walk(profilesRoot)) {
            return paths
                .filter(path -> path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".ovpn"))
                .filter(path -> path.getFileName().toString().toLowerCase(Locale.ROOT).contains(normalizedRegion))
                .findFirst()
                .orElseThrow(() -> new IOException("PIA region profile not found: " + normalizedRegion));
        }
    }

    private void downloadArchive(Path archivePath) throws IOException, InterruptedException {
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

    private void extractProfiles(Path archivePath, Path profilesRoot) throws IOException {
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
        Path credentialsPath = logger.getDownloadsRoot().resolve("vpn").resolve("pia").resolve("credentials.txt");
        Files.createDirectories(credentialsPath.getParent());
        try (BufferedWriter writer = Files.newBufferedWriter(credentialsPath, StandardCharsets.UTF_8)) {
            writer.write(settings.piaUsername());
            writer.newLine();
            writer.write(settings.piaPassword());
            writer.newLine();
        }
        return credentialsPath;
    }

    private void consumeOutput(InputStream stream) {
        Thread reader = new Thread(() -> {
            try (InputStreamReader input = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
                char[] buffer = new char[1024];
                int read;
                StringBuilder chunk = new StringBuilder();
                while ((read = input.read(buffer)) >= 0) {
                    chunk.append(buffer, 0, read);
                    String text = chunk.toString();
                    if (text.contains("Initialization Sequence Completed")) {
                        connected = true;
                    }
                    if (text.toLowerCase(Locale.ROOT).contains("auth failed")) {
                        lastError = "PIA authentication failed.";
                    }
                }
            } catch (IOException ignored) {
            }
        });
        reader.setDaemon(true);
        reader.start();
    }

    private void waitForInitialization() throws InterruptedException {
        long deadline = System.currentTimeMillis() + Duration.ofSeconds(90).toMillis();
        while (System.currentTimeMillis() < deadline) {
            if (connected) {
                return;
            }
            if (lastError != null && !lastError.isBlank()) {
                throw new IllegalStateException(lastError);
            }
            Thread.sleep(500L);
        }
        throw new IllegalStateException("OpenVPN did not complete initialization in time.");
    }
}
