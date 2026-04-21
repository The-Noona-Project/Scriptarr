package com.scriptarr.raven.downloader.providers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.downloader.TitleDetails;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * MangaDex download provider implementation backed by the public MangaDex API.
 */
@Component
public class MangaDexDownloadProvider implements DownloadProvider {
    private static final String API_BASE_URL = "https://api.mangadex.org";
    private static final String SITE_BASE_URL = "https://mangadex.org";
    private static final String COVER_BASE_URL = "https://uploads.mangadex.org/covers";
    private static final String USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(30);
    private static final int CHAPTER_PAGE_SIZE = 100;

    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build();
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public String id() {
        return "mangadex";
    }

    @Override
    public String name() {
        return "MangaDex";
    }

    @Override
    public boolean supportsUrl(String titleUrl) {
        if (titleUrl == null || titleUrl.isBlank()) {
            return false;
        }
        try {
            String host = URI.create(titleUrl.trim()).getHost();
            return host != null && host.toLowerCase(Locale.ROOT).contains("mangadex.org");
        } catch (Exception ignored) {
            return false;
        }
    }

    @Override
    public List<Map<String, String>> searchTitles(String query) {
        if (query == null || query.isBlank()) {
            return List.of();
        }

        try {
            JsonNode root = sendJson(buildRequest(
                API_BASE_URL + "/manga?limit=10&includes[]=cover_art"
                    + "&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic"
                    + "&title=" + URLEncoder.encode(query.trim(), StandardCharsets.UTF_8)
            ));
            List<Map<String, String>> results = new ArrayList<>();
            for (JsonNode entry : root.path("data")) {
                results.add(buildSearchResult(entry));
            }
            return List.copyOf(results);
        } catch (Exception ignored) {
            return List.of();
        }
    }

    @Override
    public TitleDetails getTitleDetails(String titleUrl) {
        String mangaId = extractEntityId(titleUrl, "title");
        if (mangaId.isBlank()) {
            return null;
        }

        try {
            JsonNode entry = sendJson(buildRequest(
                API_BASE_URL + "/manga/" + mangaId + "?includes[]=cover_art&includes[]=author&includes[]=artist"
            )).path("data");
            JsonNode attributes = entry.path("attributes");
            Set<String> associatedNames = new LinkedHashSet<>();
            addIfPresent(associatedNames, preferredLocalizedValue(attributes.path("title"), mangaId));
            associatedNames.addAll(collectAltTitles(attributes.path("altTitles")));
            String summary = preferredLocalizedValue(attributes.path("description"), "");
            return new TitleDetails(
                summary,
                inferType(attributes),
                List.copyOf(associatedNames),
                attributes.path("status").asText(""),
                attributes.path("year").asText(""),
                isAdultContent(attributes.path("contentRating").asText("")),
                Boolean.TRUE,
                false,
                List.of()
            );
        } catch (Exception ignored) {
            return null;
        }
    }

    @Override
    public List<Map<String, String>> getChapters(String titleUrl) {
        String mangaId = extractEntityId(titleUrl, "title");
        if (mangaId.isBlank()) {
            return List.of();
        }

        try {
            List<Map<String, String>> chapters = new ArrayList<>();
            Set<String> seenChapterIds = new LinkedHashSet<>();
            int offset = 0;
            int total = Integer.MAX_VALUE;

            while (offset < total) {
                JsonNode root = sendJson(buildRequest(
                    API_BASE_URL + "/manga/" + mangaId + "/feed?limit=" + CHAPTER_PAGE_SIZE
                        + "&offset=" + offset
                        + "&translatedLanguage[]=en"
                        + "&order[volume]=asc&order[chapter]=asc&order[publishAt]=asc"
                        + "&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic"
                ));
                JsonNode data = root.path("data");
                if (!data.isArray() || data.isEmpty()) {
                    break;
                }
                total = root.path("total").asInt(offset + data.size());

                for (JsonNode chapterNode : data) {
                    String chapterId = chapterNode.path("id").asText("");
                    if (chapterId.isBlank() || !seenChapterIds.add(chapterId)) {
                        continue;
                    }
                    JsonNode attributes = chapterNode.path("attributes");
                    if (!isReadableChapter(attributes)) {
                        continue;
                    }
                    String chapterNumber = normalizeChapterNumber(attributes.path("chapter").asText(""));
                    Map<String, String> payload = new LinkedHashMap<>();
                    payload.put("chapter_number", chapterNumber.isBlank() ? String.valueOf(chapters.size() + 1) : chapterNumber);
                    payload.put("chapter_title", chapterLabel(attributes, chapterNumber));
                    payload.put("href", SITE_BASE_URL + "/chapter/" + chapterId);
                    payload.put("volume_number", normalizeVolumeNumber(attributes.path("volume").asText("")));
                    addIfPresent(payload, "release_date", firstNonBlank(
                        attributes.path("publishAt").asText(""),
                        attributes.path("readableAt").asText(""),
                        attributes.path("updatedAt").asText("")
                    ));
                    chapters.add(payload);
                }

                offset += data.size();
            }

            return List.copyOf(chapters);
        } catch (Exception ignored) {
            return List.of();
        }
    }

