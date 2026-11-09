package com.scriptarr.raven.downloader;

import com.scriptarr.raven.downloader.providers.DownloadProviderRegistry;
import com.scriptarr.raven.metadata.MetadataService;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

/** Source-constrained intake must recover verified editions without fuzzy reverse source selection. */
class SourceMetadataResolutionTest {
    private static final String URL = "https://weebcentral.com/series/01J76XYDQHSY9H2V7050NC7843/The-Kings-Avatar-Reboot";
    private static final String TITLE = "The King's Avatar (Reboot)";

    /** A trusted exact-source binding bypasses repeat search but still checks fresh edition facts. */
    @Test void savedBindingWinsAndCannotCrossEditionYear() {
        MetadataService metadata = mock(MetadataService.class);
        when(metadata.storedSourceSelection("canonical", URL)).thenReturn(candidate("2020", false));
        DownloadIntakeService intake = new DownloadIntakeService(metadata, mock(DownloadProviderRegistry.class));
        var result = intake.resolveSourceMetadata("weebcentral", URL, TITLE, "Manhua", source(), "canonical");
        assertTrue(result.matched());
        assertEquals(URL, result.downloadSnapshot().get("titleUrl"));
        verify(metadata, never()).search(any(), any(), any(), any());
        when(metadata.storedSourceSelection("canonical", URL)).thenReturn(candidate("2015", false));
        assertThrows(IllegalStateException.class, () -> intake.resolveSourceMetadata("weebcentral", URL, TITLE, "Manhua", source(), "canonical"));
    }

    /** A matched adult provider cannot be laundered into a safe source-backed fallback. */
    @Test void adultConflictBlocksFallbackAndCancellationPreventsSearch() {
        MetadataService metadata = mock(MetadataService.class);
        when(metadata.search(anyString(), isNull(), isNull(), any())).thenReturn(List.of(candidate("2020", false)));
        when(metadata.seriesDetails("mangadex", "2020")).thenReturn(candidate("2020", true));
        DownloadIntakeService intake = new DownloadIntakeService(metadata, mock(DownloadProviderRegistry.class));
        assertThrows(IllegalStateException.class, () -> intake.resolveSourceMetadata("weebcentral", URL, TITLE, "Manhua", source(), ""));
        clearInvocations(metadata);
        assertThrows(CancellationException.class, () -> intake.resolveSourceMetadata("weebcentral", URL, TITLE, "Manhua", source(), "", () -> true));
        verifyNoInteractions(metadata);
    }

    /** Complete source evidence remains usable when no provider can establish the edition. */
    @Test void genuineNoMatchUsesExplicitSourceBackedMetadata() {
        MetadataService metadata = mock(MetadataService.class);
        when(metadata.search(anyString(), isNull(), isNull(), any())).thenReturn(List.of());
        var result = new DownloadIntakeService(metadata, mock(DownloadProviderRegistry.class))
            .resolveSourceMetadata("weebcentral", URL, TITLE, "Manhua", source(), "");
        assertEquals("source", result.metadataSnapshot().get("provider"));
        assertEquals(TITLE, result.metadataSnapshot().get("title"));
        assertEquals(false, result.downloadSnapshot().get("nsfw"));
        verify(metadata).search(eq("The King's Avatar"), isNull(), isNull(), any());
    }

    private Map<String, Object> candidate(String year, boolean adult) {
        return Map.of("provider", "mangadex", "providerSeriesId", year, "title", "The King's Avatar",
            "aliases", List.of("The King's Avatar"), "releaseLabel", year, "type", "Manhua", "adultContent", adult);
    }
    private TitleDetails source() {
        return new TitleDetails("A professional player returns to Glory.", "Manhua", List.of("The King's Avatar (2020)"),
            "Ongoing", "2020", false, true, false, List.of("Action"), List.of(), TITLE, List.of("Hudie Lan"), "");
    }
}
