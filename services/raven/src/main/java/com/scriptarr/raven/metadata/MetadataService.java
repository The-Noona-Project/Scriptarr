package com.scriptarr.raven.metadata;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.settings.RavenVaultClient;
import com.scriptarr.raven.support.ScriptarrLogger;
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
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Aggregates Raven metadata providers and normalizes their API payloads.
 */
@Service
public class MetadataService {
    private final List<MetadataProvider> providers;
    private final RavenSettingsService settingsService;
    private final RavenVaultClient vaultClient;
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
     * @param vaultClient Vault-backed Raven persistence client
     * @param libraryService Raven library service
     * @param logger shared Raven logger
     */
    public MetadataService(
        List<MetadataProvider> providers,
        RavenSettingsService settingsService,
        RavenVaultClient vaultClient,
        LibraryService libraryService,
        ScriptarrLogger logger
    ) {
        this.providers = List.copyOf(providers);
        this.settingsService = settingsService;
        this.vaultClient = vaultClient;
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
        List<Map<String, Object>> results = new ArrayList<>();
        for (Map<String, Object> provider : describeProviders()) {
            String providerId = String.valueOf(provider.get("id"));
            boolean enabled = Boolean.TRUE.equals(provider.get("enabled"));
            if (!enabled) {
                continue;
            }
            if (requestedProvider != null && !requestedProvider.isBlank() && !providerId.equalsIgnoreCase(requestedProvider.trim())) {
                continue;
            }
            try {
                results.addAll(searchProvider(providerId, name));
            } catch (Exception error) {
                logger.warn("METADATA", "Metadata provider search failed.", providerId + ": " + error.getMessage());
            }
        }
        return List.copyOf(results);
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
            vaultClient.putMetadataMatch(effectiveTitleId, Map.of(
                "provider", provider,
                "providerSeriesId", providerSeriesId,
                "details", details
            ));
            libraryService.applyMetadata(effectiveTitleId, provider, matchedAt, normalizeAppliedMetadata(details));
            return Map.of(
                "ok", true,
                "provider", provider,
                "providerSeriesId", providerSeriesId,
                "seriesId", seriesId,
                "libraryId", effectiveTitleId,
                "matchedAt", matchedAt,
                "details", details,
                "message", "Raven applied the selected metadata match."
            );
        } catch (Exception error) {
            logger.warn("METADATA", "Metadata identify failed.", error.getMessage());
            return Map.of(
                "ok", false,
                "provider", provider,
                "providerSeriesId", providerSeriesId,
                "libraryId", effectiveTitleId,
                "error", error.getMessage()
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

    private List<Map<String, Object>> searchProvider(String providerId, String name) throws IOException, InterruptedException {
        return switch (providerId.toLowerCase(Locale.ROOT)) {
            case "mangadex" -> searchMangaDex(name);
            case "anilist" -> searchAniList(name);
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
            String title = entry.path("attributes").path("title").path("en").asText(id);
            results.add(Map.of(
                "provider", "mangadex",
                "providerSeriesId", id,
                "title", title,
                "url", "https://mangadex.org/title/" + id
            ));
        }
        return results;
    }

    private Map<String, Object> fetchMangaDexSeriesDetails(String providerSeriesId) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create("https://api.mangadex.org/manga/" + providerSeriesId))
            .timeout(Duration.ofSeconds(15))
            .GET()
            .build();
        JsonNode root = sendJson(request).path("data");
        return Map.of(
            "provider", "mangadex",
            "providerSeriesId", providerSeriesId,
            "title", root.path("attributes").path("title").path("en").asText(providerSeriesId),
            "summary", root.path("attributes").path("description").path("en").asText(""),
            "aliases", List.of(),
            "books", List.of()
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
                "url", entry.path("siteUrl").asText("https://anilist.co/manga/" + id)
            ));
        }
        return results;
    }

    private Map<String, Object> fetchAniListSeriesDetails(String providerSeriesId) throws IOException, InterruptedException {
        String query = "query ($id: Int) { Media(id: $id, type: MANGA) { id title { romaji english } siteUrl } }";
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
        return Map.of(
            "provider", "anilist",
            "providerSeriesId", providerSeriesId,
            "title", media.path("title").path("english").asText(media.path("title").path("romaji").asText(providerSeriesId)),
            "url", media.path("siteUrl").asText("https://anilist.co/manga/" + providerSeriesId),
            "summary", media.path("description").asText(""),
            "aliases", List.of(
                media.path("title").path("english").asText(""),
                media.path("title").path("romaji").asText("")
            ).stream().filter((value) -> !value.isBlank()).toList(),
            "books", List.of()
        );
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
        return Map.of(
            "provider", "mangaupdates",
            "providerSeriesId", providerSeriesId,
            "title", result.path("title").asText(providerSeriesId),
            "summary", result.path("description").asText(""),
            "releaseLabel", result.path("year").asText(""),
            "author", result.path("authors").isArray() && result.path("authors").size() > 0
                ? result.path("authors").get(0).path("name").asText("")
                : "",
            "aliases", aliases.stream().filter((alias) -> !alias.isBlank()).toList(),
            "books", List.of()
        );
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
                + "?fields=alternative_titles,start_date,synopsis,authors{first_name,last_name},main_picture,media_type,status,num_volumes,num_chapters"))
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
        return Map.of(
            "provider", "mal",
            "providerSeriesId", providerSeriesId,
            "title", result.path("title").asText(providerSeriesId),
            "summary", result.path("synopsis").asText(""),
            "releaseLabel", result.path("start_date").asText(""),
            "author", author,
            "aliases", aliases.stream().filter((alias) -> !alias.isBlank()).toList(),
            "books", List.of()
        );
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
            "books", List.of()
        );
    }

    private Map<String, Object> normalizeAppliedMetadata(Map<String, Object> details) {
        return Map.of(
            "title", String.valueOf(details.getOrDefault("title", "")),
            "summary", String.valueOf(details.getOrDefault("summary", "")),
            "releaseLabel", String.valueOf(details.getOrDefault("releaseLabel", "")),
            "author", String.valueOf(details.getOrDefault("author", "")),
            "aliases", details.getOrDefault("aliases", List.of()),
            "relations", details.getOrDefault("relations", List.of())
        );
    }

    private JsonNode sendJson(HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        return objectMapper.readTree(response.body());
    }
}
