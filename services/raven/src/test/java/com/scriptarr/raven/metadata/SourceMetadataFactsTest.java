package com.scriptarr.raven.metadata;

import com.scriptarr.raven.downloader.TitleDetails;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

/** Regression evidence for distinct editions, safe fallback, and uncontaminated tags. */
class SourceMetadataFactsTest {
    private static final String URL = "https://weebcentral.com/series/01J76XYDQHSY9H2V7050NC7843/The-Kings-Avatar-Reboot";

    /** A declared year alias anchors the 2020 remake without inventing a Reboot metadata tag. */
    @Test void distinguishesOriginalFromRebootUsingProviderYearAlias() {
        TitleDetails source = source(false);
        Map<String, Object> reboot = Map.of("title", "Quan Zhi Gao Shou", "aliases", List.of("The King's Avatar"), "releaseLabel", "2020", "type", "Manhua");
        assertTrue(SourceMetadataFacts.matches(source.sourceTitle(), source, reboot));
        assertFalse(SourceMetadataFacts.matches(source.sourceTitle(), source, Map.of("title", "The King's Avatar (Reboot)", "type", "Manhua")));
        assertFalse(SourceMetadataFacts.matches(source.sourceTitle(), source, Map.of("title", "The King's Avatar", "releaseLabel", "2015")));
        assertFalse(SourceMetadataFacts.matches(source.sourceTitle(), source, Map.of("title", "Avatar", "releaseLabel", "2020", "type", "Manga")));
        Map<String, Object> adultMatch = Map.of("title", "The King's Avatar", "aliases", List.of("The King's Avatar (2020)"), "releaseLabel", "2020", "adultContent", true);
        assertFalse(SourceMetadataFacts.matches(source.sourceTitle(), source, adultMatch));
        assertTrue(SourceMetadataFacts.adultConflict(source.sourceTitle(), source, adultMatch));
    }

    /** Fallback requires exact source identity, explicit non-adult evidence and a real source description. */
    @Test void fallbackRejectsUnknownAdultAndForeignSource() {
        assertThrows(IllegalStateException.class, () -> SourceMetadataFacts.fallback("weebcentral", URL, "The King's Avatar (Reboot)", source(null)));
        assertThrows(IllegalStateException.class, () -> SourceMetadataFacts.fallback("weebcentral", "https://evil.example/series/a", "The King's Avatar (Reboot)", source(false)));
        assertThrows(IllegalStateException.class, () -> SourceMetadataFacts.fallback("weebcentral", URL, "Avatar", source(false)));
        Map<String, Object> fallback = SourceMetadataFacts.fallback("weebcentral", URL, "The King's Avatar (Reboot)", source(false));
        assertEquals("source", fallback.get("provider"));
        assertEquals("weebcentral:01J76XYDQHSY9H2V7050NC7843", fallback.get("providerSeriesId"));
        assertEquals(fallback.get("providerSeriesId"), SourceMetadataFacts.fallback("weebcentral", URL + "-long-slug".repeat(40), "The King's Avatar (Reboot)", source(false)).get("providerSeriesId"));
        assertEquals("source-backed", ((Map<?, ?>) fallback.get("sourceBinding")).get("decision"));
    }

    /** Case variants share one display tag while each provider origin remains available. */
    @Test void preservesTagOriginsAndEditionDisplayName() {
        Map<String, Object> result = SourceMetadataFacts.bind("weebcentral", URL, "The King's Avatar (Reboot)", source(false),
            Map.of("provider", "mangadex", "providerSeriesId", "2020-edition", "title", "The King's Avatar", "tags", List.of("action", "Video Games")), "verified-provider");
        assertEquals(List.of("action", "Video Games", "Adventure"), result.get("tags"));
        assertEquals(4, ((List<?>) result.get("tagOrigins")).size());
        assertEquals("The King's Avatar (Reboot)", result.get("displayTitle"));
        Map<String, Object> rebound = SourceMetadataFacts.bind("weebcentral", URL, "The King's Avatar (Reboot)", source(false), result, "verified-provider");
        assertEquals(result.get("tagOrigins"), rebound.get("tagOrigins"));
    }

    /** Year aliases establish only a reboot; other edition markers still require provider evidence. */
    @Test void yearAliasCannotEraseColoredOrNovelEdition() {
        for (String edition : List.of("Colored", "Novel", "Remake", "Reboot Colored")) {
            String title = "Clockmaker Journey (" + edition + ")";
            TitleDetails source = new TitleDetails("A journey.", "Manhua", List.of("Clockmaker Journey (2020)"), "Ongoing", "2020",
                false, false, false, List.of(), List.of(), title, List.of(), "");
            assertFalse(SourceMetadataFacts.matches(title, source, Map.of("title", "Clockmaker Journey", "releaseLabel", "2020", "type", "Manhua")));
        }
    }

    /** Execution accepts the same year-backed edition while rejecting altered source or provider identities. */
    @Test void executionRequiresTheExactFrozenBinding() {
        String title = source(false).sourceTitle();
        Map<String, Object> bound = SourceMetadataFacts.bind("weebcentral", URL, title, source(false), Map.of(
            "provider", "mangadex", "providerSeriesId", "reboot", "title", "The King's Avatar", "releaseLabel", "2020", "type", "Manhua"), "verified-provider");
        assertTrue(SourceMetadataFacts.matchesBoundSelection(URL, title, bound));
        assertFalse(SourceMetadataFacts.matchesBoundSelection(URL + "-other", title, bound));
        Map<String, Object> changed = new java.util.LinkedHashMap<>(bound); changed.put("providerSeriesId", "other");
        assertFalse(SourceMetadataFacts.matchesBoundSelection(URL, title, changed));
        changed = new java.util.LinkedHashMap<>(bound); changed.put("releaseLabel", "2015");
        assertFalse(SourceMetadataFacts.matchesBoundSelection(URL, title, changed));
    }

    /** Durable broker decoding uses Longs; equivalent numeric versions keep the exact edition fence intact. */
    @Test void restoredNumericBindingVersionsPreserveExactValidation() {
        String title = source(false).sourceTitle();
        Map<String, Object> bound = SourceMetadataFacts.bind("weebcentral", URL, title, source(false), Map.of(
            "provider", "mangadex", "providerSeriesId", "reboot", "title", "The King's Avatar", "releaseLabel", "2020", "type", "Manhua"), "verified-provider");
        for (Object version : List.of(1, 1L, 1.0d, new java.math.BigDecimal("1.00"), "1", 2L, 1.1d, Double.NaN)) {
            Map<String, Object> binding = new java.util.LinkedHashMap<>((Map<String, Object>) bound.get("sourceBinding"));
            binding.put("version", version);
            Map<String, Object> restored = new java.util.LinkedHashMap<>(bound);
            restored.put("sourceBinding", binding);
            boolean valid = version instanceof Number number && Double.isFinite(number.doubleValue()) && number.doubleValue() == 1;
            assertEquals(valid, SourceMetadataFacts.matchesBoundSelection(URL, title, restored));
            assertFalse(SourceMetadataFacts.matchesBoundSelection(URL + "-other", title, restored));
            restored.put("releaseLabel", "2015");
            assertFalse(SourceMetadataFacts.matchesBoundSelection(URL, title, restored));
        }
    }

    private TitleDetails source(Boolean adult) {
        return new TitleDetails("Ye Qiu returns to Glory.", "Manhua", List.of("The King's Avatar (2020)"), "Ongoing", "2020",
            adult, true, false, List.of("Action", "Adventure"), List.of(), "The King's Avatar (Reboot)", List.of("Hudie Lan"), "https://example.org/cover.jpg");
    }
}
