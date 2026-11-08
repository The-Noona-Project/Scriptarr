package com.scriptarr.raven.downloader;

import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

/** Verify strict local type, prefix and provider-origin selection. */
class BulkTitleSelectionTest {
    /** Confirm every requested type stays distinct instead of defaulting to Manga. */
    @Test
    void requestedTypesRemainDistinct() {
        assertEquals("Manhua", BulkTitleSelection.type("manhua"));
        assertEquals("Manhwa", BulkTitleSelection.type("MANHWA"));
        assertNull(BulkTitleSelection.type("comic"));
        assertNull(BulkTitleSelection.type(""));
    }

    /** Confirm visible prefix matching consistently ignores leading decoration. */
    @Test
    void visibleAndNumericPrefixesMatchExactly() {
        assertTrue(BulkTitleSelection.matchesPrefix("★ Alpha", "a"));
        assertTrue(BulkTitleSelection.matchesPrefix("  #123 Stories", "0-9"));
        assertFalse(BulkTitleSelection.matchesPrefix("Beta", "a"));
        assertFalse(BulkTitleSelection.matchesPrefix("Alpha", "0-9"));
    }

    /** Reject foreign origins, user information, unusual ports and non-series paths. */
    @Test
    void onlyExactProductionSeriesOriginsAreAccepted() {
        assertTrue(BulkTitleSelection.validSeriesUrl("https://weebcentral.com/series/ABC123/Alpha-Title"));
        assertTrue(BulkTitleSelection.validSeriesUrl("https://weebcentral.com/series/alpha-start"));
        for (String url : List.of("https://example.com/series/a", "https://weebcentral.com.evil/series/a",
            "https://weebcentral.com@evil.test/series/a", "http://weebcentral.com/series/a",
            "https://weebcentral.com:8443/series/a", "https://weebcentral.com/series/a/extra/path",
            "https://weebcentral.com/chapters/a", "https://weebcentral.com/series/%2e%2e/a",
            "https://weebcentral.com/series/a%2Fb", "https://weebcentral.com/series/a?next=evil")) {
            assertFalse(BulkTitleSelection.validSeriesUrl(url), url);
        }
    }
}
