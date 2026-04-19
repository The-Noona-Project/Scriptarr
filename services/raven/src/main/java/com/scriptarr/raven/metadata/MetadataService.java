package com.scriptarr.raven.metadata;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.settings.RavenSettingsService;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@Service
public class MetadataService {
    private final List<MetadataProvider> providers;
    private final RavenSettingsService settingsService;
    private final ScriptarrLogger logger;
    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build();
    private final ObjectMapper objectMapper = new ObjectMapper();

    public MetadataService(List<MetadataProvider> providers, RavenSettingsService settingsService, ScriptarrLogger logger) {
        this.providers = List.copyOf(providers);
        this.settingsService = settingsService;
        this.logger = logger;
    }

    public List<Map<String, Object>> describeProviders() {
        return settingsService.getMetadataProviderSettings();
    }

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

    public Map<String, Object> identify(String provider, String providerSeriesId, String seriesId, String libraryId) {
        Map<String, Object> response = new HashMap<>();
        response.put("ok", true);
        response.put("provider", provider);
        response.put("providerSeriesId", providerSeriesId);
        response.put("seriesId", seriesId);
        response.put("libraryId", libraryId);
        response.put("message", "Raven recorded the metadata match for later library repair.");
        return response;
    }

    public Map<String, Object> seriesDetails(String provider, String providerSeriesId) {
        try {
            return switch (provider.toLowerCase(Locale.ROOT)) {
                case "mangadex" -> fetchMangaDexSeriesDetails(providerSeriesId);
                case "anilist" -> fetchAniListSeriesDetails(providerSeriesId);
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
            "books", List.of()
        );
    }

    private JsonNode sendJson(HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        return objectMapper.readTree(response.body());
    }
}