    @Override
    public List<String> resolvePages(String chapterUrl) {
        String chapterId = extractEntityId(chapterUrl, "chapter");
        if (chapterId.isBlank()) {
            return List.of();
        }

        try {
            JsonNode root = sendJson(buildRequest(API_BASE_URL + "/at-home/server/" + chapterId));
            String baseUrl = root.path("baseUrl").asText("");
            JsonNode chapter = root.path("chapter");
            String hash = chapter.path("hash").asText("");
            JsonNode data = chapter.path("data");
            if (baseUrl.isBlank() || hash.isBlank() || !data.isArray() || data.isEmpty()) {
                return List.of();
            }

            List<String> pages = new ArrayList<>();
            for (JsonNode image : data) {
                String fileName = image.asText("");
                if (fileName.isBlank()) {
                    continue;
                }
                pages.add(baseUrl + "/data/" + hash + "/" + fileName);
            }
            return List.copyOf(pages);
        } catch (Exception ignored) {
            return List.of();
        }
    }

    private HttpRequest buildRequest(String url) {
        return HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(REQUEST_TIMEOUT)
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT)
            .GET()
            .build();
    }

    private JsonNode sendJson(HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() >= 400) {
            throw new IOException("MangaDex returned HTTP " + response.statusCode() + ".");
        }
        return objectMapper.readTree(response.body());
    }

    private Map<String, String> buildSearchResult(JsonNode entry) {
        String mangaId = entry.path("id").asText("");
        JsonNode attributes = entry.path("attributes");
        Map<String, String> payload = new LinkedHashMap<>();
        payload.put("title", preferredLocalizedValue(attributes.path("title"), mangaId));
        payload.put("href", SITE_BASE_URL + "/title/" + mangaId);
        payload.put("type", inferType(attributes));
        addIfPresent(payload, "coverUrl", buildCoverUrl(mangaId, extractCoverFileName(entry.path("relationships"))));
        return payload;
    }

    private String extractEntityId(String url, String segment) {
        if (url == null || url.isBlank()) {
            return "";
        }
        try {
            String[] parts = URI.create(url.trim()).getPath().split("/");
            for (int index = 0; index < parts.length - 1; index++) {
                if (segment.equalsIgnoreCase(parts[index])) {
                    return parts[index + 1];
                }
            }
        } catch (Exception ignored) {
            return "";
        }
        return "";
    }

    private String extractCoverFileName(JsonNode relationships) {
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

    private String buildCoverUrl(String mangaId, String fileName) {
        if (mangaId == null || mangaId.isBlank() || fileName == null || fileName.isBlank()) {
            return "";
        }
        return COVER_BASE_URL + "/" + mangaId + "/" + fileName;
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

    private List<String> collectAltTitles(JsonNode altTitles) {
        if (altTitles == null || !altTitles.isArray()) {
            return List.of();
        }
        Set<String> aliases = new LinkedHashSet<>();
        for (JsonNode entry : altTitles) {
            if (!entry.isObject()) {
                continue;
            }
            entry.fields().forEachRemaining((field) -> addIfPresent(aliases, field.getValue().asText("")));
        }
        return List.copyOf(aliases);
    }

    private String inferType(JsonNode attributes) {
        String originalLanguage = attributes.path("originalLanguage").asText("").toLowerCase(Locale.ROOT);
        String countryOfOrigin = attributes.path("countryOfOrigin").asText("").toLowerCase(Locale.ROOT);
        Set<String> tags = new LinkedHashSet<>();
        for (JsonNode tag : attributes.path("tags")) {
            String value = preferredLocalizedValue(tag.path("attributes").path("name"), "").toLowerCase(Locale.ROOT);
            if (!value.isBlank()) {
                tags.add(value);
            }
        }
        if (tags.contains("long strip") || tags.contains("web comic")) {
            return "Webtoon";
        }
        if ("kr".equals(countryOfOrigin) || "ko".equals(originalLanguage)) {
            return "Manhwa";
        }
        if ("cn".equals(countryOfOrigin) || "zh".equals(originalLanguage)) {
            return "Manhua";
        }
        return "Manga";
    }

    private boolean isAdultContent(String contentRating) {
        String normalized = contentRating == null ? "" : contentRating.trim().toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case "suggestive", "erotica", "pornographic" -> true;
            default -> false;
        };
    }

    private boolean isReadableChapter(JsonNode attributes) {
        if (attributes == null || attributes.isMissingNode() || attributes.isNull()) {
            return false;
        }
        if (!"en".equalsIgnoreCase(attributes.path("translatedLanguage").asText(""))) {
            return false;
        }
        if (attributes.path("isUnavailable").asBoolean(false)) {
            return false;
        }
        if (!attributes.path("externalUrl").asText("").isBlank()) {
            return false;
        }
        return attributes.path("pages").asInt(0) > 0;
    }

    private String chapterLabel(JsonNode attributes, String chapterNumber) {
        String chapterTitle = attributes.path("title").asText("").trim();
        if (!chapterTitle.isBlank()) {
            return chapterTitle;
        }
        return "Chapter " + (chapterNumber.isBlank() ? "0" : chapterNumber);
    }

    private String normalizeChapterNumber(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        try {
            return new java.math.BigDecimal(value.trim()).stripTrailingZeros().toPlainString();
        } catch (NumberFormatException ignored) {
            return value.trim();
        }
    }

    private String normalizeVolumeNumber(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        try {
            String normalized = new java.math.BigDecimal(value.trim()).stripTrailingZeros().toPlainString();
            return "0".equals(normalized) ? "" : normalized;
        } catch (NumberFormatException ignored) {
            return value.trim();
        }
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value.trim();
            }
        }
        return "";
    }

    private void addIfPresent(Set<String> target, String value) {
        if (value != null && !value.isBlank()) {
            target.add(value.trim());
        }
    }

    private void addIfPresent(Map<String, String> target, String key, String value) {
        if (value != null && !value.isBlank()) {
            target.put(key, value.trim());
        }
    }
}
