package com.scriptarr.raven.downloader;

import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.LibraryNaming;
import com.scriptarr.raven.metadata.MetadataService;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Metadata-first Raven intake orchestration that resolves download-ready and
 * unavailable request candidates.
 */
@Service
public class DownloadIntakeService {
    private final MetadataService metadataService;
    private final DownloadProviderRegistry downloadProviderRegistry;

    /**
     * Create the Raven intake orchestration service.
     *
     * @param metadataService metadata-provider broker
     * @param downloadProviderRegistry download-provider registry
     */
    public DownloadIntakeService(MetadataService metadataService, DownloadProviderRegistry downloadProviderRegistry) {
        this.metadataService = metadataService;
        this.downloadProviderRegistry = downloadProviderRegistry;
    }

    /**
     * Search enabled metadata providers first, then try to resolve each match
     * against enabled download providers.
     *
     * @param query user-supplied intake search text
     * @return normalized request-intake matches
     */
    public List<Map<String, Object>> search(String query) {
        if (query == null || query.isBlank()) {
            return List.of();
        }

        List<Map<String, Object>> results = new ArrayList<>();
        for (Map<String, Object> metadataResult : metadataService.search(query, null)) {
            Map<String, Object> metadataSnapshot = buildMetadataSnapshot(metadataResult);
            Map<String, Object> downloadSnapshot = resolveDownloadSnapshot(query, metadataSnapshot);
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("metadataProviderId", stringValue(metadataSnapshot.get("provider")));
            entry.put("providerSeriesId", stringValue(metadataSnapshot.get("providerSeriesId")));
            entry.put("canonicalTitle", stringValue(metadataSnapshot.get("title")));
            entry.put("aliases", metadataSnapshot.getOrDefault("aliases", List.of()));
            entry.put("type", stringValue(metadataSnapshot.get("type")));
            entry.put("metadata", metadataSnapshot);
            entry.put("download", downloadSnapshot);
            entry.put("downloadProviderId", stringValue(downloadSnapshot == null ? "" : downloadSnapshot.get("providerId")));
            entry.put("titleUrl", stringValue(downloadSnapshot == null ? "" : downloadSnapshot.get("titleUrl")));
            entry.put("availability", downloadSnapshot == null ? "unavailable" : "available");
            results.add(entry);
        }

        results.sort((left, right) -> {
            String leftAvailability = stringValue(left.get("availability"));
            String rightAvailability = stringValue(right.get("availability"));
            if (!leftAvailability.equals(rightAvailability)) {
                return "available".equals(leftAvailability) ? -1 : 1;
            }
            return stringValue(left.get("canonicalTitle")).compareToIgnoreCase(stringValue(right.get("canonicalTitle")));
        });
        return List.copyOf(results);
    }

    private Map<String, Object> buildMetadataSnapshot(Map<String, Object> metadataResult) {
        String providerId = stringValue(metadataResult.get("provider"));
        String providerSeriesId = stringValue(metadataResult.get("providerSeriesId"));
        Map<String, Object> details = new LinkedHashMap<>(metadataService.seriesDetails(providerId, providerSeriesId));
        Set<String> aliases = new LinkedHashSet<>();
        aliases.add(stringValue(metadataResult.get("title")));
        aliases.add(stringValue(details.get("title")));
        Object rawAliases = details.get("aliases");
        if (rawAliases instanceof Iterable<?> iterable) {
            for (Object alias : iterable) {
                String value = stringValue(alias);
                if (!value.isBlank()) {
                    aliases.add(value);
                }
            }
        }

        String typeLabel = LibraryNaming.normalizeTypeLabel(firstNonBlank(
            stringValue(details.get("type")),
            stringValue(metadataResult.get("type")),
            "manga"
        ));

        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("provider", providerId);
        snapshot.put("providerSeriesId", providerSeriesId);
        snapshot.put("title", firstNonBlank(stringValue(details.get("title")), stringValue(metadataResult.get("title")), "Untitled"));
        snapshot.put("url", firstNonBlank(stringValue(details.get("url")), stringValue(metadataResult.get("url")), ""));
        snapshot.put("summary", stringValue(details.get("summary")));
        snapshot.put("coverUrl", firstNonBlank(
            stringValue(details.get("coverUrl")),
            stringValue(details.get("coverImageUrl")),
            stringValue(metadataResult.get("coverUrl"))
        ));
        snapshot.put("aliases", aliases.stream().filter((alias) -> !alias.isBlank()).toList());
        snapshot.put("type", typeLabel);
        snapshot.put("typeSlug", LibraryNaming.normalizeTypeSlug(typeLabel));
        snapshot.put("details", details);
        return snapshot;
    }

