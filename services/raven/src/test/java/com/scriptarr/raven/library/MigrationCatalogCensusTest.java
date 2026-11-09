package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.settings.RavenBrokerClient;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Complete raw catalog scope, strict failure and display-name-independent migration identities. */
class MigrationCatalogCensusTest {
    private final ObjectMapper json = new ObjectMapper();

    /** A genuine successful empty raw array is distinguishable from a failed lookup. */
    @Test void genuineEmptyCensusIsAccepted() throws Exception {
        RavenBrokerClient broker = mock(RavenBrokerClient.class); when(broker.listLibraryTitles()).thenReturn(json.createArrayNode());
        assertEquals(List.of(), MigrationCatalogCensus.read(broker)); verify(broker, times(1)).listLibraryTitles(); verifyNoMoreInteractions(broker);
    }

    /** Neither transport failure nor card-style partial pages can become an empty completed library. */
    @Test void unavailableAndPaginatedPayloadsFailClosed() throws Exception {
        RavenBrokerClient broker = mock(RavenBrokerClient.class); when(broker.listLibraryTitles()).thenThrow(new IOException("Isolated broker outage."));
        assertThrows(IllegalStateException.class, () -> MigrationCatalogCensus.read(broker));
        for (JsonNode invalid : List.of(json.nullNode(), json.valueToTree(Map.of("titles", List.of(title("a")), "pageInfo", Map.of("hasMore", true))), json.valueToTree(Map.of("error", "unavailable")))) {
            doReturn(invalid).when(broker).listLibraryTitles(); assertThrows(IllegalStateException.class, () -> MigrationCatalogCensus.read(broker));
        }
        when(broker.listLibraryTitles()).thenReturn(null); assertThrows(IllegalStateException.class, () -> MigrationCatalogCensus.read(broker)); verify(broker, never()).listLibraryTitleCards(anyMap());
    }

    /** Raw ownership preserves both canonical IDs even when a compact card would collapse their display names. */
    @Test void sameDisplayNameDoesNotCollapseCanonicalOwners() throws Exception {
        RavenBrokerClient broker = mock(RavenBrokerClient.class); when(broker.listLibraryTitles()).thenReturn(json.valueToTree(List.of(title("a"), title("b"))));
        var rows = MigrationCatalogCensus.read(broker); assertEquals(List.of("a", "b"), rows.stream().map(MigrationCatalogCensus.Title::id).toList());
        assertTrue(rows.stream().allMatch(MigrationCatalogCensus.Title::eligible)); verify(broker, never()).listLibraryTitleCards(anyMap());
    }

    /** A single raw census has no inherited one-hundred-card-page limit. */
    @Test void moreThanTenThousandTitlesUseOneUncappedRead() throws Exception {
        List<Map<String, Object>> rows = new ArrayList<>(); for (int index = 0; index < 10_001; index++) rows.add(title("title-" + index));
        RavenBrokerClient broker = mock(RavenBrokerClient.class); when(broker.listLibraryTitles()).thenReturn(json.valueToTree(rows));
        assertEquals(10_001, MigrationCatalogCensus.read(broker).size()); verify(broker, times(1)).listLibraryTitles(); verifyNoMoreInteractions(broker);
    }

    /** Duplicate IDs and incomplete title or chapter data fail the entire snapshot rather than silently omitting work. */
    @Test void duplicateAndIncompleteOwnershipFailsClosed() throws Exception {
        RavenBrokerClient broker = mock(RavenBrokerClient.class);
        for (Object rows : List.of(List.of(title("a"), title("a")), List.of(Map.of("id", "a", "title", "Same", "libraryTypeSlug", "manga")),
            List.of(Map.of("id", "a", "title", "Same", "libraryTypeSlug", "manga", "chapters", List.of(Map.of("id", "c", "archivePath", "source.cbz")))),
            List.of(Map.of("id", "a", "title", "Same", "libraryTypeSlug", "manga", "chapters", List.of(Map.of("id", "c", "available", true)))))) {
            when(broker.listLibraryTitles()).thenReturn(json.valueToTree(rows)); assertThrows(IllegalStateException.class, () -> MigrationCatalogCensus.read(broker));
        }
    }

    /** Empty placeholders remain identities but cannot invent an archive-backed migration target. */
    @Test void unavailableContentDoesNotBecomeEligible() throws Exception {
        RavenBrokerClient broker = mock(RavenBrokerClient.class); when(broker.listLibraryTitles()).thenReturn(json.valueToTree(List.of(
            Map.of("id", "empty", "title", "Empty", "libraryTypeSlug", "manga", "chapters", List.of()),
            Map.of("id", "missing", "title", "Missing", "libraryTypeSlug", "manga", "chapters", List.of(Map.of("id", "c", "available", false, "archivePath", ""))))));
        assertTrue(MigrationCatalogCensus.read(broker).stream().noneMatch(MigrationCatalogCensus.Title::eligible));
    }

    /** @param id canonical fixture identity @return full raw ownership and eligibility fields */
    private static Map<String, Object> title(String id) {
        return Map.of("id", id, "title", "Same display title", "libraryTypeSlug", "manga", "chapters", List.of(Map.of("id", id + "-chapter", "available", true, "archivePath", "/downloads/downloaded/manga/" + id + "/c1.cbz")));
    }
}
