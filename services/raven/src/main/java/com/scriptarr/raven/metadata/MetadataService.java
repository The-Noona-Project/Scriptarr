package com.scriptarr.raven.metadata;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.library.LibraryNaming;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.SeriesLifecycle;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Aggregates Raven metadata providers and normalizes their API payloads.
 */
@Service
public class MetadataService {
    private static final String BROWSER_USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    private final List<MetadataProvider> providers;
    private final RavenSettingsService settingsService;
    private final RavenBrokerClient brokerClient;
    private final LibraryService libraryService;
    private final ScriptarrLogger logger;
    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build();
    private final ObjectMapper objectMapper = new ObjectMapper();

    /**
     * Create the metadata service.
     *
     * @param providers discovered metadata providers
     * @param settingsService shared Raven settings service
     * @param brokerClient Sage-backed Raven persistence client
     * @param libraryService Raven library service
     * @param logger shared Raven logger
     */
    public MetadataService(
        List<MetadataProvider> providers,
        RavenSettingsService settingsService,
        RavenBrokerClient brokerClient,
        LibraryService libraryService,
        ScriptarrLogger logger
    ) {
        this.providers = List.copyOf(providers);
        this.settingsService = settingsService;
        this.brokerClient = brokerClient;
        this.libraryService = libraryService;
        this.logger = logger;
    }

    /**
     * Describe the configured metadata providers and their enabled state.
     *
     * @return provider descriptions in UI order
     */
    public List<Map<String, Object>> describeProviders() {
        return settingsService.getMetadataProviderSettings();
    }

    /**
     * Search enabled metadata providers for a series name.
     *
     * @param name series name to search
     * @param requestedProvider optional provider filter
     * @return aggregated provider results
     */
    public List<Map<String, Object>> search(String name, String requestedProvider) {
        return search(name, requestedProvider, null);
    }

    /**
     * Search enabled metadata providers for a series, optionally constrained by
     * a Raven library title's stored type.
     *
     * @param name series name to search
     * @param requestedProvider optional provider filter
     * @param libraryId optional Raven library id to resolve for type-aware filtering
     * @return aggregated provider results
     */
    public List<Map<String, Object>> search(String name, String requestedProvider, String libraryId) {
        List<RankedMetadataSearchResult> rankedResults = new ArrayList<>();
        LibraryTitle title = libraryId == null || libraryId.isBlank() ? null : libraryService.findTitle(libraryId);
        int providerOrder = 0;
        int resultOrder = 0;
        for (Map<String, Object> provider : describeProviders()) {
            String providerId = String.valueOf(provider.get("id"));
            boolean enabled = Boolean.TRUE.equals(provider.get("enabled"));
            if (!enabled) {
                continue;
            }
            if (requestedProvider != null && !requestedProvider.isBlank() && !providerId.equalsIgnoreCase(requestedProvider.trim())) {
                continue;
            }
            if (!providerSupportsLibraryType(provider, title)) {
                continue;
            }
            try {
                for (Map<String, Object> result : searchProvider(providerId, name)) {
                    int score = scoreSearchResult(name, result);
                    if (score <= 0) {
                        continue;
                    }
                    rankedResults.add(new RankedMetadataSearchResult(
                        score,
                        providerOrder,
                        resultOrder++,
                        Map.copyOf(result)
                    ));
                }
            } catch (Exception error) {
                logger.warn("METADATA", "Metadata provider search failed.", providerId + ": " + error.getMessage());
            }
            providerOrder += 1;
        }
        return rankedResults.stream()
            .sorted((left, right) -> {
                int scoreDelta = Integer.compare(right.score(), left.score());
                if (scoreDelta != 0) {
                    return scoreDelta;
                }
                int providerDelta = Integer.compare(left.providerOrder(), right.providerOrder());
                if (providerDelta != 0) {
                    return providerDelta;
                }
                int titleLengthDelta = Integer.compare(
                    normalizeString(left.payload().get("title") == null ? "" : String.valueOf(left.payload().get("title"))).length(),
                    normalizeString(right.payload().get("title") == null ? "" : String.valueOf(right.payload().get("title"))).length()
                );
                if (titleLengthDelta != 0) {
                    return titleLengthDelta;
                }
                return Integer.compare(left.resultOrder(), right.resultOrder());
            })
            .map(RankedMetadataSearchResult::payload)
            .toList();
    }

    /**
     * Persist and apply a metadata identification match to Raven's durable
     * library catalog.
     *
     * @param provider provider id selected by the admin
     * @param providerSeriesId provider-specific series id
     * @param seriesId internal Scriptarr series id
     * @param libraryId library id the match belongs to
     * @return confirmation payload
     */
    public Map<String, Object> identify(String provider, String providerSeriesId, String seriesId, String libraryId) {
        String effectiveTitleId = libraryId != null && !libraryId.isBlank() ? libraryId : seriesId;
        if (effectiveTitleId == null || effectiveTitleId.isBlank()) {
            return Map.of(
                "ok", false,
                "error", "libraryId or seriesId is required."
            );
        }

        try {
            Map<String, Object> details = seriesDetails(provider, providerSeriesId);
            String matchedAt = Instant.now().toString();
            LibraryTitle title = libraryService.findTitle(effectiveTitleId);
            if (title != null && !providerSupportsLibraryType(provider, title)) {
                return Map.of(
                    "ok", false,
                    "provider", provider,
                    "providerSeriesId", providerSeriesId,
                    "libraryId", effectiveTitleId,
                    "error", "Provider " + provider + " does not support Raven type " + resolveTypeScope(title) + "."
                );
            }

            brokerClient.putMetadataMatch(effectiveTitleId, Map.of(
                "provider", provider,
                "providerSeriesId", providerSeriesId,
                "details", details
            ));
            libraryService.applyMetadata(effectiveTitleId, provider, matchedAt, normalizeAppliedMetadata(details));
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("ok", true);
            response.put("provider", provider);
            response.put("providerSeriesId", providerSeriesId);
            response.put("seriesId", seriesId);
            response.put("libraryId", effectiveTitleId);
            response.put("matchedAt", matchedAt);
            response.put("details", details);
            response.put("message", "Raven applied the selected metadata match.");
            return response;
        } catch (Exception error) {
            logger.warn("METADATA", "Metadata identify failed.", error.getMessage());
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("ok", false);
            response.put("provider", provider);
            response.put("providerSeriesId", providerSeriesId);
            response.put("libraryId", effectiveTitleId);
            response.put("error", firstNonBlank(error.getMessage(), error.getClass().getSimpleName()));
            return response;
        }
    }

