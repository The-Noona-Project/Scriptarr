package com.scriptarr.raven.downloader.providers;

import com.scriptarr.raven.settings.RavenSettingsService;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * Registry and settings-aware selector for Raven download providers.
 */
@Service
public class DownloadProviderRegistry {
    private final List<DownloadProvider> providers;
    private final RavenSettingsService settingsService;

    /**
     * Create the provider registry.
     *
     * @param providers discovered provider beans
     * @param settingsService shared Raven settings
     */
    public DownloadProviderRegistry(List<DownloadProvider> providers, RavenSettingsService settingsService) {
        this.providers = List.copyOf(providers);
        this.settingsService = settingsService;
    }

    /**
     * List every download provider that is currently enabled.
     *
     * @return enabled providers
     */
    public List<DownloadProvider> enabledProviders() {
        return providers.stream()
            .filter((provider) -> settingsService.isDownloadProviderEnabled(provider.id()))
            .toList();
    }

    /**
     * Resolve a provider by id without applying URL heuristics.
     *
     * @param providerId provider id to resolve
     * @return matching provider when present
     */
    public Optional<DownloadProvider> getById(String providerId) {
        if (providerId == null || providerId.isBlank()) {
            return Optional.empty();
        }
        String normalized = providerId.trim().toLowerCase(Locale.ROOT);
        return providers.stream()
            .filter((provider) -> provider.id().equalsIgnoreCase(normalized))
            .findFirst();
    }

    /**
     * Resolve the best provider for a queue request.
     *
     * @param providerId explicit provider id, when already selected
     * @param titleUrl title URL to inspect
     * @return matching enabled provider
     */
    public Optional<DownloadProvider> resolve(String providerId, String titleUrl) {
        Optional<DownloadProvider> explicit = getById(providerId)
            .filter((provider) -> settingsService.isDownloadProviderEnabled(provider.id()));
        if (explicit.isPresent()) {
            return explicit;
        }

        return enabledProviders().stream()
            .filter((provider) -> provider.supportsUrl(titleUrl))
            .findFirst();
    }
}
