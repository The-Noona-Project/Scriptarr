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

@Service
public class RavenSettingsService {
    private static final String VPN_KEY = "raven.vpn";
    private static final String VPN_PASSWORD_KEY = "raven.vpn.piaPassword";
    private static final String PROVIDERS_KEY = "raven.metadata.providers";

    private final RavenVaultClient vaultClient;
    private final ScriptarrLogger logger;
    private final List<MetadataProvider> providers;

    @Value("${SCRIPTARR_COMICVINE_API_KEY:}")
    private String comicVineApiKeyEnv;

    public RavenSettingsService(RavenVaultClient vaultClient, ScriptarrLogger logger, List<MetadataProvider> providers) {
        this.vaultClient = vaultClient;
        this.logger = logger;
        this.providers = List.copyOf(providers);
    }

    public RavenVpnSettings getVpnSettings() {
        try {
            JsonNode settingsNode = Optional.ofNullable(vaultClient.getSetting(VPN_KEY).get("value")).orElse(null);
            JsonNode passwordNode = Optional.ofNullable(vaultClient.getSecret(VPN_PASSWORD_KEY).get("value")).orElse(null);
            boolean enabled = settingsNode != null && settingsNode.path("enabled").asBoolean(false);
            String region = settingsNode != null ? normalize(settingsNode.path("region").asText("us_california"), "us_california") : "us_california";
            String piaUsername = settingsNode != null ? normalize(settingsNode.path("piaUsername").asText(""), "") : "";
            String piaPassword = passwordNode != null ? normalize(passwordNode.asText(""), "") : "";
            return new RavenVpnSettings(enabled, region, piaUsername, piaPassword);
        } catch (Exception error) {
            logger.warn("SETTINGS", "Failed to load Raven VPN settings.", error.getMessage());
            return new RavenVpnSettings(false, "us_california", "", "");
        }
    }

    public List<Map<String, Object>> getMetadataProviderSettings() {
        Map<String, JsonNode> configuredById = new HashMap<>();
        try {
            JsonNode settingsNode = Optional.ofNullable(vaultClient.getSetting(PROVIDERS_KEY).get("value")).orElse(null);
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
                case "comicvine" -> 30;
                default -> 100;
            };
            boolean enabled = configured != null ? configured.path("enabled").asBoolean("mangadex".equals(provider.id())) : "mangadex".equals(provider.id());
            int priority = configured != null && configured.path("priority").canConvertToInt()
                ? configured.path("priority").asInt(defaultPriority)
                : defaultPriority;
            if ("comicvine".equals(provider.id()) && getComicVineApiKey().isBlank()) {
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

    public boolean isMetadataProviderEnabled(String providerId) {
        return getMetadataProviderSettings().stream()
            .filter(entry -> providerId.equalsIgnoreCase(String.valueOf(entry.get("id"))))
            .findFirst()
            .map(entry -> Boolean.TRUE.equals(entry.get("enabled")))
            .orElse(false);
    }

    public String getComicVineApiKey() {
        return comicVineApiKeyEnv == null ? "" : comicVineApiKeyEnv.trim();
    }

    private String normalize(String value, String fallback) {
        String normalized = value == null ? "" : value.trim();
        return normalized.isBlank() ? fallback : normalized;
    }
}

