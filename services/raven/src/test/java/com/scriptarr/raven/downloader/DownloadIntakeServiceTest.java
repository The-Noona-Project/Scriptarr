package com.scriptarr.raven.downloader;

import com.scriptarr.raven.downloader.providers.DownloadProvider;
import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.metadata.MetadataService;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Unit tests for Raven's grouped, edition-aware intake matching.
 */
class DownloadIntakeServiceTest {
    /**
     * Verify colored metadata prefers the colored WeebCentral target while the
     * plain edition remains a separate result when the provider exposes two
     * distinct title URLs.
     */
    @Test
    void searchSeparatesPlainAndColoredTargetsForOnePiece() {
        MetadataService metadataService = mock(MetadataService.class);
        DownloadProviderRegistry registry = mock(DownloadProviderRegistry.class);
        FakeDownloadProvider provider = new FakeDownloadProvider(
            List.of(
                candidate("One Piece", "https://weebcentral.com/series/plain-one-piece", "manga"),
                candidate("One Piece (Color)", "https://weebcentral.com/series/colored-one-piece", "manga")
            ),
            Map.of(
                "https://weebcentral.com/series/plain-one-piece",
                new TitleDetails("", "manga", List.of("One Piece"), "", "", false, true, false, List.of(), List.of()),
                "https://weebcentral.com/series/colored-one-piece",
                new TitleDetails("", "manga", List.of("One Piece Digital Colored Comics"), "", "", false, true, false, List.of(), List.of())
            )
        );
        when(registry.enabledProviders()).thenReturn(List.of(provider));
        when(metadataService.search("One Piece", null)).thenReturn(List.of(
            metadata("mangadex", "plain-md", "One Piece"),
            metadata("mangadex", "colored-md", "One Piece (Official Colored)")
        ));
        when(metadataService.seriesDetails("mangadex", "plain-md")).thenReturn(seriesDetails("One Piece", List.of("One Piece")));
        when(metadataService.seriesDetails("mangadex", "colored-md")).thenReturn(seriesDetails(
            "One Piece (Official Colored)",
            List.of("One Piece")
        ));

        DownloadIntakeService service = new DownloadIntakeService(metadataService, registry);

        List<Map<String, Object>> results = service.search("One Piece");

        assertEquals(2, results.size());
        Map<String, Object> plain = resultByUrl(results, "https://weebcentral.com/series/plain-one-piece");
        Map<String, Object> colored = resultByUrl(results, "https://weebcentral.com/series/colored-one-piece");
        assertNotNull(plain);
        assertNotNull(colored);
        assertEquals("One Piece", plain.get("canonicalTitle"));
        assertEquals("One Piece (Official Colored)", colored.get("canonicalTitle"));
        assertEquals("available", plain.get("availability"));
        assertEquals("available", colored.get("availability"));
        assertEquals("weebcentral::https://weebcentral.com/series/plain-one-piece", plain.get("workKey"));
        assertEquals("weebcentral::https://weebcentral.com/series/colored-one-piece", colored.get("workKey"));
    }

    /**
     * Verify Raven still resolves the colored provider target when the provider
     * only returns results for the stripped base title rather than the full
     * metadata edition string.
     */
    @Test
    void searchFallsBackToBaseTitleTermsForColoredMetadataQueries() {
        MetadataService metadataService = mock(MetadataService.class);
        DownloadProviderRegistry registry = mock(DownloadProviderRegistry.class);
        FakeDownloadProvider provider = new FakeDownloadProvider(
            Map.of(
                "One Piece", List.of(
                    candidate("One Piece", "https://weebcentral.com/series/plain-one-piece", "manga"),
                    candidate("One Piece (Color)", "https://weebcentral.com/series/colored-one-piece", "manga")
                )
            ),
            Map.of(
                "https://weebcentral.com/series/plain-one-piece",
                new TitleDetails("", "manga", List.of("One Piece"), "", "", false, true, false, List.of(), List.of()),
                "https://weebcentral.com/series/colored-one-piece",
                new TitleDetails("", "manga", List.of("One Piece Digital Colored Comics"), "", "", false, true, false, List.of(), List.of())
            )
        );
        when(registry.enabledProviders()).thenReturn(List.of(provider));
        when(metadataService.search("One Piece (Official Colored)", null)).thenReturn(List.of(
            metadata("mangadex", "colored-md", "One Piece (Official Colored)")
        ));
        when(metadataService.seriesDetails("mangadex", "colored-md")).thenReturn(seriesDetails(
            "One Piece (Official Colored)",
            List.of("One Piece")
        ));

        DownloadIntakeService service = new DownloadIntakeService(metadataService, registry);

        List<Map<String, Object>> results = service.search("One Piece (Official Colored)");

        assertEquals(1, results.size());
        assertEquals("https://weebcentral.com/series/colored-one-piece", results.getFirst().get("titleUrl"));
        assertEquals("available", results.getFirst().get("availability"));
    }