    /**
     * Persist a pre-resolved metadata snapshot onto a Raven library title
     * without re-querying the upstream metadata provider.
     *
     * @param titleId stable Raven title id
     * @param metadataSnapshot metadata snapshot captured during intake or bulk queue resolution
     * @return confirmation payload
     */
    public Map<String, Object> persistResolvedMatch(String titleId, Map<String, Object> metadataSnapshot) {
        String effectiveTitleId = titleId == null ? "" : titleId.trim();
        if (effectiveTitleId.isBlank()) {
            return Map.of(
                "ok", false,
                "error", "titleId is required."
            );
        }

        Map<String, Object> snapshot = metadataSnapshot == null ? Map.of() : metadataSnapshot;
        String provider = String.valueOf(snapshot.getOrDefault("provider", "")).trim();
        String providerSeriesId = String.valueOf(snapshot.getOrDefault("providerSeriesId", "")).trim();
        if (provider.isBlank() || providerSeriesId.isBlank()) {
            return Map.of(
                "ok", false,
                "error", "provider and providerSeriesId are required."
            );
        }

        try {
            Map<String, Object> details = new LinkedHashMap<>(normalizeMap(snapshot.get("details")));
            if (details.isEmpty()) {
                details.putAll(seriesDetails(provider, providerSeriesId));
            }
            details.putIfAbsent("title", String.valueOf(snapshot.getOrDefault("title", "")));
            details.putIfAbsent("summary", String.valueOf(snapshot.getOrDefault("summary", "")));
            details.putIfAbsent("aliases", snapshot.getOrDefault("aliases", List.of()));
            details.putIfAbsent("coverUrl", String.valueOf(snapshot.getOrDefault("coverUrl", "")));
            details.putIfAbsent("type", String.valueOf(snapshot.getOrDefault("type", "")));

            String matchedAt = Instant.now().toString();
            brokerClient.putMetadataMatch(effectiveTitleId, Map.of(
                "provider", provider,
                "providerSeriesId", providerSeriesId,
                "details", details
            ));
            libraryService.applyMetadata(effectiveTitleId, provider, matchedAt, normalizeAppliedMetadata(details));

            Map<String, Object> response = new LinkedHashMap<>();
            response.put("ok", true);
            response.put("libraryId", effectiveTitleId);
            response.put("provider", provider);
            response.put("providerSeriesId", providerSeriesId);
            response.put("matchedAt", matchedAt);
            response.put("details", details);
            response.put("message", "Raven applied the resolved metadata match.");
            return response;
        } catch (Exception error) {
            logger.warn("METADATA", "Resolved metadata persistence failed.", error.getMessage());
            return Map.of(
                "ok", false,
                "libraryId", effectiveTitleId,
                "provider", provider,
                "providerSeriesId", providerSeriesId,
                "error", firstNonBlank(error.getMessage(), error.getClass().getSimpleName())
            );
        }
    }

    /**
     * Load series detail payloads for a specific metadata provider result.
     *
     * @param provider provider id to query
     * @param providerSeriesId provider-specific series id
     * @return normalized provider detail payload
     */
    public Map<String, Object> seriesDetails(String provider, String providerSeriesId) {
        try {
            return switch (provider.toLowerCase(Locale.ROOT)) {
                case "mangadex" -> fetchMangaDexSeriesDetails(providerSeriesId);
                case "anilist" -> fetchAniListSeriesDetails(providerSeriesId);
                case "animeplanet" -> fetchAnimePlanetSeriesDetails(providerSeriesId);
                case "mangaupdates" -> fetchMangaUpdatesSeriesDetails(providerSeriesId);
                case "mal" -> fetchMalSeriesDetails(providerSeriesId);
                case "comicvine" -> fetchComicVineSeriesDetails(providerSeriesId);
                default -> Map.of("provider", provider, "providerSeriesId", providerSeriesId, "books", List.of());
            };
        } catch (Exception error) {
            logger.warn("METADATA", "Series details request failed.", error.getMessage());
            return Map.of(
                "provider", provider,
                "providerSeriesId", providerSeriesId,
                "error", error.getMessage(),
                "books", List.of()
            );
        }
    }

    /**
     * Search one upstream metadata provider for a series name.
     *
     * <p>This stays overridable so Raven tests can exercise search ranking and
     * filtering behavior without touching live upstream services.
     *
     * @param providerId metadata provider id
     * @param name search query
     * @return raw provider search rows
     * @throws IOException when the provider search fails
     * @throws InterruptedException when the provider search is interrupted
     */
    protected List<Map<String, Object>> searchProvider(String providerId, String name) throws IOException, InterruptedException {
        return switch (providerId.toLowerCase(Locale.ROOT)) {
            case "mangadex" -> searchMangaDex(name);
            case "anilist" -> searchAniList(name);
            case "animeplanet" -> searchAnimePlanet(name);
            case "mangaupdates" -> searchMangaUpdates(name);
            case "mal" -> searchMal(name);
            case "comicvine" -> searchComicVine(name);
            default -> List.of();
        };
    }