    private Map<String, Object> resolveDownloadSnapshot(String query, Map<String, Object> metadataSnapshot) {
        List<String> aliases = new ArrayList<>();
        aliases.add(stringValue(metadataSnapshot.get("title")));
        Object rawAliases = metadataSnapshot.get("aliases");
        if (rawAliases instanceof Iterable<?> iterable) {
            for (Object alias : iterable) {
                String value = stringValue(alias);
                if (!value.isBlank()) {
                    aliases.add(value);
                }
            }
        }
        aliases.add(query);

        Set<String> dedupedTerms = new LinkedHashSet<>();
        aliases.stream()
            .map((alias) -> alias == null ? "" : alias.trim())
            .filter((alias) -> !alias.isBlank())
            .forEach(dedupedTerms::add);

        for (DownloadProvider provider : downloadProviderRegistry.enabledProviders()) {
            Map<String, String> bestCandidate = null;
            int bestScore = Integer.MIN_VALUE;
            String matchedQuery = "";
            for (String term : dedupedTerms) {
                List<Map<String, String>> searchResults = provider.searchTitles(term);
                for (Map<String, String> candidate : searchResults) {
                    int score = scoreCandidate(metadataSnapshot, candidate, dedupedTerms);
                    if (score > bestScore) {
                        bestScore = score;
                        bestCandidate = candidate;
                        matchedQuery = term;
                    }
                }
                if (bestScore >= 100) {
                    break;
                }
            }

            if (bestCandidate != null && bestScore >= 60) {
                TitleDetails providerDetails = provider.getTitleDetails(stringValue(bestCandidate.get("href")));
                String typeLabel = LibraryNaming.normalizeTypeLabel(firstNonBlank(
                    providerDetails != null ? providerDetails.type() : "",
                    bestCandidate.get("type"),
                    stringValue(metadataSnapshot.get("type")),
                    "manga"
                ));
                Map<String, Object> snapshot = new LinkedHashMap<>();
                snapshot.put("providerId", provider.id());
                snapshot.put("providerName", provider.name());
                snapshot.put("titleName", firstNonBlank(bestCandidate.get("title"), stringValue(metadataSnapshot.get("title")), "Untitled"));
                snapshot.put("titleUrl", stringValue(bestCandidate.get("href")));
                snapshot.put("requestType", typeLabel);
                snapshot.put("libraryTypeLabel", typeLabel);
                snapshot.put("libraryTypeSlug", LibraryNaming.normalizeTypeSlug(typeLabel));
                snapshot.put("coverUrl", firstNonBlank(
                    stringValue(bestCandidate.get("coverUrl")),
                    stringValue(metadataSnapshot.get("coverUrl"))
                ));
                snapshot.put("nsfw", providerDetails != null && Boolean.TRUE.equals(providerDetails.adultContent()));
                snapshot.put("matchedQuery", matchedQuery);
                snapshot.put("matchScore", bestScore);
                return snapshot;
            }
        }

        return null;
    }

    private int scoreCandidate(Map<String, Object> metadataSnapshot, Map<String, String> candidate, Set<String> aliases) {
        String candidateTitle = normalizeTitle(candidate.get("title"));
        if (candidateTitle.isBlank()) {
            return Integer.MIN_VALUE;
        }

        int best = 0;
        for (String alias : aliases) {
            String normalizedAlias = normalizeTitle(alias);
            if (normalizedAlias.isBlank()) {
                continue;
            }
            if (candidateTitle.equals(normalizedAlias)) {
                best = Math.max(best, 120);
                continue;
            }
            if (candidateTitle.contains(normalizedAlias) || normalizedAlias.contains(candidateTitle)) {
                best = Math.max(best, 90);
                continue;
            }
            if (tokenOverlap(candidateTitle, normalizedAlias) >= 0.75d) {
                best = Math.max(best, 70);
            }
        }

        String metadataType = LibraryNaming.normalizeTypeSlug(stringValue(metadataSnapshot.get("type")));
        String candidateType = LibraryNaming.normalizeTypeSlug(firstNonBlank(candidate.get("type"), metadataType));
        if (!metadataType.isBlank() && metadataType.equals(candidateType)) {
            best += 5;
        }
        return best;
    }

    private double tokenOverlap(String left, String right) {
        Set<String> leftTokens = List.of(left.split("\\s+")).stream()
            .map(String::trim)
            .filter((token) -> !token.isBlank())
            .collect(Collectors.toCollection(LinkedHashSet::new));
        Set<String> rightTokens = List.of(right.split("\\s+")).stream()
            .map(String::trim)
            .filter((token) -> !token.isBlank())
            .collect(Collectors.toCollection(LinkedHashSet::new));
        if (leftTokens.isEmpty() || rightTokens.isEmpty()) {
            return 0d;
        }
        long matches = leftTokens.stream().filter(rightTokens::contains).count();
        return matches / (double) Math.max(leftTokens.size(), rightTokens.size());
    }

    private String normalizeTitle(String value) {
        return stringValue(value)
            .toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9]+", " ")
            .trim();
    }

    private String stringValue(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value.trim();
            }
        }
        return "";
    }
}