    /**
     * Verify multiple metadata rows that resolve to the same concrete provider
     * target collapse into one grouped intake result.
     */
    @Test
    void searchCollapsesDuplicateMetadataRowsByConcreteDownloadTarget() {
        MetadataService metadataService = mock(MetadataService.class);
        DownloadProviderRegistry registry = mock(DownloadProviderRegistry.class);
        FakeDownloadProvider provider = new FakeDownloadProvider(
            List.of(candidate("One Piece", "https://weebcentral.com/series/plain-one-piece", "manga")),
            Map.of(
                "https://weebcentral.com/series/plain-one-piece",
                new TitleDetails("", "manga", List.of("One Piece"), "", "", false, true, false, List.of(), List.of())
            )
        );
        when(registry.enabledProviders()).thenReturn(List.of(provider));
        when(metadataService.search("One Piece", null)).thenReturn(List.of(
            metadata("mangadex", "plain-md", "One Piece"),
            metadata("anilist", "plain-al", "One Piece")
        ));
        when(metadataService.seriesDetails("mangadex", "plain-md")).thenReturn(seriesDetails("One Piece", List.of("One Piece")));
        when(metadataService.seriesDetails("anilist", "plain-al")).thenReturn(seriesDetails("One Piece", List.of("One Piece")));

        DownloadIntakeService service = new DownloadIntakeService(metadataService, registry);

        List<Map<String, Object>> results = service.search("One Piece");

        assertEquals(1, results.size());
        Map<String, Object> grouped = results.getFirst();
        assertEquals("available", grouped.get("availability"));
        assertEquals(2, grouped.get("metadataMatchCount"));
        assertEquals("https://weebcentral.com/series/plain-one-piece", grouped.get("titleUrl"));
        assertEquals(2, ((List<?>) grouped.get("metadataMatches")).size());
    }

    /**
     * Verify grouped intake results keep the metadata row that best matches the
     * concrete provider target rather than surfacing a longer spin-off title as
     * the representative series.
     */
    @Test
    void searchPrefersBestRepresentativeMetadataWithinGroupedTarget() {
        MetadataService metadataService = mock(MetadataService.class);
        DownloadProviderRegistry registry = mock(DownloadProviderRegistry.class);
        FakeDownloadProvider provider = new FakeDownloadProvider(
            List.of(candidate("One Piece", "https://weebcentral.com/series/plain-one-piece", "manga")),
            Map.of(
                "https://weebcentral.com/series/plain-one-piece",
                new TitleDetails("", "manga", List.of("One Piece"), "", "", false, true, false, List.of(), List.of())
            )
        );
        when(registry.enabledProviders()).thenReturn(List.of(provider));
        when(metadataService.search("One Piece", null)).thenReturn(List.of(
            metadata("mangadex", "main-md", "One Piece"),
            metadata("mangadex", "academy-md", "One Piece Academy")
        ));
        when(metadataService.seriesDetails("mangadex", "main-md")).thenReturn(seriesDetails("One Piece", List.of("One Piece")));
        when(metadataService.seriesDetails("mangadex", "academy-md")).thenReturn(seriesDetails("One Piece Academy", List.of("One Piece")));

        DownloadIntakeService service = new DownloadIntakeService(metadataService, registry);

        List<Map<String, Object>> results = service.search("One Piece");

        assertEquals(1, results.size());
        Map<String, Object> grouped = results.getFirst();
        @SuppressWarnings("unchecked")
        Map<String, Object> representativeMetadata = (Map<String, Object>) grouped.get("metadata");
        assertEquals("One Piece", grouped.get("canonicalTitle"));
        assertEquals("One Piece", representativeMetadata.get("title"));
    }

