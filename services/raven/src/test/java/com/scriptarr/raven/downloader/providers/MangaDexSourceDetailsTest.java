package com.scriptarr.raven.downloader.providers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.net.http.HttpRequest;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

/** Every supported download provider must supply source identity to admin metadata verification. */
class MangaDexSourceDetailsTest {
    /** MangaDex source details preserve the actual title, aliases, creators, year and cover. */
    @Test void providesRichIdentityForMetadataRepair() {
        MangaDexDownloadProvider provider = new MangaDexDownloadProvider() {
            @Override protected JsonNode sendJson(HttpRequest request) {
                return new ObjectMapper().valueToTree(Map.of("data", Map.of(
                    "attributes", Map.of("title", Map.of("en", "Edition name"), "altTitles", List.of(Map.of("en", "Other name")),
                        "description", Map.of("en", "Source description"), "originalLanguage", "zh", "year", 2020, "status", "ongoing", "contentRating", "safe"),
                    "relationships", List.of(Map.of("type", "author", "attributes", Map.of("name", "Creator")),
                        Map.of("type", "cover_art", "attributes", Map.of("fileName", "cover.jpg"))))));
            }
        };
        var source = provider.getTitleDetails("https://mangadex.org/title/1930d635-b170-417f-b8a8-f84b881bcc7d");
        assertNotNull(source); assertEquals("Edition name", source.sourceTitle());
        assertEquals("2020", source.released()); assertEquals("Manhua", source.type());
        assertEquals(List.of("Creator"), source.authors()); assertTrue(source.associatedNames().contains("Other name"));
        assertFalse(source.coverUrl().isBlank()); assertEquals(false, source.adultContent());
    }
}
