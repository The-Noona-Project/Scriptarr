package com.scriptarr.raven.metadata;

import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.metadata.providers.ComicVineProvider;
import com.scriptarr.raven.metadata.providers.MangaDexProvider;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
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
}