    /**
     * Verify unmatched metadata rows remain available to moderation as
     * unavailable intake results instead of being dropped.
     */
    @Test
    void searchPreservesUnmatchedMetadataRowsAsUnavailableResults() {
        MetadataService metadataService = mock(MetadataService.class);
        DownloadProviderRegistry registry = mock(DownloadProviderRegistry.class);
        FakeDownloadProvider provider = new FakeDownloadProvider(List.of(), Map.of());
        when(registry.enabledProviders()).thenReturn(List.of(provider));
        when(metadataService.search("Missing", null)).thenReturn(List.of(
            metadata("mangadex", "missing-md", "Missing Title")
        ));
        when(metadataService.seriesDetails("mangadex", "missing-md")).thenReturn(seriesDetails("Missing Title", List.of()));

        DownloadIntakeService service = new DownloadIntakeService(metadataService, registry);

        List<Map<String, Object>> results = service.search("Missing");

        assertEquals(1, results.size());
        Map<String, Object> unavailable = results.getFirst();
        assertEquals("unavailable", unavailable.get("availability"));
        assertNull(unavailable.get("download"));
        assertEquals("mangadex::missing-md", unavailable.get("workKey"));
        assertEquals(1, unavailable.get("metadataMatchCount"));
    }

    /**
     * Verify bulk metadata resolution keeps the provider-browse target but only
     * returns one safe metadata snapshot when the target is confidently matched.
     */
    @Test
    void resolveBulkMetadataMatchesConcreteProviderTarget() {
        MetadataService metadataService = mock(MetadataService.class);
        DownloadProviderRegistry registry = mock(DownloadProviderRegistry.class);
        FakeDownloadProvider provider = new FakeDownloadProvider(
            List.of(candidate("One Piece (Color)", "https://weebcentral.com/series/colored-one-piece", "manga")),
            Map.of(
                "https://weebcentral.com/series/colored-one-piece",
                new TitleDetails("", "manga", List.of("One Piece Digital Colored Comics"), "", "", false, true, false, List.of(), List.of())
            )
        );
        when(registry.enabledProviders()).thenReturn(List.of(provider));
        when(metadataService.search("One Piece (Official Colored)", null)).thenReturn(List.of(
            metadata("mangadex", "colored-md", "One Piece (Official Colored)")
        ));
        when(metadataService.seriesDetails("mangadex", "colored-md")).thenReturn(seriesDetails(
            "One Piece (Official Colored)",
            List.of("One Piece")
        ));

        DownloadIntakeService service = new DownloadIntakeService(metadataService, registry);

        DownloadIntakeService.BulkMetadataResolution resolution = service.resolveBulkMetadata(
            "weebcentral",
            "https://weebcentral.com/series/colored-one-piece",
            "One Piece (Official Colored)",
            "Manga"
        );

        assertTrue(resolution.matched());
        assertEquals("colored-md", resolution.metadataSnapshot().get("providerSeriesId"));
        assertEquals("https://weebcentral.com/series/colored-one-piece", resolution.downloadSnapshot().get("titleUrl"));
    }

    /**
     * Verify grouped intake results rank an exact main-series title ahead of a
     * longer related work when the metadata provider returns the related title
     * first.
     */
    @Test
    void searchRanksExactNarutoAheadOfBoruto() {
        MetadataService metadataService = mock(MetadataService.class);
        DownloadProviderRegistry registry = mock(DownloadProviderRegistry.class);
        FakeDownloadProvider provider = new FakeDownloadProvider(
            List.of(
                candidate("Naruto (Color)", "https://weebcentral.com/series/naruto-colored", "manga"),
                candidate("Boruto: Naruto Next Generations", "https://weebcentral.com/series/boruto", "manga"),
                candidate("Naruto", "https://weebcentral.com/series/naruto", "manga")
            ),
            Map.of(
                "https://weebcentral.com/series/naruto-colored",
                new TitleDetails("", "manga", List.of("Naruto Digital Colored Comics"), "", "", false, true, false, List.of(), List.of()),
                "https://weebcentral.com/series/boruto",
                new TitleDetails("", "manga", List.of("Boruto: Naruto Next Generations"), "", "", false, true, false, List.of(), List.of()),
                "https://weebcentral.com/series/naruto",
                new TitleDetails("", "manga", List.of("Naruto"), "", "", false, true, false, List.of(), List.of())
            )
        );
        when(registry.enabledProviders()).thenReturn(List.of(provider));
        when(metadataService.search("Naruto", null)).thenReturn(List.of(
            metadata("mangadex", "naruto-color-md", "Naruto (Official Colored)"),
            metadata("mangadex", "boruto-md", "Boruto: Naruto Next Generations"),
            metadata("mangadex", "naruto-md", "Naruto")
        ));
        when(metadataService.seriesDetails("mangadex", "naruto-color-md")).thenReturn(seriesDetails(
            "Naruto (Official Colored)",
            List.of("Naruto")
        ));
        when(metadataService.seriesDetails("mangadex", "boruto-md")).thenReturn(seriesDetails(
            "Boruto: Naruto Next Generations",
            List.of("Boruto")
        ));
        when(metadataService.seriesDetails("mangadex", "naruto-md")).thenReturn(seriesDetails("Naruto", List.of("Naruto")));

        DownloadIntakeService service = new DownloadIntakeService(metadataService, registry);

        List<Map<String, Object>> results = service.search("Naruto");

        assertEquals(3, results.size());
        assertEquals("Naruto", results.getFirst().get("canonicalTitle"));
        assertEquals("Naruto (Official Colored)", results.get(1).get("canonicalTitle"));
        assertEquals("Boruto: Naruto Next Generations", results.get(2).get("canonicalTitle"));
    }

