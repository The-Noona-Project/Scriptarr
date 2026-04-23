package com.scriptarr.raven.downloader;

import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.LibraryNaming;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.metadata.MetadataService;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Arrays;
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

        Map<String, GroupedIntakeResult> groupedResults = new LinkedHashMap<>();
        for (Map<String, Object> metadataResult : metadataService.search(query, null)) {
            Map<String, Object> metadataSnapshot = buildMetadataSnapshot(metadataResult);
            Map<String, Object> downloadSnapshot = resolveDownloadSnapshot(query, metadataSnapshot);
            String groupKey = buildWorkKey(metadataSnapshot, downloadSnapshot);
            groupedResults.computeIfAbsent(groupKey, (ignored) -> new GroupedIntakeResult(groupKey, downloadSnapshot))
                .add(metadataSnapshot, downloadSnapshot);
        }

        List<Map<String, Object>> results = groupedResults.values().stream()
            .map(GroupedIntakeResult::toPayload)
            .collect(Collectors.toCollection(ArrayList::new));
        results.sort((left, right) -> {
            String leftAvailability = stringValue(left.get("availability"));
            String rightAvailability = stringValue(right.get("availability"));
            if (!leftAvailability.equals(rightAvailability)) {
                return "available".equals(leftAvailability) ? -1 : 1;
            }
            int searchScoreDelta = Integer.compare(scoreSearchPayload(query, right), scoreSearchPayload(query, left));
            if (searchScoreDelta != 0) {
                return searchScoreDelta;
            }
            int matchScoreDelta = Integer.compare(resolveDownloadMatchScore(right), resolveDownloadMatchScore(left));
            if (matchScoreDelta != 0) {
                return matchScoreDelta;
            }
            int titleComparison = stringValue(left.get("canonicalTitle"))
                .compareToIgnoreCase(stringValue(right.get("canonicalTitle")));
            if (titleComparison != 0) {
                return titleComparison;
            }
            return stringValue(left.get("editionLabel")).compareToIgnoreCase(stringValue(right.get("editionLabel")));
        });
        return List.copyOf(results);
    }

    /**
     * Resolve a selected metadata row into Raven's normalized metadata snapshot.
     *
     * @param metadataSelection selected metadata-provider row
     * @return normalized metadata snapshot or an empty map when the selection is invalid
     */
    public Map<String, Object> resolveMetadataSelection(Map<String, Object> metadataSelection) {
        if (metadataSelection == null || metadataSelection.isEmpty()) {
            return Map.of();
        }

        String providerId = stringValue(metadataSelection.get("provider"));
        String providerSeriesId = stringValue(metadataSelection.get("providerSeriesId"));
        if (providerId.isBlank() || providerSeriesId.isBlank()) {
            return Map.of();
        }

        return Map.copyOf(buildMetadataSnapshot(metadataSelection));
    }

    /**
     * Resolve every concrete enabled download target that confidently matches a
     * selected metadata row.
     *
     * @param query optional user query that produced the selected metadata row
     * @param metadataSelection selected metadata-provider row
     * @return normalized payload with the resolved metadata snapshot and download options
     */
    public Map<String, Object> resolveDownloadOptions(String query, Map<String, Object> metadataSelection) {
        Map<String, Object> metadataSnapshot = resolveMetadataSelection(metadataSelection);
        if (metadataSnapshot.isEmpty()) {
            return Map.of(
                "query", stringValue(query),
                "selectedMetadata", Map.of(),
                "results", List.of(),
                "availability", "unavailable"
            );
        }

        List<Map<String, Object>> results = resolveConcreteDownloadOptions(query, metadataSnapshot);
        return Map.of(
            "query", stringValue(query),
            "selectedMetadata", metadataSnapshot,
            "results", results,
            "availability", results.isEmpty() ? "unavailable" : "available"
        );
    }

    /**
     * Resolve one confident metadata snapshot for a concrete provider target
     * discovered by Raven's bulk browse flow.
     *
     * @param providerId concrete download provider id
     * @param titleUrl concrete provider title URL
     * @param titleName concrete provider title label
     * @param requestedType provider-discovered type label
     * @return bulk metadata resolution outcome
     */
    public BulkMetadataResolution resolveBulkMetadata(String providerId, String titleUrl, String titleName, String requestedType) {
        String normalizedProviderId = stringValue(providerId);
        String normalizedTitleUrl = stringValue(titleUrl);
        String normalizedTitleName = stringValue(titleName);
        String normalizedRequestedType = LibraryNaming.normalizeTypeLabel(firstNonBlank(requestedType, "manga"));
        if (normalizedProviderId.isBlank() || normalizedTitleUrl.isBlank() || normalizedTitleName.isBlank()) {
            return BulkMetadataResolution.unmatchedResult();
        }

        Map<String, BulkMetadataCandidate> groupedCandidates = new LinkedHashMap<>();
        for (Map<String, Object> metadataResult : metadataService.search(normalizedTitleName, null)) {
            Map<String, Object> metadataSnapshot = buildMetadataSnapshot(metadataResult);
            Map<String, Object> downloadSnapshot = resolveDownloadSnapshot(normalizedTitleName, metadataSnapshot);
            if (!sameDownloadTarget(normalizedProviderId, normalizedTitleUrl, downloadSnapshot)) {
                continue;
            }

            int candidateScore = scoreBulkMetadataCandidate(metadataSnapshot, downloadSnapshot, normalizedTitleName, normalizedRequestedType);
            String candidateKey = buildBulkMetadataCandidateKey(metadataSnapshot, normalizedRequestedType);
            BulkMetadataCandidate existing = groupedCandidates.get(candidateKey);
            if (existing == null || candidateScore > existing.score()) {
                groupedCandidates.put(candidateKey, new BulkMetadataCandidate(
                    candidateScore,
                    Map.copyOf(metadataSnapshot),
                    Map.copyOf(downloadSnapshot)
                ));
            }
        }

        if (groupedCandidates.isEmpty()) {
            return BulkMetadataResolution.unmatchedResult();
        }

        List<BulkMetadataCandidate> rankedCandidates = groupedCandidates.values().stream()
            .sorted((left, right) -> Integer.compare(right.score(), left.score()))
            .toList();
        BulkMetadataCandidate best = rankedCandidates.getFirst();
        if (best.score() < 220) {
            return BulkMetadataResolution.unmatchedResult();
        }
        if (rankedCandidates.size() > 1 && (best.score() - rankedCandidates.get(1).score()) < 25) {
            return BulkMetadataResolution.ambiguousResult();
        }
        return BulkMetadataResolution.matched(best.metadataSnapshot(), best.downloadSnapshot());
    }

    /**
     * Resolve alternate concrete provider targets for an existing library title
     * so admins can inspect source coverage and queue a safe replacement.
     *
     * @param title existing Raven library title
     * @return one row per concrete provider target
     */
    public List<Map<String, Object>> repairOptions(LibraryTitle title) {
        if (title == null) {
            return List.of();
        }

        Map<String, Object> metadataSnapshot = buildLibraryMetadataSnapshot(title);
        Set<String> searchTerms = new LinkedHashSet<>();
        addSearchTerm(searchTerms, title.title());
        for (String alias : title.aliases()) {
            addSearchTerm(searchTerms, alias);
        }

        EditionSignals metadataEdition = detectEditionSignals(
            stringValue(metadataSnapshot.get("title")),
            stringValue(metadataSnapshot.get("editionLabel")),
            metadataSnapshot.get("aliases")
        );

        Map<String, RepairCandidate> candidates = new LinkedHashMap<>();
        for (DownloadProvider provider : downloadProviderRegistry.enabledProviders()) {
            boolean currentProvider = provider.supportsUrl(title.sourceUrl());
            if (currentProvider && !stringValue(title.sourceUrl()).isBlank()) {
                Map<String, String> currentSnapshot = new LinkedHashMap<>();
                currentSnapshot.put("title", title.title());
                currentSnapshot.put("href", title.sourceUrl());
                currentSnapshot.put("type", title.libraryTypeLabel());
                currentSnapshot.put("coverUrl", title.coverUrl());
                recordRepairCandidate(candidates, provider, metadataSnapshot, metadataEdition, currentSnapshot, 999, true, title);
            }

            for (String term : searchTerms) {
                for (Map<String, String> candidate : provider.searchTitles(term)) {
                    int score = scoreCandidate(metadataSnapshot, candidate, searchTerms, metadataEdition);
                    if (score < 45) {
                        continue;
                    }
                    recordRepairCandidate(candidates, provider, metadataSnapshot, metadataEdition, candidate, score, false, title);
                }
            }
        }

        return candidates.values().stream()
            .map((candidate) -> candidate.toPayload(title))
            .sorted((left, right) -> {
                boolean leftCurrent = Boolean.TRUE.equals(left.get("current"));
                boolean rightCurrent = Boolean.TRUE.equals(right.get("current"));
                if (leftCurrent != rightCurrent) {
                    return leftCurrent ? -1 : 1;
                }
                int coverageDelta = Integer.compare(parseInt(right.get("chapterCount")), parseInt(left.get("chapterCount")));
                if (coverageDelta != 0) {
                    return coverageDelta;
                }
                return Integer.compare(parseInt(right.get("matchScore")), parseInt(left.get("matchScore")));
            })
            .toList();
    }

    private void recordRepairCandidate(
        Map<String, RepairCandidate> candidates,
        DownloadProvider provider,
        Map<String, Object> metadataSnapshot,
        EditionSignals metadataEdition,
        Map<String, String> candidate,
        int score,
        boolean currentCandidate,
        LibraryTitle title
    ) {
        String titleUrl = stringValue(candidate.get("href"));
        if (titleUrl.isBlank()) {
            return;
        }
        String key = provider.id() + "::" + titleUrl;
        RepairCandidate existing = candidates.get(key);
        if (existing != null && existing.score() >= score && !(currentCandidate && !existing.current())) {
            return;
        }

        String candidateType = LibraryNaming.normalizeTypeLabel(firstNonBlank(candidate.get("type"), title.libraryTypeLabel(), "manga"));
        List<Map<String, String>> chapters = provider.getChapters(titleUrl);
        int chapterCount = chapters.size();
        String earliestChapter = chapters.stream()
            .map((entry) -> normalizeChapterNumber(entry.get("chapter_number")))
            .filter((value) -> !value.isBlank())
            .min(this::compareChapterNumbers)
            .orElse("");
        String latestChapter = chapters.stream()
            .map((entry) -> normalizeChapterNumber(entry.get("chapter_number")))
            .filter((value) -> !value.isBlank())
            .max(this::compareChapterNumbers)
            .orElse("");

        Map<String, Object> downloadSnapshot = new LinkedHashMap<>();
        downloadSnapshot.put("providerId", provider.id());
        downloadSnapshot.put("providerName", provider.name());
        downloadSnapshot.put("titleName", firstNonBlank(candidate.get("title"), title.title(), "Untitled"));
        downloadSnapshot.put("titleUrl", titleUrl);
        downloadSnapshot.put("requestType", candidateType);
        downloadSnapshot.put("libraryTypeLabel", candidateType);
        downloadSnapshot.put("libraryTypeSlug", LibraryNaming.normalizeTypeSlug(candidateType));
        downloadSnapshot.put("coverUrl", firstNonBlank(candidate.get("coverUrl"), title.coverUrl()));
        downloadSnapshot.put("matchScore", score);
        downloadSnapshot.put("editionLabel", firstNonBlank(
            detectEditionSignals(candidate.get("title"), candidate.get("href")).label(),
            metadataEdition.label()
        ));

        candidates.put(key, new RepairCandidate(
            score,
            currentCandidate,
            Map.copyOf(downloadSnapshot),
            chapterCount,
            earliestChapter,
            latestChapter,
            buildRepairWarnings(title, provider, titleUrl, chapterCount, score, metadataEdition, candidate)
        ));
    }

    private Map<String, Object> buildLibraryMetadataSnapshot(LibraryTitle title) {
        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("provider", stringValue(title.metadataProvider()));
        snapshot.put("providerSeriesId", stringValue(title.id()));
        snapshot.put("title", stringValue(title.title()));
        snapshot.put("summary", stringValue(title.summary()));
        snapshot.put("coverUrl", stringValue(title.coverUrl()));
        snapshot.put("aliases", title.aliases() == null ? List.of() : title.aliases());
        snapshot.put("tags", title.tags() == null ? List.of() : title.tags());
        snapshot.put("type", firstNonBlank(title.libraryTypeLabel(), title.mediaType(), "manga"));
        snapshot.put("typeSlug", LibraryNaming.normalizeTypeSlug(firstNonBlank(title.libraryTypeSlug(), title.mediaType(), "manga")));
        snapshot.put("editionLabel", detectEditionSignals(title.title(), title.aliases()).label());
        snapshot.put("details", Map.of(
            "title", stringValue(title.title()),
            "summary", stringValue(title.summary()),
            "aliases", title.aliases() == null ? List.of() : title.aliases(),
            "tags", title.tags() == null ? List.of() : title.tags(),
            "coverUrl", stringValue(title.coverUrl()),
            "type", firstNonBlank(title.libraryTypeLabel(), title.mediaType(), "manga")
        ));
        return snapshot;
    }

    private List<String> buildRepairWarnings(
        LibraryTitle title,
        DownloadProvider provider,
        String titleUrl,
        int chapterCount,
        int score,
        EditionSignals metadataEdition,
        Map<String, String> candidate
    ) {
        List<String> warnings = new ArrayList<>();
        if (provider.supportsUrl(title.sourceUrl()) && titleUrl.equals(stringValue(title.sourceUrl()))) {
            warnings.add("Current source");
        }
        if (chapterCount > 0 && title.chapterCount() > 0 && chapterCount < title.chapterCount()) {
            warnings.add("Coverage appears lower than the current library");
        }
        if (chapterCount > 0 && title.chaptersDownloaded() > 0 && chapterCount < title.chaptersDownloaded()) {
            warnings.add("Candidate exposes fewer chapters than are currently downloaded");
        }
        if (score < 100) {
            warnings.add("Weak match confidence");
        }
        EditionSignals candidateEdition = detectEditionSignals(candidate.get("title"), candidate.get("href"));
        if (metadataEdition.colored() != candidateEdition.colored()) {
            warnings.add("Edition markers do not match the current title");
        }
        return List.copyOf(warnings);
    }

    private String normalizeChapterNumber(String value) {
        String normalized = stringValue(value);
        if (normalized.isBlank()) {
            return "";
        }
        try {
            return new BigDecimal(normalized).stripTrailingZeros().toPlainString();
        } catch (NumberFormatException ignored) {
            return normalized;
        }
    }

    private int compareChapterNumbers(String left, String right) {
        try {
            return new BigDecimal(left).compareTo(new BigDecimal(right));
        } catch (NumberFormatException ignored) {
            return left.compareTo(right);
        }
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
                    addBaseTitleVariant(aliases, value);
                }
            }
        }
        addBaseTitleVariant(aliases, stringValue(metadataResult.get("title")));
        addBaseTitleVariant(aliases, stringValue(details.get("title")));

        String typeLabel = LibraryNaming.normalizeTypeLabel(firstNonBlank(
            stringValue(details.get("type")),
            stringValue(metadataResult.get("type")),
            "manga"
        ));
        EditionSignals editionSignals = detectEditionSignals(
            stringValue(metadataResult.get("title")),
            stringValue(details.get("title")),
            aliases
        );

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
        snapshot.put("tags", mergeDisplayStrings(
            objectToStringList(metadataResult.get("tags")),
            objectToStringList(details.get("tags"))
        ));
        snapshot.put("type", typeLabel);
        snapshot.put("typeSlug", LibraryNaming.normalizeTypeSlug(typeLabel));
        snapshot.put("editionLabel", editionSignals.label());
        snapshot.put("editionClass", editionSignals.key());
        snapshot.put("details", details);
        return snapshot;
    }

    private Map<String, Object> resolveDownloadSnapshot(String query, Map<String, Object> metadataSnapshot) {
        Set<String> dedupedTerms = new LinkedHashSet<>();
        addSearchTerm(dedupedTerms, stringValue(metadataSnapshot.get("title")));
        Object rawAliases = metadataSnapshot.get("aliases");
        if (rawAliases instanceof Iterable<?> iterable) {
            for (Object alias : iterable) {
                addSearchTerm(dedupedTerms, stringValue(alias));
            }
        }
        addSearchTerm(dedupedTerms, query);

        EditionSignals metadataEdition = detectEditionSignals(
            stringValue(metadataSnapshot.get("title")),
            stringValue(metadataSnapshot.get("editionLabel")),
            metadataSnapshot.get("aliases")
        );
        for (DownloadProvider provider : downloadProviderRegistry.enabledProviders()) {
            Map<String, String> bestCandidate = null;
            int bestScore = Integer.MIN_VALUE;
            String matchedQuery = "";
            for (String term : dedupedTerms) {
                List<Map<String, String>> searchResults = provider.searchTitles(term);
                for (Map<String, String> candidate : searchResults) {
                    int score = scoreCandidate(metadataSnapshot, candidate, dedupedTerms, metadataEdition);
                    if (score > bestScore) {
                        bestScore = score;
                        bestCandidate = candidate;
                        matchedQuery = term;
                    }
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
                EditionSignals candidateEdition = detectEditionSignals(
                    bestCandidate.get("title"),
                    bestCandidate.get("href"),
                    providerDetails != null ? providerDetails.associatedNames() : List.of()
                );
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
                snapshot.put("editionLabel", firstNonBlank(metadataEdition.label(), candidateEdition.label()));
                snapshot.put("editionClass", firstNonBlank(candidateEdition.key(), metadataEdition.key()));
                snapshot.put("providerEditionLabel", candidateEdition.label());
                snapshot.put("nsfw", providerDetails != null && Boolean.TRUE.equals(providerDetails.adultContent()));
                snapshot.put("matchedQuery", matchedQuery);
                snapshot.put("matchScore", bestScore);
                snapshot.put("confidenceBand", resolveConfidenceBand(bestScore));
                snapshot.put("warnings", buildDownloadWarnings(metadataSnapshot, bestScore, metadataEdition, candidateEdition, typeLabel));
                snapshot.put("tags", providerDetails != null && providerDetails.tags() != null ? providerDetails.tags() : List.of());
                snapshot.put("sourceUrl", stringValue(bestCandidate.get("href")));
                snapshot.put("metadataUrl", stringValue(metadataSnapshot.get("url")));
                return snapshot;
            }
        }

        return null;
    }

    private List<Map<String, Object>> resolveConcreteDownloadOptions(String query, Map<String, Object> metadataSnapshot) {
        Set<String> dedupedTerms = new LinkedHashSet<>();
        addSearchTerm(dedupedTerms, stringValue(metadataSnapshot.get("title")));
        Object rawAliases = metadataSnapshot.get("aliases");
        if (rawAliases instanceof Iterable<?> iterable) {
            for (Object alias : iterable) {
                addSearchTerm(dedupedTerms, stringValue(alias));
            }
        }
        addSearchTerm(dedupedTerms, query);

        EditionSignals metadataEdition = detectEditionSignals(
            stringValue(metadataSnapshot.get("title")),
            stringValue(metadataSnapshot.get("editionLabel")),
            metadataSnapshot.get("aliases")
        );
        Map<String, Map<String, Object>> groupedResults = new LinkedHashMap<>();
        for (DownloadProvider provider : downloadProviderRegistry.enabledProviders()) {
            for (String term : dedupedTerms) {
                for (Map<String, String> candidate : provider.searchTitles(term)) {
                    int score = scoreCandidate(metadataSnapshot, candidate, dedupedTerms, metadataEdition);
                    if (score < 60) {
                        continue;
                    }
                    String titleUrl = stringValue(candidate.get("href"));
                    if (titleUrl.isBlank()) {
                        continue;
                    }

                    String key = provider.id() + "::" + titleUrl;
                    if (parseInt(groupedResults.getOrDefault(key, Map.of()).get("matchScore")) >= score) {
                        continue;
                    }

                    TitleDetails providerDetails = provider.getTitleDetails(titleUrl);
                    String typeLabel = LibraryNaming.normalizeTypeLabel(firstNonBlank(
                        providerDetails != null ? providerDetails.type() : "",
                        candidate.get("type"),
                        stringValue(metadataSnapshot.get("type")),
                        "manga"
                    ));
                    EditionSignals candidateEdition = detectEditionSignals(
                        candidate.get("title"),
                        titleUrl,
                        providerDetails != null ? providerDetails.associatedNames() : List.of()
                    );
                    Map<String, Object> snapshot = new LinkedHashMap<>();
                    snapshot.put("providerId", provider.id());
                    snapshot.put("providerName", provider.name());
                    snapshot.put("titleName", firstNonBlank(candidate.get("title"), stringValue(metadataSnapshot.get("title")), "Untitled"));
                    snapshot.put("titleUrl", titleUrl);
                    snapshot.put("requestType", typeLabel);
                    snapshot.put("libraryTypeLabel", typeLabel);
                    snapshot.put("libraryTypeSlug", LibraryNaming.normalizeTypeSlug(typeLabel));
                    snapshot.put("coverUrl", firstNonBlank(
                        stringValue(candidate.get("coverUrl")),
                        stringValue(metadataSnapshot.get("coverUrl"))
                    ));
                    snapshot.put("editionLabel", firstNonBlank(metadataEdition.label(), candidateEdition.label()));
                    snapshot.put("editionClass", firstNonBlank(candidateEdition.key(), metadataEdition.key()));
                    snapshot.put("providerEditionLabel", candidateEdition.label());
                    snapshot.put("nsfw", providerDetails != null && Boolean.TRUE.equals(providerDetails.adultContent()));
                    snapshot.put("matchedQuery", term);
                    snapshot.put("matchScore", score);
                    snapshot.put("confidenceBand", resolveConfidenceBand(score));
                    snapshot.put("warnings", buildDownloadWarnings(metadataSnapshot, score, metadataEdition, candidateEdition, typeLabel));
                    snapshot.put("tags", providerDetails != null && providerDetails.tags() != null ? providerDetails.tags() : List.of());
                    snapshot.put("sourceUrl", titleUrl);
                    snapshot.put("metadataUrl", stringValue(metadataSnapshot.get("url")));
                    groupedResults.put(key, snapshot);
                }
            }
        }

        return groupedResults.values().stream()
            .sorted((left, right) -> {
                int scoreDelta = Integer.compare(parseInt(right.get("matchScore")), parseInt(left.get("matchScore")));
                if (scoreDelta != 0) {
                    return scoreDelta;
                }
                int providerDelta = stringValue(left.get("providerName")).compareToIgnoreCase(stringValue(right.get("providerName")));
                if (providerDelta != 0) {
                    return providerDelta;
                }
                return stringValue(left.get("titleName")).compareToIgnoreCase(stringValue(right.get("titleName")));
            })
            .map(Map::copyOf)
            .toList();
    }

    private int scoreCandidate(
        Map<String, Object> metadataSnapshot,
        Map<String, String> candidate,
        Set<String> aliases,
        EditionSignals metadataEdition
    ) {
        String candidateTitle = normalizeTitle(candidate.get("title"));
        if (candidateTitle.isBlank()) {
            return Integer.MIN_VALUE;
        }
        String candidateBaseTitle = normalizeBaseTitle(candidate.get("title"));

        int best = 0;
        for (String alias : aliases) {
            String normalizedAlias = normalizeTitle(alias);
            String normalizedAliasBase = normalizeBaseTitle(alias);
            if (normalizedAlias.isBlank()) {
                continue;
            }
            if (candidateTitle.equals(normalizedAlias)) {
                best = Math.max(best, 120);
                continue;
            }
            if (!candidateBaseTitle.isBlank() && candidateBaseTitle.equals(normalizedAliasBase)) {
                best = Math.max(best, 110);
                continue;
            }
            if (candidateTitle.contains(normalizedAlias) || normalizedAlias.contains(candidateTitle)) {
                best = Math.max(best, 90);
                continue;
            }
            if (!candidateBaseTitle.isBlank()
                && !normalizedAliasBase.isBlank()
                && (candidateBaseTitle.contains(normalizedAliasBase) || normalizedAliasBase.contains(candidateBaseTitle))) {
                best = Math.max(best, 85);
                continue;
            }
            if (tokenOverlap(candidateTitle, normalizedAlias) >= 0.75d) {
                best = Math.max(best, 70);
                continue;
            }
            if (!candidateBaseTitle.isBlank()
                && !normalizedAliasBase.isBlank()
                && tokenOverlap(candidateBaseTitle, normalizedAliasBase) >= 0.75d) {
                best = Math.max(best, 68);
            }
        }

        EditionSignals candidateEdition = detectEditionSignals(candidate.get("title"), candidate.get("href"));
        best += scoreEditionAlignment(metadataEdition, candidateEdition);

        String metadataType = LibraryNaming.normalizeTypeSlug(stringValue(metadataSnapshot.get("type")));
        String candidateType = LibraryNaming.normalizeTypeSlug(firstNonBlank(candidate.get("type"), metadataType));
        if (!metadataType.isBlank() && metadataType.equals(candidateType)) {
            best += 5;
        }
        return best;
    }

    private List<String> buildDownloadWarnings(
        Map<String, Object> metadataSnapshot,
        int score,
        EditionSignals metadataEdition,
        EditionSignals candidateEdition,
        String typeLabel
    ) {
        List<String> warnings = new ArrayList<>();
        String metadataType = LibraryNaming.normalizeTypeSlug(stringValue(metadataSnapshot.get("type")));
        String candidateType = LibraryNaming.normalizeTypeSlug(typeLabel);
        if (!metadataType.isBlank() && !candidateType.isBlank() && !metadataType.equals(candidateType)) {
            warnings.add("Type differs from the selected metadata");
        }
        if (metadataEdition.colored() != candidateEdition.colored()) {
            warnings.add("Edition markers do not match the selected metadata");
        }
        if (score < 100) {
            warnings.add("Weak match confidence");
        }
        return List.copyOf(warnings);
    }

    private String resolveConfidenceBand(int score) {
        if (score >= 120) {
            return "exact";
        }
        if (score >= 100) {
            return "high";
        }
        if (score >= 75) {
            return "medium";
        }
        return "low";
    }

    private int scoreBulkMetadataCandidate(
        Map<String, Object> metadataSnapshot,
        Map<String, Object> downloadSnapshot,
        String titleName,
        String requestedType
    ) {
        int labelScore = scoreBulkLabelAlignment(metadataSnapshot, stringValue(downloadSnapshot.get("titleName")));
        int titleScore = scoreBulkLabelAlignment(metadataSnapshot, titleName);
        int providerScore = parseInt(downloadSnapshot.get("matchScore"));
        int requestedTypeScore = 0;
        String requestedTypeSlug = LibraryNaming.normalizeTypeSlug(requestedType);
        String metadataTypeSlug = LibraryNaming.normalizeTypeSlug(stringValue(metadataSnapshot.get("type")));
        if (!requestedTypeSlug.isBlank() && requestedTypeSlug.equals(metadataTypeSlug)) {
            requestedTypeScore += 10;
        }
        return Math.max(labelScore, titleScore) + providerScore + requestedTypeScore;
    }

    private int scoreBulkLabelAlignment(Map<String, Object> metadataSnapshot, String providerTitle) {
        List<String> labels = new ArrayList<>();
        labels.add(stringValue(metadataSnapshot.get("title")));
        Object rawAliases = metadataSnapshot.get("aliases");
        if (rawAliases instanceof Iterable<?> iterable) {
            for (Object alias : iterable) {
                String value = stringValue(alias);
                if (!value.isBlank()) {
                    labels.add(value);
                }
            }
        }

        int best = 0;
        for (String label : labels) {
            best = Math.max(best, scoreBulkLabelAlignment(label, providerTitle));
        }
        return best;
    }

    private int scoreBulkLabelAlignment(String leftLabel, String rightLabel) {
        String left = normalizeTitle(leftLabel);
        String right = normalizeTitle(rightLabel);
        if (left.isBlank() || right.isBlank()) {
            return 0;
        }
        if (left.equals(right)) {
            return 180;
        }

        String leftBase = normalizeBaseTitle(leftLabel);
        String rightBase = normalizeBaseTitle(rightLabel);
        if (!leftBase.isBlank() && leftBase.equals(rightBase)) {
            return 150;
        }
        if (left.contains(right) || right.contains(left)) {
            return 120;
        }
        if (!leftBase.isBlank() && !rightBase.isBlank() && (leftBase.contains(rightBase) || rightBase.contains(leftBase))) {
            return 110;
        }
        if (tokenOverlap(left, right) >= 0.75d) {
            return 95;
        }
        if (!leftBase.isBlank() && !rightBase.isBlank() && tokenOverlap(leftBase, rightBase) >= 0.75d) {
            return 90;
        }
        return 0;
    }

    private boolean sameDownloadTarget(String providerId, String titleUrl, Map<String, Object> downloadSnapshot) {
        if (downloadSnapshot == null || downloadSnapshot.isEmpty()) {
            return false;
        }
        return providerId.equalsIgnoreCase(stringValue(downloadSnapshot.get("providerId")))
            && titleUrl.equals(stringValue(downloadSnapshot.get("titleUrl")));
    }

    private String buildBulkMetadataCandidateKey(Map<String, Object> metadataSnapshot, String requestedType) {
        String typeSlug = LibraryNaming.normalizeTypeSlug(firstNonBlank(
            stringValue(metadataSnapshot.get("type")),
            requestedType,
            "manga"
        ));
        EditionSignals editionSignals = detectEditionSignals(
            stringValue(metadataSnapshot.get("title")),
            stringValue(metadataSnapshot.get("editionLabel")),
            metadataSnapshot.get("aliases")
        );
        return normalizeBaseTitle(stringValue(metadataSnapshot.get("title")))
            + "::" + editionSignals.key()
            + "::" + typeSlug;
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

    private String normalizeBaseTitle(String value) {
        return normalizeTitle(stripEditionTokens(value));
    }

    private void addBaseTitleVariant(Set<String> terms, String value) {
        String baseTitle = stripEditionTokens(value);
        if (!baseTitle.isBlank()) {
            terms.add(baseTitle);
        }
    }

    private void addSearchTerm(Set<String> terms, String value) {
        String trimmed = stringValue(value);
        if (trimmed.isBlank()) {
            return;
        }
        terms.add(trimmed);
        addBaseTitleVariant(terms, trimmed);
    }

    private String stripEditionTokens(String value) {
        String normalized = stringValue(value)
            .replaceAll("(?i)\\bofficial\\s+colored\\b", " ")
            .replaceAll("(?i)\\bdigital\\s+colored\\b", " ")
            .replaceAll("(?i)\\bfull\\s+colored\\b", " ")
            .replaceAll("(?i)\\bfull\\s+color\\b", " ")
            .replaceAll("(?i)\\bcolored\\b", " ")
            .replaceAll("(?i)\\bcolor\\b", " ")
            .replaceAll("[()\\[\\]{}]", " ")
            .replaceAll("\\s+", " ")
            .trim();
        return normalized;
    }

    private int scoreEditionAlignment(EditionSignals metadataEdition, EditionSignals candidateEdition) {
        if (!metadataEdition.colored()) {
            return candidateEdition.colored() ? -35 : 0;
        }
        if (!candidateEdition.colored()) {
            return -55;
        }
        if (!metadataEdition.label().isBlank()
            && !candidateEdition.label().isBlank()
            && metadataEdition.label().equalsIgnoreCase(candidateEdition.label())) {
            return 55;
        }
        return 45;
    }

    private EditionSignals detectEditionSignals(Object... values) {
        String normalized = Arrays.stream(values)
            .flatMap((value) -> {
                if (value instanceof Iterable<?> iterable) {
                    return Arrays.stream(toStringArray(iterable));
                }
                return Arrays.stream(new String[] { stringValue(value) });
            })
            .map((value) -> value.toLowerCase(Locale.ROOT))
            .map((value) -> value.replaceAll("[^a-z0-9]+", " ").trim())
            .filter((value) -> !value.isBlank())
            .collect(Collectors.joining(" "));
        if (normalized.isBlank()) {
            return EditionSignals.none();
        }
        if (containsPhrase(normalized, "official colored")) {
            return new EditionSignals("colored", "Official Colored");
        }
        if (containsPhrase(normalized, "digital colored")) {
            return new EditionSignals("colored", "Digital Colored");
        }
        if (containsPhrase(normalized, "full colored") || containsPhrase(normalized, "full color")) {
            return new EditionSignals("colored", "Full Color");
        }
        if (containsPhrase(normalized, "colored")) {
            return new EditionSignals("colored", "Colored");
        }
        if (containsPhrase(normalized, "color")) {
            return new EditionSignals("colored", "Color");
        }
        return EditionSignals.none();
    }

    private boolean containsPhrase(String haystack, String phrase) {
        return haystack.contains(" " + phrase + " ")
            || haystack.startsWith(phrase + " ")
            || haystack.endsWith(" " + phrase)
            || haystack.equals(phrase);
    }

    private String[] toStringArray(Iterable<?> iterable) {
        List<String> values = new ArrayList<>();
        for (Object value : iterable) {
            String stringValue = stringValue(value);
            if (!stringValue.isBlank()) {
                values.add(stringValue);
            }
        }
        return values.toArray(String[]::new);
    }

    private String buildWorkKey(Map<String, Object> metadataSnapshot, Map<String, Object> downloadSnapshot) {
        if (downloadSnapshot != null) {
            return stringValue(downloadSnapshot.get("providerId")) + "::" + stringValue(downloadSnapshot.get("titleUrl"));
        }
        return stringValue(metadataSnapshot.get("provider")) + "::" + stringValue(metadataSnapshot.get("providerSeriesId"));
    }

    private int parseInt(Object value) {
        try {
            return Integer.parseInt(stringValue(value));
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    private int resolveDownloadMatchScore(Map<String, Object> payload) {
        Object rawDownload = payload.get("download");
        if (!(rawDownload instanceof Map<?, ?> download)) {
            return 0;
        }
        return parseInt(download.get("matchScore"));
    }

    private int scoreSearchPayload(String query, Map<String, Object> payload) {
        List<String> labels = new ArrayList<>();
        labels.add(stringValue(payload.get("canonicalTitle")));
        Object rawMetadata = payload.get("metadata");
        if (rawMetadata instanceof Map<?, ?> metadata) {
            labels.add(stringValue(metadata.get("title")));
        }
        Object rawAliases = payload.get("aliases");
        if (rawAliases instanceof Iterable<?> iterable) {
            for (Object alias : iterable) {
                labels.add(stringValue(alias));
            }
        }
        int best = 0;
        for (String label : labels) {
            best = Math.max(best, scoreBulkLabelAlignment(label, query));
        }
        EditionSignals queryEdition = detectEditionSignals(query);
        EditionSignals payloadEdition = detectEditionSignals(
            payload.get("canonicalTitle"),
            payload.get("editionLabel"),
            payload.get("aliases")
        );
        if (!queryEdition.colored()) {
            return Math.max(0, best + (payloadEdition.colored() ? -20 : 0));
        }
        if (!payloadEdition.colored()) {
            return Math.max(0, best - 35);
        }
        return best + 18;
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

    private List<String> objectToStringList(Object value) {
        if (!(value instanceof Iterable<?> iterable)) {
            return List.of();
        }
        List<String> values = new ArrayList<>();
        for (Object entry : iterable) {
            String normalized = stringValue(entry);
            if (!normalized.isBlank()) {
                values.add(normalized);
            }
        }
        return List.copyOf(values);
    }

    private List<String> mergeDisplayStrings(List<String>... valueSets) {
        Set<String> seen = new LinkedHashSet<>();
        List<String> merged = new ArrayList<>();
        for (List<String> values : valueSets) {
            for (String value : values) {
                String normalized = stringValue(value);
                if (normalized.isBlank()) {
                    continue;
                }
                String dedupeKey = normalized.toLowerCase(Locale.ROOT);
                if (seen.add(dedupeKey)) {
                    merged.add(normalized);
                }
            }
        }
        return List.copyOf(merged);
    }

    private static final class GroupedIntakeResult {
        private final String workKey;
        private final List<Map<String, Object>> metadataSnapshots = new ArrayList<>();
        private final Set<String> aliases = new LinkedHashSet<>();
        private Map<String, Object> representativeMetadata;
        private Map<String, Object> downloadSnapshot;
        private int representativeScore = Integer.MIN_VALUE;

        private GroupedIntakeResult(String workKey, Map<String, Object> downloadSnapshot) {
            this.workKey = workKey;
            this.downloadSnapshot = downloadSnapshot == null ? null : Map.copyOf(downloadSnapshot);
        }

        private void add(Map<String, Object> metadataSnapshot, Map<String, Object> resolvedDownloadSnapshot) {
            metadataSnapshots.add(Map.copyOf(metadataSnapshot));
            aliases.addAll(readAliases(metadataSnapshot));
            if (downloadSnapshot == null && resolvedDownloadSnapshot != null) {
                downloadSnapshot = Map.copyOf(resolvedDownloadSnapshot);
            }
            Map<String, Object> effectiveDownloadSnapshot = resolvedDownloadSnapshot != null
                ? resolvedDownloadSnapshot
                : downloadSnapshot;
            int downloadScore = effectiveDownloadSnapshot == null
                ? 0
                : parseInt(effectiveDownloadSnapshot.get("matchScore"));
            int metadataScore = scoreMetadataRepresentative(metadataSnapshot, effectiveDownloadSnapshot);
            int score = (downloadScore * 1000) + metadataScore;
            if (representativeMetadata == null || score > representativeScore || isBetterRepresentative(metadataSnapshot, effectiveDownloadSnapshot, score)) {
                representativeMetadata = Map.copyOf(metadataSnapshot);
                representativeScore = score;
                if (resolvedDownloadSnapshot != null) {
                    downloadSnapshot = Map.copyOf(resolvedDownloadSnapshot);
                }
            }
        }

        private Map<String, Object> toPayload() {
            Map<String, Object> metadata = representativeMetadata == null ? Map.of() : representativeMetadata;
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("metadataProviderId", stringValue(metadata.get("provider")));
            payload.put("providerSeriesId", stringValue(metadata.get("providerSeriesId")));
            payload.put("canonicalTitle", resolveCanonicalTitle(metadata, downloadSnapshot));
            payload.put("editionLabel", firstNonBlank(
                stringValue(downloadSnapshot == null ? "" : downloadSnapshot.get("editionLabel")),
                stringValue(metadata.get("editionLabel"))
            ));
            payload.put("aliases", List.copyOf(aliases));
            payload.put("type", stringValue(metadata.get("type")));
            payload.put("metadata", metadata);
            payload.put("metadataMatches", List.copyOf(metadataSnapshots));
            payload.put("metadataMatchCount", metadataSnapshots.size());
            payload.put("download", downloadSnapshot);
            payload.put("downloadProviderId", stringValue(downloadSnapshot == null ? "" : downloadSnapshot.get("providerId")));
            payload.put("titleUrl", stringValue(downloadSnapshot == null ? "" : downloadSnapshot.get("titleUrl")));
            payload.put("availability", downloadSnapshot == null ? "unavailable" : "available");
            payload.put("workKey", workKey);
            return payload;
        }

        private boolean isBetterRepresentative(
            Map<String, Object> metadataSnapshot,
            Map<String, Object> effectiveDownloadSnapshot,
            int score
        ) {
            if (score != representativeScore) {
                return score > representativeScore;
            }
            int currentSimilarity = scoreMetadataRepresentative(representativeMetadata, downloadSnapshot);
            int candidateSimilarity = scoreMetadataRepresentative(metadataSnapshot, effectiveDownloadSnapshot);
            if (currentSimilarity != candidateSimilarity) {
                return candidateSimilarity > currentSimilarity;
            }
            String currentEdition = stringValue(representativeMetadata == null ? "" : representativeMetadata.get("editionLabel"));
            String candidateEdition = stringValue(metadataSnapshot.get("editionLabel"));
            if (currentEdition.isBlank() != candidateEdition.isBlank()) {
                return !candidateEdition.isBlank();
            }
            return stringValue(metadataSnapshot.get("title")).length() < stringValue(representativeMetadata == null ? "" : representativeMetadata.get("title")).length();
        }

        private static int scoreMetadataRepresentative(Map<String, Object> metadataSnapshot, Map<String, Object> downloadSnapshot) {
            String metadataTitle = stringValue(metadataSnapshot == null ? null : metadataSnapshot.get("title"));
            String metadataBaseTitle = normalizeBaseTitle(metadataTitle);
            String providerTitle = stringValue(downloadSnapshot == null ? null : downloadSnapshot.get("titleName"));
            String providerBaseTitle = normalizeBaseTitle(providerTitle);
            String metadataEdition = stringValue(metadataSnapshot == null ? null : metadataSnapshot.get("editionLabel"));
            String providerEdition = stringValue(downloadSnapshot == null ? null : downloadSnapshot.get("editionLabel"));

            int score = 0;
            if (!metadataTitle.isBlank() && !providerTitle.isBlank()) {
                if (normalizeTitle(metadataTitle).equals(normalizeTitle(providerTitle))) {
                    score += 180;
                } else if (!metadataBaseTitle.isBlank() && metadataBaseTitle.equals(providerBaseTitle)) {
                    score += 150;
                } else if (!metadataBaseTitle.isBlank() && !providerBaseTitle.isBlank()) {
                    score += Math.round((float) (tokenOverlap(metadataBaseTitle, providerBaseTitle) * 100d));
                }
            }

            if (!metadataEdition.isBlank() && !providerEdition.isBlank()) {
                score += metadataEdition.equalsIgnoreCase(providerEdition) ? 35 : -25;
            } else if (metadataEdition.isBlank() && providerEdition.isBlank()) {
                score += 15;
            }

            return score;
        }

        private static List<String> readAliases(Map<String, Object> metadataSnapshot) {
            Object rawAliases = metadataSnapshot.get("aliases");
            if (!(rawAliases instanceof Iterable<?> iterable)) {
                return List.of();
            }
            List<String> aliases = new ArrayList<>();
            for (Object alias : iterable) {
                String value = stringValue(alias);
                if (!value.isBlank()) {
                    aliases.add(value);
                }
            }
            return aliases;
        }

        private static int parseInt(Object value) {
            try {
                return Integer.parseInt(stringValue(value));
            } catch (NumberFormatException ignored) {
                return 0;
            }
        }

        private static String resolveCanonicalTitle(Map<String, Object> metadata, Map<String, Object> downloadSnapshot) {
            String metadataTitle = stringValue(metadata.get("title"));
            String editionLabel = firstNonBlank(
                stringValue(downloadSnapshot == null ? "" : downloadSnapshot.get("editionLabel")),
                stringValue(metadata.get("editionLabel"))
            );
            String providerTitle = stringValue(downloadSnapshot == null ? "" : downloadSnapshot.get("titleName"));
            if (!metadataTitle.isBlank() && (editionLabel.isBlank() || containsIgnoreCase(metadataTitle, editionLabel))) {
                return metadataTitle;
            }
            String baseTitle = firstNonBlank(
                stripTitleEdition(metadataTitle),
                stripTitleEdition(providerTitle),
                metadataTitle,
                providerTitle,
                "Untitled"
            );
            if (editionLabel.isBlank()) {
                return firstNonBlank(metadataTitle, providerTitle, baseTitle, "Untitled");
            }
            return baseTitle + " (" + editionLabel + ")";
        }

        private static boolean containsIgnoreCase(String value, String fragment) {
            return value != null && fragment != null && value.toLowerCase(Locale.ROOT).contains(fragment.toLowerCase(Locale.ROOT));
        }

        private static double tokenOverlap(String left, String right) {
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

        private static String normalizeTitle(String value) {
            return stringValue(value)
                .toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", " ")
                .trim();
        }

        private static String normalizeBaseTitle(String value) {
            return normalizeTitle(stripTitleEdition(value));
        }

        private static String stripTitleEdition(String value) {
            return stringValue(value)
                .replaceAll("(?i)\\(official colored\\)", "")
                .replaceAll("(?i)\\(digital colored\\)", "")
                .replaceAll("(?i)\\(full color\\)", "")
                .replaceAll("(?i)\\(color\\)", "")
                .replaceAll("(?i)\\(colored\\)", "")
                .replaceAll("\\s+", " ")
                .trim();
        }

        private static String stringValue(Object value) {
            return value == null ? "" : String.valueOf(value).trim();
        }

        private static String firstNonBlank(String... values) {
            for (String value : values) {
                if (value != null && !value.isBlank()) {
                    return value.trim();
                }
            }
            return "";
        }
    }

    private record EditionSignals(String key, String label) {
        private static EditionSignals none() {
            return new EditionSignals("", "");
        }

        private boolean colored() {
            return "colored".equals(key);
        }
    }

    /**
     * Safe bulk metadata resolution outcome used by `/downloadall`.
     *
     * @param status matched, unmatched, or ambiguous
     * @param metadataSnapshot selected metadata snapshot when matched
     * @param downloadSnapshot selected download snapshot when matched
     */
    public record BulkMetadataResolution(
        String status,
        Map<String, Object> metadataSnapshot,
        Map<String, Object> downloadSnapshot
    ) {
        private static BulkMetadataResolution matched(Map<String, Object> metadataSnapshot, Map<String, Object> downloadSnapshot) {
            return new BulkMetadataResolution("matched", Map.copyOf(metadataSnapshot), Map.copyOf(downloadSnapshot));
        }

        private static BulkMetadataResolution unmatchedResult() {
            return new BulkMetadataResolution("unmatched", Map.of(), Map.of());
        }

        private static BulkMetadataResolution ambiguousResult() {
            return new BulkMetadataResolution("ambiguous", Map.of(), Map.of());
        }

        /**
         * Whether the bulk target resolved to one confident metadata match.
         *
         * @return {@code true} when the title is safe to queue
         */
        public boolean matched() {
            return "matched".equals(status);
        }

        /**
         * Whether the bulk target had no confident metadata match.
         *
         * @return {@code true} when the title should be skipped as unmatched
         */
        public boolean unmatched() {
            return "unmatched".equals(status);
        }

        /**
         * Whether the bulk target had multiple close metadata candidates.
         *
         * @return {@code true} when the title should be skipped as ambiguous
         */
        public boolean ambiguous() {
            return "ambiguous".equals(status);
        }
    }

    private record BulkMetadataCandidate(
        int score,
        Map<String, Object> metadataSnapshot,
        Map<String, Object> downloadSnapshot
    ) {
    }

    private record RepairCandidate(
        int score,
        boolean current,
        Map<String, Object> downloadSnapshot,
        int chapterCount,
        String earliestChapter,
        String latestChapter,
        List<String> warnings
    ) {
        private Map<String, Object> toPayload(LibraryTitle title) {
            Map<String, Object> payload = new LinkedHashMap<>(downloadSnapshot);
            payload.put("current", current);
            payload.put("matchScore", score);
            payload.put("chapterCount", chapterCount);
            payload.put("earliestChapter", earliestChapter);
            payload.put("latestChapter", latestChapter);
            payload.put("warnings", warnings);
            payload.put("coverageLabel", chapterCount <= 0
                ? "No chapters discovered"
                : (earliestChapter.isBlank() || latestChapter.isBlank()
                    ? chapterCount + " chapters"
                    : earliestChapter + "-" + latestChapter + " (" + chapterCount + " chapters)"));
            payload.put("currentSourceUrl", title == null || title.sourceUrl() == null ? "" : title.sourceUrl().trim());
            payload.put("currentChapterCount", title.chapterCount());
            payload.put("currentDownloadedCount", title.chaptersDownloaded());
            return payload;
        }
    }
}
