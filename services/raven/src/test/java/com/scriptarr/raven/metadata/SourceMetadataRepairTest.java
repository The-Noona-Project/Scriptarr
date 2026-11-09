package com.scriptarr.raven.metadata;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.downloader.TitleDetails;
import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.library.LibraryService;
import com.scriptarr.raven.library.LibraryTitle;
import com.scriptarr.raven.metadata.providers.MangaDexProvider;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Identification must persist reusable source evidence and remove the unrelated work's presentation. */
class SourceMetadataRepairTest {
    private static final String URL = "https://weebcentral.com/series/01J76XYDQHSY9H2V7050NC7843/The-Kings-Avatar-Reboot";

    /** Repair changes tags and art without replacing canonical identity or content rows. */
    @Test void repairRoundTripsBindingAndClearsUnrelatedTags(@TempDir Path root) {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
        RavenSettingsService settings = new RavenSettingsService(broker, logger, List.of());
        LibraryService library = new LibraryService(broker, settings, logger);
        Map<String, Object> raw = new java.util.LinkedHashMap<>();
        raw.put("id", "canonical"); raw.put("title", "Avatar"); raw.put("mediaType", "manhua");
        raw.put("libraryTypeLabel", "Manhua"); raw.put("libraryTypeSlug", "manhua"); raw.put("sourceUrl", URL);
        raw.put("tags", List.of("Aliens")); raw.put("aliases", List.of("retained-alias")); raw.put("relations", List.of());
        raw.put("chapters", List.of()); raw.put("coverUrl", "https://example.org/wrong-avatar.jpg");
        library.upsertTitle(new ObjectMapper().convertValue(raw, LibraryTitle.class));
        DownloadProvider sourceProvider = mock(DownloadProvider.class);
        when(sourceProvider.id()).thenReturn("weebcentral");
        when(sourceProvider.getTitleDetails(URL)).thenReturn(new TitleDetails("A player returns to Glory.", "Manhua", List.of("The King's Avatar (2020)"), "Ongoing", "2020",
            false, true, false, List.of("Action"), List.of(), "The King's Avatar (Reboot)", List.of("Hudie Lan"), "https://example.org/source-cover.jpg"));
        DownloadProviderRegistry registry = mock(DownloadProviderRegistry.class);
        when(registry.resolve("", URL)).thenReturn(Optional.of(sourceProvider));
        MetadataService service = new MetadataService(List.of(new MangaDexProvider()), settings, broker, library, logger, registry) {
            @Override public Map<String, Object> seriesDetails(String provider, String id) {
                return Map.of("provider", provider, "providerSeriesId", id, "title", "The King's Avatar", "aliases", List.of("The King's Avatar"),
                    "releaseLabel", "2020", "type", "Manhua", "tags", List.of("Video Games"), "coverUrl", "https://example.org/reboot.jpg");
            }
        };
        try {
            assertEquals(true, service.identify("mangadex", "2020", "canonical", "canonical").get("ok"));
            LibraryTitle repaired = library.findTitle("canonical");
            assertEquals("canonical", repaired.id()); assertEquals(URL, repaired.sourceUrl());
            assertEquals("The King's Avatar (Reboot)", repaired.title());
            assertEquals(List.of("Video Games", "Action"), repaired.tags());
            assertEquals("https://example.org/reboot.jpg", repaired.coverUrl());
            assertTrue(repaired.aliases().contains("retained-alias"));
            Map<String, Object> binding = service.storedSourceSelection("canonical", URL);
            assertEquals("2020", binding.get("providerSeriesId"));
            assertTrue(binding.containsKey("sourceBinding"));
            assertEquals(true, service.sourceEvidence("canonical").get("matchesSaved"));
            assertTrue(service.storedSourceSelection("canonical", URL + "-other").isEmpty());
            broker.putMetadataMatch("canonical", Map.of("provider", "mangadex", "providerSeriesId", "different-edition", "details", binding));
            assertThrows(IllegalStateException.class, () -> service.storedSourceSelection("canonical", URL));
        } finally { library.shutdownCatalogScanExecutor(); }
    }
}