    private Map<String, Object> metadata(String provider, String providerSeriesId, String title) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("provider", provider);
        payload.put("providerSeriesId", providerSeriesId);
        payload.put("title", title);
        payload.put("type", "manga");
        payload.put("coverUrl", "https://covers.example/" + providerSeriesId + ".jpg");
        return payload;
    }

    private Map<String, Object> seriesDetails(String title, List<String> aliases) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("title", title);
        payload.put("aliases", aliases);
        payload.put("summary", title + " summary");
        payload.put("type", "manga");
        payload.put("url", "https://metadata.example/" + title.replace(' ', '-'));
        payload.put("coverUrl", "https://covers.example/" + title.replace(' ', '-') + ".jpg");
        return payload;
    }

    private Map<String, String> candidate(String title, String href, String type) {
        Map<String, String> payload = new LinkedHashMap<>();
        payload.put("title", title);
        payload.put("href", href);
        payload.put("type", type);
        payload.put("coverUrl", "https://covers.example/" + title.replace(' ', '-') + ".jpg");
        return payload;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> resultByUrl(List<Map<String, Object>> results, String titleUrl) {
        return results.stream()
            .filter((result) -> titleUrl.equals(result.get("titleUrl")))
            .findFirst()
            .orElse(null);
    }

    /**
     * Minimal Raven download-provider test double used to exercise intake
     * scoring and grouping without touching the network.
     */
    private static final class FakeDownloadProvider implements DownloadProvider {
        private final Map<String, List<Map<String, String>>> searchResultsByQuery;
        private final Map<String, TitleDetails> detailsByUrl;

        private FakeDownloadProvider(List<Map<String, String>> searchResults, Map<String, TitleDetails> detailsByUrl) {
            this(Map.of("*", List.copyOf(searchResults)), detailsByUrl);
        }

        private FakeDownloadProvider(
            Map<String, List<Map<String, String>>> searchResultsByQuery,
            Map<String, TitleDetails> detailsByUrl
        ) {
            this.searchResultsByQuery = Map.copyOf(searchResultsByQuery);
            this.detailsByUrl = Map.copyOf(detailsByUrl);
        }

        @Override
        public String id() {
            return "weebcentral";
        }

        @Override
        public String name() {
            return "WeebCentral";
        }

        @Override
        public boolean supportsUrl(String titleUrl) {
            return titleUrl != null && titleUrl.contains("weebcentral");
        }

        @Override
        public List<Map<String, String>> searchTitles(String query) {
            if (query == null) {
                return searchResultsByQuery.getOrDefault("*", List.of());
            }
            return searchResultsByQuery.getOrDefault(query, searchResultsByQuery.getOrDefault("*", List.of()));
        }

        @Override
        public TitleDetails getTitleDetails(String titleUrl) {
            return detailsByUrl.get(titleUrl);
        }

        @Override
        public List<Map<String, String>> getChapters(String titleUrl) {
            return List.of();
        }

        @Override
        public List<String> resolvePages(String chapterUrl) {
            return List.of();
        }
    }
}