    private List<Map<String, Object>> searchMangaDex(String name) throws IOException, InterruptedException {
        String encoded = URLEncoder.encode(name, StandardCharsets.UTF_8);
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create("https://api.mangadex.org/manga?limit=5&title=" + encoded + "&includes[]=cover_art"))
            .timeout(Duration.ofSeconds(15))
            .GET()
            .build();
        JsonNode root = sendJson(request);
        List<Map<String, Object>> results = new ArrayList<>();
        for (JsonNode entry : root.path("data")) {
            String id = entry.path("id").asText("");
            String title = preferredLocalizedValue(entry.path("attributes").path("title"), id);
            results.add(Map.of(
                "provider", "mangadex",
                "providerSeriesId", id,
                "title", title,
                "url", "https://mangadex.org/title/" + id,
                "coverUrl", firstNonBlank(
                    buildMangaDexCoverUrl(id, extractMangaDexCoverFileName(entry.path("relationships"))),
                    ""
                )
            ));
        }
        return results;
    }

    private Map<String, Object> fetchMangaDexSeriesDetails(String providerSeriesId) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create("https://api.mangadex.org/manga/" + providerSeriesId + "?includes[]=cover_art&includes[]=author"))
            .timeout(Duration.ofSeconds(15))
            .GET()
            .build();
        JsonNode root = sendJson(request).path("data");
        JsonNode attributes = root.path("attributes");
        return Map.ofEntries(
            Map.entry("provider", "mangadex"),
            Map.entry("providerSeriesId", providerSeriesId),
            Map.entry("title", preferredLocalizedValue(attributes.path("title"), providerSeriesId)),
            Map.entry("url", "https://mangadex.org/title/" + providerSeriesId),
            Map.entry("coverUrl", firstNonBlank(
                buildMangaDexCoverUrl(providerSeriesId, extractMangaDexCoverFileName(root.path("relationships"))),
                ""
            )),
            Map.entry("summary", preferredLocalizedValue(attributes.path("description"), "")),
            Map.entry("releaseLabel", attributes.path("year").asText("")),
            Map.entry("status", SeriesLifecycle.normalizeStatus(attributes.path("status").asText(""))),
            Map.entry("aliases", collectAltTitles(attributes.path("altTitles"))),
            Map.entry("tags", collectMangaDexTags(attributes)),
            Map.entry("books", List.of())
        );
    }

    private List<Map<String, Object>> searchAniList(String name) throws IOException, InterruptedException {
        String query = "query ($search: String) { Page(page: 1, perPage: 5) { media(search: $search, type: MANGA) { id title { romaji english } siteUrl coverImage { large } } } }";
        String body = objectMapper.writeValueAsString(Map.of(
            "query", query,
            "variables", Map.of("search", name)
        ));
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create("https://graphql.anilist.co"))
            .timeout(Duration.ofSeconds(15))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
        JsonNode media = sendJson(request).path("data").path("Page").path("media");
        List<Map<String, Object>> results = new ArrayList<>();
        for (JsonNode entry : media) {
            String id = entry.path("id").asText("");
            String title = entry.path("title").path("english").asText("");
            if (title.isBlank()) {
                title = entry.path("title").path("romaji").asText(id);
            }
            results.add(Map.of(
                "provider", "anilist",
                "providerSeriesId", id,
                "title", title,
                "url", entry.path("siteUrl").asText("https://anilist.co/manga/" + id),
                "coverUrl", entry.path("coverImage").path("large").asText("")
            ));
        }
        return results;
    }

    private Map<String, Object> fetchAniListSeriesDetails(String providerSeriesId) throws IOException, InterruptedException {
        String query = "query ($id: Int) { Media(id: $id, type: MANGA) { id title { romaji english } siteUrl coverImage { large } description(asHtml: false) startDate { year month day } status synonyms genres tags { name isGeneralSpoiler isMediaSpoiler } } }";
        String body = objectMapper.writeValueAsString(Map.of(
            "query", query,
            "variables", Map.of("id", Integer.parseInt(providerSeriesId))
        ));
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create("https://graphql.anilist.co"))
            .timeout(Duration.ofSeconds(15))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
        JsonNode media = sendJson(request).path("data").path("Media");
        return Map.ofEntries(
            Map.entry("provider", "anilist"),
            Map.entry("providerSeriesId", providerSeriesId),
            Map.entry("title", media.path("title").path("english").asText(media.path("title").path("romaji").asText(providerSeriesId))),
            Map.entry("url", media.path("siteUrl").asText("https://anilist.co/manga/" + providerSeriesId)),
            Map.entry("coverUrl", media.path("coverImage").path("large").asText("")),
            Map.entry("summary", media.path("description").asText("")),
            Map.entry("releaseLabel", formatPartialDate(media.path("startDate"))),
            Map.entry("status", SeriesLifecycle.normalizeStatus(media.path("status").asText(""))),
            Map.entry("aliases", mergeUniqueStrings(
                List.of(
                    media.path("title").path("english").asText(""),
                    media.path("title").path("romaji").asText("")
                ),
                jsonTextList(media.path("synonyms"))
            )),
            Map.entry("tags", mergeUniqueStrings(
                jsonTextList(media.path("genres")),
                collectAniListTags(media.path("tags"))
            )),
            Map.entry("books", List.of())
        );
    }

    private List<Map<String, Object>> searchAnimePlanet(String name) throws IOException, InterruptedException {
        String encoded = URLEncoder.encode(name, StandardCharsets.UTF_8);
        Document document = sendHtml(buildBrowserRequest("https://www.anime-planet.com/manga/all?name=" + encoded));
        if (isCloudflareChallenge(document)) {
            throw new IOException("Anime-Planet is blocking metadata search right now.");
        }

        List<Map<String, Object>> results = new ArrayList<>();
        var seen = new java.util.LinkedHashSet<String>();
        for (Element link : document.select("a[href^=/manga/], a[href^=https://www.anime-planet.com/manga/]")) {
            String href = normalizeAnimePlanetUrl(link.absUrl("href"));
            String slug = animePlanetSlug(href);
            if (slug.isBlank() || "all".equalsIgnoreCase(slug) || !seen.add(slug)) {
                continue;
            }

            String title = firstNonBlank(
                link.attr("title"),
                link.selectFirst("img[alt]") == null ? "" : link.selectFirst("img[alt]").attr("alt"),
                link.text(),
                prettifySlug(slug)
            );
            if (title.isBlank()) {
                continue;
            }

            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("provider", "animeplanet");
            entry.put("providerSeriesId", slug);
            entry.put("title", title);
            entry.put("url", href);
            entry.put("coverUrl", firstNonBlank(
                imageUrl(link.selectFirst("img[data-src]")),
                imageUrl(link.selectFirst("img[src]"))
            ));
            results.add(entry);
            if (results.size() >= 5) {
                break;
            }
        }
        return List.copyOf(results);
    }

    private Map<String, Object> fetchAnimePlanetSeriesDetails(String providerSeriesId) throws IOException, InterruptedException {
        String normalizedSeriesId = normalizeString(providerSeriesId);
        if (normalizedSeriesId.isBlank()) {
            return Map.of(
                "provider", "animeplanet",
                "providerSeriesId", providerSeriesId,
                "books", List.of()
            );
        }

        String url = "https://www.anime-planet.com/manga/" + normalizedSeriesId;
        Document document = sendHtml(buildBrowserRequest(url));
        if (isCloudflareChallenge(document)) {
            throw new IOException("Anime-Planet is blocking metadata detail scraping right now.");
        }

        Map<String, String> definitions = readDefinitionMap(document);
        List<String> aliases = extractAnimePlanetAliases(document, definitions);
        String title = firstNonBlank(
            metaContent(document, "og:title").replace(" Manga", "").trim(),
            document.selectFirst("h1") == null ? "" : document.selectFirst("h1").text(),
            prettifySlug(normalizedSeriesId)
        );
        String summary = firstNonBlank(
            text(document.selectFirst(".entrySynopsis")),
            text(document.selectFirst(".synopsis")),
            metaContent(document, "description")
        );
        String status = SeriesLifecycle.normalizeStatus(firstNonBlank(
            definitions.get("status"),
            definitions.get("publishing status")
        ));
        String releaseLabel = firstNonBlank(
            definitions.get("year"),
            definitions.get("vintage"),
            definitions.get("year published")
        );
        String type = firstNonBlank(
            inferAnimePlanetType(definitions),
            inferAnimePlanetTypeFromDocument(document),
            "Manga"
        );

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("provider", "animeplanet");
        payload.put("providerSeriesId", normalizedSeriesId);
        payload.put("title", title);
        payload.put("url", normalizeAnimePlanetUrl(url));
        payload.put("summary", summary);
        payload.put("coverUrl", firstNonBlank(
            metaContent(document, "og:image"),
            imageUrl(document.selectFirst(".entryBar img[data-src]")),
            imageUrl(document.selectFirst(".entryBar img[src]")),
            imageUrl(document.selectFirst("img[src]"))
        ));
        payload.put("releaseLabel", releaseLabel);
        payload.put("status", status);
        payload.put("aliases", aliases);
        payload.put("tags", extractAnimePlanetTags(document));
        payload.put("type", type);
        payload.put("books", List.of());
        return payload;
    }

    private List<Map<String, Object>> searchMangaUpdates(String name) throws IOException, InterruptedException {
        String body = objectMapper.writeValueAsString(Map.of(
            "search", name,
            "page", 1,
            "perpage", 5,
            "type", List.of("Manga", "Manhwa", "Manhua")
        ));
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create("https://api.mangaupdates.com/v1/series/search"))
            .timeout(Duration.ofSeconds(15))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
        JsonNode root = sendJson(request).path("results");
        List<Map<String, Object>> results = new ArrayList<>();
        for (JsonNode entry : root) {
            JsonNode record = entry.path("record");
            String id = record.path("series_id").asText(record.path("id").asText(""));
            results.add(Map.of(
                "provider", "mangaupdates",
                "providerSeriesId", id,
                "title", record.path("title").asText(id),
                "url", "https://www.mangaupdates.com/series/" + id
            ));
        }
        return results;
    }

    private Map<String, Object> fetchMangaUpdatesSeriesDetails(String providerSeriesId) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create("https://api.mangaupdates.com/v1/series/" + providerSeriesId))
            .timeout(Duration.ofSeconds(15))
            .GET()
            .build();
        JsonNode result = sendJson(request);
        List<String> aliases = new ArrayList<>();
        result.path("associated").forEach((entry) -> aliases.add(entry.path("title").asText("")));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("provider", "mangaupdates");
        payload.put("providerSeriesId", providerSeriesId);
        payload.put("title", result.path("title").asText(providerSeriesId));
        payload.put("url", "https://www.mangaupdates.com/series/" + providerSeriesId);
        payload.put("summary", result.path("description").asText(""));
        payload.put("releaseLabel", result.path("year").asText(""));
        payload.put("status", SeriesLifecycle.normalizeStatus(extractMangaUpdatesStatus(result)));
        payload.put(
            "author",
            result.path("authors").isArray() && result.path("authors").size() > 0
                ? result.path("authors").get(0).path("name").asText("")
                : ""
        );
        payload.put("aliases", aliases.stream().filter((alias) -> !alias.isBlank()).toList());
        payload.put("tags", jsonTextList(result.path("genres")));
        payload.put("books", List.of());
        return payload;
    }

    private List<Map<String, Object>> searchMal(String name) throws IOException, InterruptedException {
        if (settingsService.getMalClientId().isBlank()) {
            return List.of();
        }
        String encoded = URLEncoder.encode(name, StandardCharsets.UTF_8);
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create("https://api.myanimelist.net/v2/manga?q=" + encoded + "&nsfw=true&fields=alternative_titles,media_type"))
            .timeout(Duration.ofSeconds(15))
            .header("X-MAL-CLIENT-ID", settingsService.getMalClientId())
            .GET()
            .build();
        JsonNode root = sendJson(request).path("data");
        List<Map<String, Object>> results = new ArrayList<>();
        for (JsonNode entry : root) {
            JsonNode node = entry.path("node");
            String id = node.path("id").asText("");
            results.add(Map.of(
                "provider", "mal",
                "providerSeriesId", id,
                "title", node.path("title").asText(id),
                "url", "https://myanimelist.net/manga/" + id
            ));
        }
        return results;
    }

    private Map<String, Object> fetchMalSeriesDetails(String providerSeriesId) throws IOException, InterruptedException {
        if (settingsService.getMalClientId().isBlank()) {
            return Map.of(
                "provider", "mal",
                "providerSeriesId", providerSeriesId,
                "error", "MyAnimeList client id is missing.",
                "books", List.of()
            );
        }
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create("https://api.myanimelist.net/v2/manga/" + providerSeriesId
                + "?fields=alternative_titles,start_date,synopsis,authors{first_name,last_name},main_picture,media_type,status,num_volumes,num_chapters,genres"))
            .timeout(Duration.ofSeconds(15))
            .header("X-MAL-CLIENT-ID", settingsService.getMalClientId())
            .GET()
            .build();
        JsonNode result = sendJson(request);
        List<String> aliases = new ArrayList<>();
        result.path("alternative_titles").path("synonyms").forEach((entry) -> aliases.add(entry.asText("")));
        String author = "";
        if (result.path("authors").isArray() && result.path("authors").size() > 0) {
            JsonNode authorNode = result.path("authors").get(0).path("node");
            author = (authorNode.path("first_name").asText("") + " " + authorNode.path("last_name").asText("")).trim();
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("provider", "mal");
        payload.put("providerSeriesId", providerSeriesId);
        payload.put("title", result.path("title").asText(providerSeriesId));
        payload.put("url", "https://myanimelist.net/manga/" + providerSeriesId);
        payload.put("summary", result.path("synopsis").asText(""));
        payload.put("releaseLabel", result.path("start_date").asText(""));
        payload.put("status", SeriesLifecycle.normalizeStatus(result.path("status").asText("")));
        payload.put("author", author);
        payload.put("aliases", aliases.stream().filter((alias) -> !alias.isBlank()).toList());
        payload.put("tags", collectNamedValues(result.path("genres")));
        payload.put("books", List.of());
        return payload;
    }

    private List<Map<String, Object>> searchComicVine(String name) throws IOException, InterruptedException {
        if (settingsService.getComicVineApiKey().isBlank()) {
            return List.of();
        }
        String encoded = URLEncoder.encode(name, StandardCharsets.UTF_8);
        String url = "https://comicvine.gamespot.com/api/search/?api_key=" + settingsService.getComicVineApiKey()
            + "&format=json&resources=volume&limit=5&query=" + encoded;
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofSeconds(15))
            .GET()
            .build();
        JsonNode resultsNode = sendJson(request).path("results");
        List<Map<String, Object>> results = new ArrayList<>();
        for (JsonNode entry : resultsNode) {
            String id = entry.path("id").asText("");
            results.add(Map.of(
                "provider", "comicvine",
                "providerSeriesId", id,
                "title", entry.path("name").asText(id),
                "url", entry.path("site_detail_url").asText("")
            ));
        }
        return results;
    }

    private Map<String, Object> fetchComicVineSeriesDetails(String providerSeriesId) throws IOException, InterruptedException {
        if (settingsService.getComicVineApiKey().isBlank()) {
            return Map.of(
                "provider", "comicvine",
                "providerSeriesId", providerSeriesId,
                "error", "ComicVine API key is missing.",
                "books", List.of()
            );
        }
        String url = "https://comicvine.gamespot.com/api/volume/4050-" + providerSeriesId
            + "/?api_key=" + settingsService.getComicVineApiKey()
            + "&format=json";
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofSeconds(15))
            .GET()
            .build();
        JsonNode result = sendJson(request).path("results");
        return Map.of(
            "provider", "comicvine",
            "providerSeriesId", providerSeriesId,
            "title", result.path("name").asText(providerSeriesId),
            "url", result.path("site_detail_url").asText(""),
            "summary", result.path("description").asText(""),
            "releaseLabel", result.path("start_year").asText(""),
            "aliases", splitDelimitedValues(result.path("aliases").asText("")),
            "tags", collectNamedValues(result.path("genres")),
            "books", List.of()
        );
    }

    private String formatPartialDate(JsonNode value) {
        if (value == null || value.isMissingNode() || value.isNull()) {
            return "";
        }
        int year = value.path("year").asInt(0);
        int month = value.path("month").asInt(0);
        int day = value.path("day").asInt(0);
        if (year <= 0) {
            return "";
        }
        if (month <= 0) {
            return String.valueOf(year);
        }
        if (day <= 0) {
            return String.format(java.util.Locale.ROOT, "%04d-%02d", year, month);
        }
        return String.format(java.util.Locale.ROOT, "%04d-%02d-%02d", year, month, day);
    }

    private String extractMangaUpdatesStatus(JsonNode result) {
        String directStatus = result.path("status").asText("");
        if (!directStatus.isBlank()) {
            return directStatus;
        }
        String textStatus = result.path("status_text").asText("");
        if (!textStatus.isBlank()) {
            return textStatus;
        }
        String overallStatus = result.path("status").path("overall").asText("");
        if (!overallStatus.isBlank()) {
            return overallStatus;
        }
        return "";
    }

    private Map<String, Object> normalizeAppliedMetadata(Map<String, Object> details) {
        Map<String, Object> normalized = new LinkedHashMap<>();
        normalized.put("title", String.valueOf(details.getOrDefault("title", "")));
        normalized.put("url", String.valueOf(details.getOrDefault("url", "")));
        normalized.put("summary", String.valueOf(details.getOrDefault("summary", "")));
        normalized.put("coverUrl", String.valueOf(details.getOrDefault("coverUrl", "")));
        normalized.put("releaseLabel", String.valueOf(details.getOrDefault("releaseLabel", "")));
        normalized.put("status", String.valueOf(details.getOrDefault("status", "")));
        normalized.put("author", String.valueOf(details.getOrDefault("author", "")));
        normalized.put("type", String.valueOf(details.getOrDefault("type", "")));
        normalized.put("aliases", details.getOrDefault("aliases", List.of()));
        normalized.put("tags", details.getOrDefault("tags", List.of()));
        normalized.put("relations", details.getOrDefault("relations", List.of()));
        return normalized;
    }

    private String extractMangaDexCoverFileName(JsonNode relationships) {
        if (relationships == null || !relationships.isArray()) {
            return "";
        }
        for (JsonNode relationship : relationships) {
            if (!"cover_art".equals(relationship.path("type").asText(""))) {
                continue;
            }
            String fileName = relationship.path("attributes").path("fileName").asText("");
            if (!fileName.isBlank()) {
                return fileName;
            }
        }
        return "";
    }

    private String buildMangaDexCoverUrl(String mangaId, String fileName) {
        if (mangaId == null || mangaId.isBlank() || fileName == null || fileName.isBlank()) {
            return "";
        }
        return "https://uploads.mangadex.org/covers/" + mangaId + "/" + fileName + ".512.jpg";
    }

    private Map<String, Object> normalizeMap(Object value) {
        if (value instanceof Map<?, ?> rawMap) {
            Map<String, Object> normalized = new LinkedHashMap<>();
            rawMap.forEach((key, entryValue) -> normalized.put(String.valueOf(key), entryValue));
            return normalized;
        }
        return Map.of();
    }

    private JsonNode sendJson(HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() >= 400) {
            throw new IOException("Metadata provider returned HTTP " + response.statusCode() + ".");
        }
        return objectMapper.readTree(response.body());
    }

    private Document sendHtml(HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() >= 400) {
            throw new IOException("Metadata provider returned HTTP " + response.statusCode() + ".");
        }
        return Jsoup.parse(response.body(), request.uri().toString());
    }

    private HttpRequest buildBrowserRequest(String url) {
        return HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofSeconds(20))
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Cache-Control", "no-cache")
            .header("Pragma", "no-cache")
            .header("User-Agent", BROWSER_USER_AGENT)
            .GET()
            .build();
    }

    private boolean providerSupportsLibraryType(Map<String, Object> providerSettings, LibraryTitle title) {
        if (providerSettings == null || providerSettings.isEmpty()) {
            return false;
        }
        return providerSupportsLibraryType(String.valueOf(providerSettings.get("id")), title);
    }

    private boolean providerSupportsLibraryType(String providerId, LibraryTitle title) {
        if (title == null) {
            return true;
        }

        MetadataProvider provider = providers.stream()
            .filter((entry) -> entry.id().equalsIgnoreCase(providerId))
            .findFirst()
            .orElse(null);
        if (provider == null) {
            return true;
        }

        List<String> supportedScopes = provider.scopes().stream()
            .map((entry) -> entry == null ? "" : entry.trim().toLowerCase(Locale.ROOT))
            .toList();
        String typeScope = resolveTypeScope(title);
        if (typeScope == null || typeScope.isBlank()) {
            return true;
        }
        if (supportedScopes.contains(typeScope)) {
            return true;
        }
        return "manga".equals(typeScope) && (supportedScopes.contains("webtoon") || supportedScopes.contains("manga"));
    }

    private String resolveTypeScope(LibraryTitle title) {
        String rawType = firstNonBlank(title.libraryTypeSlug(), title.libraryTypeLabel());
        if (rawType.isBlank()) {
            rawType = firstNonBlank(title.mediaType(), "manga");
        }
        String normalized = LibraryNaming.normalizeTypeSlug(rawType);
        return switch (normalized) {
            case "comic" -> "comic";
            case "webtoon" -> "webtoon";
            case "manhwa", "manhua", "manga", "oel" -> "manga";
            default -> "manga";
        };
    }

    private int scoreSearchResult(String query, Map<String, Object> result) {
        String normalizedQuery = normalizeSearchTitle(query);
        String normalizedQueryBase = normalizeSearchBaseTitle(query);
        if (normalizedQuery.isBlank()) {
            return 0;
        }

        int best = scoreSearchLabel(
            normalizedQuery,
            normalizedQueryBase,
            result.get("title") == null ? "" : normalizeString(String.valueOf(result.get("title")))
        );
        Object rawAliases = result.get("aliases");
        if (rawAliases instanceof Iterable<?> iterable) {
            for (Object alias : iterable) {
                best = Math.max(
                    best,
                    scoreSearchLabel(normalizedQuery, normalizedQueryBase, alias == null ? "" : normalizeString(String.valueOf(alias)))
                );
            }
        }
        return Math.max(0, best + scoreEditionSearchAlignment(query, result));
    }

    private int scoreEditionSearchAlignment(String query, Map<String, Object> result) {
        EditionSignals queryEdition = detectEditionSignals(query);
        EditionSignals resultEdition = detectEditionSignals(
            result.get("title"),
            result.get("editionLabel"),
            result.get("aliases")
        );
        if (!queryEdition.colored()) {
            return resultEdition.colored() ? -20 : 0;
        }
        if (!resultEdition.colored()) {
            return -35;
        }
        return 18;
    }

    private int scoreSearchLabel(String normalizedQuery, String normalizedQueryBase, String value) {
        String normalizedTitle = normalizeSearchTitle(value);
        if (normalizedTitle.isBlank()) {
            return 0;
        }
        if (normalizedTitle.equals(normalizedQuery)) {
            return 320;
        }

        String normalizedTitleBase = normalizeSearchBaseTitle(value);
        if (!normalizedTitleBase.isBlank() && normalizedTitleBase.equals(normalizedQueryBase)) {
            return 280;
        }
        if (normalizedTitle.startsWith(normalizedQuery + " ")) {
            return 180;
        }
        if (normalizedTitle.contains(" " + normalizedQuery + " ") || normalizedTitle.endsWith(" " + normalizedQuery)) {
            return 150;
        }
        if (!normalizedTitleBase.isBlank() && !normalizedQueryBase.isBlank()) {
            if (normalizedTitleBase.startsWith(normalizedQueryBase + " ")) {
                return 170;
            }
            if (normalizedTitleBase.contains(" " + normalizedQueryBase + " ")
                || normalizedTitleBase.endsWith(" " + normalizedQueryBase)) {
                return 145;
            }
        }
        if (normalizedTitle.contains(normalizedQuery) || normalizedQuery.contains(normalizedTitle)) {
            return 135;
        }
        if (!normalizedTitleBase.isBlank()
            && !normalizedQueryBase.isBlank()
            && (normalizedTitleBase.contains(normalizedQueryBase) || normalizedQueryBase.contains(normalizedTitleBase))) {
            return 125;
        }
        if (tokenOverlap(normalizedTitle, normalizedQuery) >= 0.75d) {
            return 95;
        }
        if (!normalizedTitleBase.isBlank()
            && !normalizedQueryBase.isBlank()
            && tokenOverlap(normalizedTitleBase, normalizedQueryBase) >= 0.75d) {
            return 90;
        }
        return 0;
    }

    private String normalizeSearchTitle(String value) {
        return normalizeSearchBaseTitle(value)
            .replaceAll("[()\\[\\]{}]", " ")
            .replaceAll("\\s+", " ")
            .trim();
    }

    private String normalizeSearchBaseTitle(String value) {
        return normalizeString(value)
            .toLowerCase(Locale.ROOT)
            .replaceAll("(?i)\\bofficial\\s+colored\\b", " ")
            .replaceAll("(?i)\\bdigital\\s+colored\\b", " ")
            .replaceAll("(?i)\\bfull\\s+colored\\b", " ")
            .replaceAll("(?i)\\bfull\\s+color\\b", " ")
            .replaceAll("(?i)\\bcolored\\b", " ")
            .replaceAll("(?i)\\bcolor\\b", " ")
            .replaceAll("[^a-z0-9]+", " ")
            .replaceAll("\\s+", " ")
            .trim();
    }

    private double tokenOverlap(String left, String right) {
        List<String> leftTokens = List.of(left.split("\\s+")).stream()
            .map(String::trim)
            .filter((token) -> !token.isBlank())
            .toList();
        List<String> rightTokens = List.of(right.split("\\s+")).stream()
            .map(String::trim)
            .filter((token) -> !token.isBlank())
            .toList();
        if (leftTokens.isEmpty() || rightTokens.isEmpty()) {
            return 0d;
        }
        long matches = leftTokens.stream().filter(rightTokens::contains).count();
        return matches / (double) Math.max(leftTokens.size(), rightTokens.size());
    }

    private EditionSignals detectEditionSignals(Object... values) {
        StringBuilder builder = new StringBuilder();
        for (Object value : values) {
            if (value instanceof Iterable<?> iterable) {
                for (Object entry : iterable) {
                    appendEditionSource(builder, entry);
                }
                continue;
            }
            appendEditionSource(builder, value);
        }
        String normalized = builder.toString().trim();
        if (normalized.isBlank()) {
            return EditionSignals.none();
        }
        if (containsPhrase(normalized, "official colored")) {
            return new EditionSignals(true, "Official Colored");
        }
        if (containsPhrase(normalized, "digital colored")) {
            return new EditionSignals(true, "Digital Colored");
        }
        if (containsPhrase(normalized, "full colored") || containsPhrase(normalized, "full color")) {
            return new EditionSignals(true, "Full Color");
        }
        if (containsPhrase(normalized, "colored")) {
            return new EditionSignals(true, "Colored");
        }
        if (containsPhrase(normalized, "color")) {
            return new EditionSignals(true, "Color");
        }
        return EditionSignals.none();
    }

    private void appendEditionSource(StringBuilder builder, Object value) {
        String normalizedValue = normalizeString(value == null ? null : String.valueOf(value))
            .toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9]+", " ")
            .trim();
        if (normalizedValue.isBlank()) {
            return;
        }
        if (builder.length() > 0) {
            builder.append(' ');
        }
        builder.append(normalizedValue);
    }

    private boolean containsPhrase(String haystack, String phrase) {
        return haystack.contains(" " + phrase + " ")
            || haystack.startsWith(phrase + " ")
            || haystack.endsWith(" " + phrase)
            || haystack.equals(phrase);
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value.trim();
            }
        }
        return "";
    }

    private String preferredLocalizedValue(JsonNode localizedNode, String fallback) {
        if (localizedNode == null || localizedNode.isMissingNode() || localizedNode.isNull()) {
            return fallback;
        }
        String english = localizedNode.path("en").asText("");
        if (!english.isBlank()) {
            return english;
        }
        var values = localizedNode.elements();
        while (values.hasNext()) {
            String value = values.next().asText("");
            if (!value.isBlank()) {
                return value;
            }
        }
        return fallback;
    }

    private boolean isCloudflareChallenge(Document document) {
        if (document == null) {
            return false;
        }
        String title = normalizeString(document.title()).toLowerCase(Locale.ROOT);
        return title.contains("just a moment")
            || document.selectFirst("form#challenge-form") != null
            || document.text().toLowerCase(Locale.ROOT).contains("enable javascript and cookies to continue");
    }

    private String normalizeAnimePlanetUrl(String value) {
        String normalized = normalizeString(value);
        if (normalized.endsWith("/")) {
            return normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    private String animePlanetSlug(String url) {
        String normalized = normalizeAnimePlanetUrl(url);
        if (normalized.isBlank()) {
            return "";
        }
        try {
            String[] parts = URI.create(normalized).getPath().split("/");
            for (int index = 0; index < parts.length - 1; index++) {
                if ("manga".equalsIgnoreCase(parts[index])) {
                    return normalizeString(parts[index + 1]);
                }
            }
        } catch (Exception ignored) {
            return "";
        }
        return "";
    }

    private Map<String, String> readDefinitionMap(Document document) {
        Map<String, String> definitions = new LinkedHashMap<>();
        for (Element term : document.select("dt")) {
            String key = normalizeDefinitionKey(term.text());
            if (key.isBlank()) {
                continue;
            }
            Element valueNode = term.nextElementSibling();
            if (valueNode == null || !"dd".equalsIgnoreCase(valueNode.tagName())) {
                continue;
            }
            String value = normalizeString(valueNode.text());
            if (!value.isBlank() && !definitions.containsKey(key)) {
                definitions.put(key, value);
            }
        }
        return definitions;
    }

    private List<String> extractAnimePlanetAliases(Document document, Map<String, String> definitions) {
        List<String> aliases = new ArrayList<>();
        addAlias(aliases, definitions.get("alt titles"));
        addAlias(aliases, definitions.get("alternate titles"));
        addAlias(aliases, definitions.get("japanese title"));
        addAlias(aliases, definitions.get("english title"));
        addAlias(aliases, definitions.get("native title"));
        for (Element chip : document.select(".aka, .alternateTitles li, .entryBar .tags li")) {
            addAlias(aliases, chip.text());
        }
        return aliases.stream().distinct().filter((alias) -> !alias.isBlank()).toList();
    }

    private void addAlias(List<String> aliases, String rawValue) {
        String normalized = normalizeString(rawValue);
        if (normalized.isBlank()) {
            return;
        }
        for (String part : normalized.split("\\s*(?:,|;|/|\\||\\n)\\s*")) {
            String alias = normalizeString(part);
            if (!alias.isBlank()) {
                aliases.add(alias);
            }
        }
    }

    private String inferAnimePlanetType(Map<String, String> definitions) {
        return normalizeScopeLabel(firstNonBlank(
            definitions.get("type"),
            definitions.get("format")
        ));
    }

    private String inferAnimePlanetTypeFromDocument(Document document) {
        for (Element chip : document.select(".tags li, .entryBar .tags a, .entryBar .tags span")) {
            String value = normalizeScopeLabel(chip.text());
            if (!value.isBlank()) {
                return value;
            }
        }
        return "";
    }

    private String normalizeScopeLabel(String value) {
        String normalized = normalizeString(value).toLowerCase(Locale.ROOT);
        if (normalized.contains("webtoon")) {
            return "Webtoon";
        }
        if (normalized.contains("manhwa")) {
            return "Manhwa";
        }
        if (normalized.contains("manhua")) {
            return "Manhua";
        }
        if (normalized.contains("manga")) {
            return "Manga";
        }
        return "";
    }

    private String normalizeDefinitionKey(String value) {
        return normalizeString(value)
            .toLowerCase(Locale.ROOT)
            .replace(':', ' ')
            .replaceAll("\\s+", " ")
            .trim();
    }

    private String metaContent(Document document, String property) {
        if (document == null) {
            return "";
        }
        String escapedProperty = property.replace("\\", "\\\\").replace("\"", "\\\"");
        Element meta = document.selectFirst("meta[property=\"" + escapedProperty + "\"], meta[name=\"" + escapedProperty + "\"]");
        return meta == null ? "" : normalizeString(meta.attr("content"));
    }

    private String imageUrl(Element image) {
        if (image == null) {
            return "";
        }
        return firstNonBlank(
            normalizeString(image.absUrl("data-src")),
            normalizeString(image.absUrl("src")),
            normalizeString(image.attr("data-src")),
            normalizeString(image.attr("src"))
        );
    }

    private String text(Element element) {
        return element == null ? "" : normalizeString(element.text());
    }

    private String prettifySlug(String slug) {
        String normalized = normalizeString(slug).replace('-', ' ').trim();
        if (normalized.isBlank()) {
            return "";
        }
        String[] parts = normalized.split("\\s+");
        StringBuilder builder = new StringBuilder();
        for (String part : parts) {
            if (builder.length() > 0) {
                builder.append(' ');
            }
            builder.append(Character.toUpperCase(part.charAt(0)));
            if (part.length() > 1) {
                builder.append(part.substring(1));
            }
        }
        return builder.toString();
    }

    private List<String> collectMangaDexTags(JsonNode attributes) {
        List<String> tags = new ArrayList<>();
        for (JsonNode tag : attributes.path("tags")) {
            String value = preferredLocalizedValue(tag.path("attributes").path("name"), "");
            if (!value.isBlank()) {
                tags.add(value);
            }
        }
        return mergeUniqueStrings(tags);
    }

    private List<String> collectAltTitles(JsonNode altTitlesNode) {
        List<String> aliases = new ArrayList<>();
        if (altTitlesNode == null || altTitlesNode.isMissingNode() || altTitlesNode.isNull()) {
            return List.of();
        }
        if (altTitlesNode.isArray()) {
            altTitlesNode.forEach((entry) -> {
                String value = preferredLocalizedValue(entry, "");
                if (!value.isBlank()) {
                    aliases.add(value);
                }
            });
        }
        return mergeUniqueStrings(aliases);
    }

    private List<String> collectAniListTags(JsonNode tagsNode) {
        List<String> tags = new ArrayList<>();
        for (JsonNode tag : tagsNode) {
            if (tag.path("isGeneralSpoiler").asBoolean(false) || tag.path("isMediaSpoiler").asBoolean(false)) {
                continue;
            }
            String value = tag.path("name").asText("");
            if (!value.isBlank()) {
                tags.add(value);
            }
        }
        return mergeUniqueStrings(tags);
    }

    private List<String> extractAnimePlanetTags(Document document) {
        List<String> tags = new ArrayList<>();
        for (Element chip : document.select(".tags li, .entryBar .tags a, .entryBar .tags span")) {
            String value = normalizeString(chip.text());
            if (!value.isBlank()) {
                tags.add(value);
            }
        }
        return mergeUniqueStrings(tags);
    }

    private List<String> jsonTextList(JsonNode node) {
        List<String> values = new ArrayList<>();
        if (node == null || node.isMissingNode() || node.isNull()) {
            return List.of();
        }
        if (node.isArray()) {
            node.forEach((entry) -> {
                String value = entry.asText("");
                if (!value.isBlank()) {
                    values.add(value);
                }
            });
        }
        return mergeUniqueStrings(values);
    }

    private List<String> collectNamedValues(JsonNode node) {
        List<String> values = new ArrayList<>();
        if (node == null || node.isMissingNode() || node.isNull()) {
            return List.of();
        }
        if (node.isArray()) {
            node.forEach((entry) -> {
                String value = firstNonBlank(
                    entry.path("name").asText(""),
                    entry.path("title").asText(""),
                    entry.asText("")
                );
                if (!value.isBlank()) {
                    values.add(value);
                }
            });
        }
        return mergeUniqueStrings(values);
    }

    private List<String> splitDelimitedValues(String raw) {
        List<String> values = new ArrayList<>();
        String normalized = normalizeString(raw);
        if (normalized.isBlank()) {
            return List.of();
        }
        for (String part : normalized.split("\\s*(?:,|;|\\||\\n)\\s*")) {
            String value = normalizeString(part);
            if (!value.isBlank()) {
                values.add(value);
            }
        }
        return mergeUniqueStrings(values);
    }

    private List<String> mergeUniqueStrings(List<String>... valueSets) {
        Map<String, String> deduped = new LinkedHashMap<>();
        for (List<String> values : valueSets) {
            for (String value : values) {
                String normalized = normalizeString(value);
                if (!normalized.isBlank()) {
                    deduped.putIfAbsent(normalized.toLowerCase(Locale.ROOT), normalized);
                }
            }
        }
        return List.copyOf(deduped.values());
    }

    private String normalizeString(String value) {
        return value == null ? "" : value.trim();
    }

    private record RankedMetadataSearchResult(
        int score,
        int providerOrder,
        int resultOrder,
        Map<String, Object> payload
    ) {
    }

    private record EditionSignals(boolean colored, String label) {
        private static EditionSignals none() {
            return new EditionSignals(false, "");
        }
    }
}
