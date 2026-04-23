package com.scriptarr.raven.metadata;

import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.metadata.providers.ComicVineProvider;
import com.scriptarr.raven.metadata.providers.MangaDexProvider;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Unit tests for Raven's type-aware metadata behavior.
 */
class MetadataServiceTest {
    /**
     * Verify identify rejects providers that do not support the title's stored
     * library type and accepts supported providers.
     *
     * @param tempDir temporary test directory
     */
    @Test
    void identifyEnforcesProviderScopesAgainstStoredLibraryType(@TempDir Path tempDir) {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);

        LibraryService libraryService = new LibraryService(
            brokerClient,
            new RavenSettingsService(brokerClient, logger, List.of()),
            logger
        );
        LibraryTitle comicTitle = new LibraryTitle(
            "title-1",
            "Blacksad",
            "comic",
            "Comic",
            "comic",
            "active",
            "1",
            "#4f8f88",
            "",
            "",
            1,
            1,
            "",
            List.of(),
            List.of(),
            "",
            null,
            List.of(),
            "https://weebcentral.com/series/blacksad",
            "",
            "",
            tempDir.resolve("downloaded").resolve("comic").resolve("Blacksad").toString(),
            List.of(new LibraryChapter("title-1-c1", "Chapter 1", "1", 1, null, true, "", ""))
        );
        brokerClient.setLibraryTitle(comicTitle);

        RavenSettingsService settingsService = new RavenSettingsService(
            brokerClient,
            logger,
            List.of(new MangaDexProvider(), new ComicVineProvider())
        );
        MetadataService service = new MetadataService(
            List.of(new MangaDexProvider(), new ComicVineProvider()),
            settingsService,
            brokerClient,
            libraryService,
            logger
        ) {
            @Override
            public Map<String, Object> seriesDetails(String provider, String providerSeriesId) {
                return Map.of(
                    "provider", provider,
                    "providerSeriesId", providerSeriesId,
                    "title", "Blacksad",
                    "summary", "Noir detective comic.",
                    "books", List.of()
                );
            }
        };

        Map<String, Object> rejected = service.identify("mangadex", "md-1", null, "title-1");
        assertEquals(false, rejected.get("ok"));
        assertTrue(String.valueOf(rejected.get("error")).contains("does not support"));

        Map<String, Object> accepted = service.identify("comicvine", "cv-1", null, "title-1");
        assertEquals(true, accepted.get("ok"));
        assertFalse(brokerClient.getMetadataMatch("title-1").path("provider").asText("").isBlank());
    }

    /**
     * Verify provider lifecycle labels are normalized onto the stored Raven
     * title when metadata is applied.
     *
     * @param tempDir temporary test directory
     */
    @Test
    void identifyPersistsNormalizedLifecycleStatus(@TempDir Path tempDir) {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);

        LibraryService libraryService = new LibraryService(
            brokerClient,
            new RavenSettingsService(brokerClient, logger, List.of(new MangaDexProvider())),
            logger
        );
        brokerClient.setLibraryTitle(new LibraryTitle(
            "title-2",
            "One Piece",
            "manga",
            "Manga",
            "manga",
            "active",
            "1111",
            "#de6d3a",
            "",
            "",
            10,
            10,
            "",
            List.of(),
            List.of(),
            "",
            null,
            List.of(),
            "https://weebcentral.com/series/one-piece",
            "",
            "",
            tempDir.resolve("downloaded").resolve("manga").resolve("One_Piece").toString(),
            List.of(new LibraryChapter("title-2-c1", "Chapter 1", "1", 1, null, true, "", ""))
        ));

        MetadataService service = new MetadataService(
            List.of(new MangaDexProvider()),
            new RavenSettingsService(brokerClient, logger, List.of(new MangaDexProvider())),
            brokerClient,
            libraryService,
            logger
        ) {
            @Override
            public Map<String, Object> seriesDetails(String provider, String providerSeriesId) {
                return Map.of(
                    "provider", provider,
                    "providerSeriesId", providerSeriesId,
                    "title", "One Piece",
                    "summary", "Pirates on the Grand Line.",
                    "status", "Finished",
                    "books", List.of()
                );
            }
        };

        Map<String, Object> accepted = service.identify("mangadex", "md-2", null, "title-2");

        assertEquals(true, accepted.get("ok"));
        assertEquals("completed", libraryService.findTitle("title-2").status());
    }

    /**
     * Verify metadata search ranks the exact main-series title ahead of related
     * works and drops irrelevant generic Anime-Planet result rows.
     */
    @Test
    void searchRanksExactNarutoAheadOfBorutoAndFiltersGenericNoise() {
        RavenSettingsService settingsService = mock(RavenSettingsService.class);
        when(settingsService.getMetadataProviderSettings()).thenReturn(List.of(
            Map.of("id", "mangadex", "enabled", true),
            Map.of("id", "animeplanet", "enabled", true)
        ));
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        MetadataService service = new MetadataService(
            List.of(),
            settingsService,
            mock(RavenBrokerClient.class),
            mock(LibraryService.class),
            logger
        ) {
            @Override
            protected List<Map<String, Object>> searchProvider(String providerId, String name) {
                if ("mangadex".equalsIgnoreCase(providerId)) {
                    return List.of(
                        searchResult("mangadex", "boruto-md", "Boruto: Naruto Next Generations"),
                        searchResult("mangadex", "naruto-md", "Naruto"),
                        searchResult("mangadex", "naruto-color-md", "Naruto (Official Colored)")
                    );
                }
                if ("animeplanet".equalsIgnoreCase(providerId)) {
                    return List.of(
                        searchResult("animeplanet", "read-manga-online", "Read manga online"),
                        searchResult("animeplanet", "naruto-ap", "Naruto"),
                        searchResult("animeplanet", "manga-recommendations", "Manga recommendations")
                    );
                }
                return List.of();
            }
        };

        List<Map<String, Object>> results = service.search("Naruto", null);
        List<String> titles = results.stream().map((entry) -> String.valueOf(entry.get("title"))).toList();

        assertFalse(results.isEmpty());
        assertEquals("Naruto", results.getFirst().get("title"));
        assertTrue(titles.indexOf("Naruto (Official Colored)") > titles.indexOf("Naruto"));
        assertTrue(titles.indexOf("Naruto (Official Colored)") < titles.indexOf("Boruto: Naruto Next Generations"));
        assertTrue(results.stream().noneMatch((entry) -> "Read manga online".equals(entry.get("title"))));
        assertTrue(results.stream().noneMatch((entry) -> "Manga recommendations".equals(entry.get("title"))));
        assertTrue(results.stream().anyMatch((entry) -> "Boruto: Naruto Next Generations".equals(entry.get("title"))));
    }

    private Map<String, Object> searchResult(String provider, String providerSeriesId, String title) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("provider", provider);
        payload.put("providerSeriesId", providerSeriesId);
        payload.put("title", title);
        payload.put("url", "https://metadata.example/" + providerSeriesId);
        return payload;
    }
}
