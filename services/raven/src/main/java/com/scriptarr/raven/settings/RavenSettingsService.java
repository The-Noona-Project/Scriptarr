package com.scriptarr.raven.settings;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.metadata.MetadataProvider;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Loads Raven settings through Sage and merges them with local defaults.
 */
@Service
public class RavenSettingsService {
    private static final String VPN_KEY = "raven.vpn";
    private static final String VPN_PASSWORD_KEY = "raven.vpn.piaPassword";
    private static final String NAMING_KEY = "raven.naming";
    private static final String PROVIDERS_KEY = "raven.metadata.providers";

    private final RavenBrokerClient brokerClient;
    private final ScriptarrLogger logger;
    private final List<MetadataProvider> providers;

    @Value("${SCRIPTARR_COMICVINE_API_KEY:}")
    private String comicVineApiKeyEnv;

    @Value("${SCRIPTARR_MAL_CLIENT_ID:}")
    private String malClientIdEnv;

    /**
     * Create the settings service.
     *
     * @param brokerClient Sage-backed broker client used for shared settings and secrets
     * @param logger shared Raven logger
     * @param providers discovered metadata providers
     */
    public RavenSettingsService(RavenBrokerClient brokerClient, ScriptarrLogger logger, List<MetadataProvider> providers) {
        this.brokerClient = brokerClient;
        this.logger = logger;
        this.providers = List.copyOf(providers);
    }

    /**
     * Load Raven VPN settings, including the secret PIA password.
     *
     * @return normalized VPN settings
     */
    public RavenVpnSettings getVpnSettings() {
        try {
            return loadVpnSettings();
        } catch (Exception error) {
            logger.warn("SETTINGS", "Failed to load Raven VPN settings.", error.getMessage());
            return new RavenVpnSettings(false, "us_california", "", "");
        }
    }

    /**
     * Load Raven VPN settings and fail when the broker request cannot be completed.
     *
     * @return normalized VPN settings
     * @throws Exception when shared settings cannot be loaded
     */
    public RavenVpnSettings requireVpnSettings() throws Exception {
        return loadVpnSettings();
    }

    /**
     * Load Raven naming settings for chapter archives and page files.
     *
     * @return normalized naming settings
     */
    public RavenNamingSettings getNamingSettings() {
        try {
            JsonNode settingsNode = Optional.ofNullable(brokerClient.getSetting(NAMING_KEY).get("value")).orElse(null);
            RavenNamingSettings defaults = RavenNamingSettings.defaults();
            if (settingsNode == null || settingsNode.isMissingNode() || settingsNode.isNull()) {
                return defaults;
            }

            return new RavenNamingSettings(
                settingsNode.path("chapterTemplate").asText(defaults.chapterTemplate()),
                settingsNode.path("pageTemplate").asText(defaults.pageTemplate()),
                settingsNode.path("pagePad").asInt(defaults.pagePad()),
                settingsNode.path("chapterPad").asInt(defaults.chapterPad()),
                settingsNode.path("volumePad").asInt(defaults.volumePad())
            ).normalized();
        } catch (Exception error) {
            logger.warn("SETTINGS", "Failed to load Raven naming settings.", error.getMessage());
            return RavenNamingSettings.defaults();
        }
    }

    /**
     * Load the metadata provider settings that Moon admin should display.
     *
     * @return provider settings sorted by priority
     */
    public List<Map<String, Object>> getMetadataProviderSettings() {
        Map<String, JsonNode> configuredById = new HashMap<>();
        try {
            JsonNode settingsNode = Optional.ofNullable(brokerClient.getSetting(PROVIDERS_KEY).get("value")).orElse(null);
            if (settingsNode != null && settingsNode.path("providers").isArray()) {
                for (JsonNode providerNode : settingsNode.path("providers")) {
                    configuredById.put(normalize(providerNode.path("id").asText(""), ""), providerNode);
                }
            }
        } catch (Exception error) {
            logger.warn("SETTINGS", "Failed to load Raven metadata provider settings.", error.getMessage());
        }

        List<Map<String, Object>> normalized = new ArrayList<>();
        for (MetadataProvider provider : providers) {
            JsonNode configured = configuredById.get(provider.id());
            int defaultPriority = switch (provider.id()) {
                case "mangadex" -> 10;
                case "anilist" -> 20;
                case "mangaupdates" -> 30;
                case "mal" -> 40;
                case "comicvine" -> 50;
                default -> 100;
            };
            boolean enabled = configured != null ? configured.path("enabled").asBoolean("mangadex".equals(provider.id())) : "mangadex".equals(provider.id());
            int priority = configured != null && configured.path("priority").canConvertToInt()
                ? configured.path("priority").asInt(defaultPriority)
                : defaultPriority;
            if ("comicvine".equals(provider.id()) && getComicVineApiKey().isBlank()) {
                enabled = false;
            }
            if ("mal".equals(provider.id()) && getMalClientId().isBlank()) {
                enabled = false;
            }
            normalized.add(new HashMap<>(Map.of(
                "id", provider.id(),
                "name", provider.name(),
                "scopes", provider.scopes(),
                "enabled", enabled,
                "priority", priority
            )));
        }
        normalized.sort(Comparator.comparingInt(entry -> (Integer) entry.get("priority")));
        return List.copyOf(normalized);
    }

    /**
     * Check whether a specific metadata provider is enabled.
     *
     * @param providerId provider id to resolve
     * @return {@code true} when the provider is enabled
     */
    public boolean isMetadataProviderEnabled(String providerId) {
        return getMetadataProviderSettings().stream()
            .filter(entry -> providerId.equalsIgnoreCase(String.valueOf(entry.get("id"))))
            .findFirst()
            .map(entry -> Boolean.TRUE.equals(entry.get("enabled")))
            .orElse(false);
    }

    /**
     * Resolve the ComicVine API key from Raven's process environment.
     *
     * @return trimmed ComicVine API key or an empty string
     */
    public String getComicVineApiKey() {
        return comicVineApiKeyEnv == null ? "" : comicVineApiKeyEnv.trim();
    }

    /**
     * Resolve the MyAnimeList client id from Raven's process environment.
     *
     * @return trimmed MAL client id or an empty string
     */
    public String getMalClientId() {
        return malClientIdEnv == null ? "" : malClientIdEnv.trim();
    }

    private String normalize(String value, String fallback) {
        String normalized = value == null ? "" : value.trim();
        return normalized.isBlank() ? fallback : normalized;
    }

    private RavenVpnSettings loadVpnSettings() throws Exception {
        JsonNode settingsNode = Optional.ofNullable(brokerClient.getSetting(VPN_KEY).get("value")).orElse(null);
        JsonNode passwordNode = Optional.ofNullable(brokerClient.getSecret(VPN_PASSWORD_KEY).get("value")).orElse(null);
        boolean enabled = settingsNode != null && settingsNode.path("enabled").asBoolean(false);
        String region = settingsNode != null ? normalize(settingsNode.path("region").asText("us_california"), "us_california") : "us_california";
        String piaUsername = settingsNode != null ? normalize(settingsNode.path("piaUsername").asText(""), "") : "";
        String piaPassword = passwordNode != null ? normalize(passwordNode.asText(""), "") : "";
        return new RavenVpnSettings(enabled, region, piaUsername, piaPassword);
    }
}
