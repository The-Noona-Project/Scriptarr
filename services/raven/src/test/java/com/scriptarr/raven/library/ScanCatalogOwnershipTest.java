package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.settings.RavenBrokerClient;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Canonical scan ownership survives renamed metadata and preserves all raw same-name identities. */
final class ScanCatalogOwnershipTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Durable normalized roots win over renamed labels without parsing individual chapter DTOs. */
    @Test void normalizedRootWinsOverRenamedTitleAndDifferentFallback(@TempDir Path root) throws Exception {
        Path folder = root.resolve("original-folder");
        RavenBrokerClient broker = census(List.of(title("canonical", "Metadata Renamed", "manga", folder.resolve("child/..").toString()),
            title("fallback", "Original Folder", "manga", "")));
        ScanCatalogOwnership ownership = ScanCatalogOwnership.load(broker);
        assertEquals("canonical", ownership.resolve(folder, "manga", "Original Folder"));
        assertEquals("canonical", ownership.resolve(folder.resolve("nested/.."), "novel", "Another Label"));
        verify(broker, times(1)).listLibraryTitles();
        verify(broker, never()).getLibraryTitle(anyString());
        verify(broker, never()).listLibraryTitleCards(anyMap());
        assertFalse(ownership.hasFailures());
        assertEquals(2, ownership.result().get("titles"));
    }

    /** Raw same-display-name rows cannot hide the second owner as compact display cards would. */
    @Test void sameDisplayNameTwoIdsStillProduceExactRootAmbiguity(@TempDir Path root) throws Exception {
        ScanCatalogOwnership ownership = ScanCatalogOwnership.load(census(List.of(title("z-owner", "Same Display Name", "manga", root.toString()),
            title("a-owner", "Same Display Name", "manga", root.resolve("child/..").toString()))));
        ScanCatalogOwnership.AmbiguousOwnership error = assertThrows(ScanCatalogOwnership.AmbiguousOwnership.class,
            () -> ownership.resolve(root, "manga", "Same Display Name"));
        ownership.recordFailure(root, error);
        assertEquals(root.normalize().toString(), error.root());
        assertEquals(List.of("a-owner", "z-owner"), error.ownerIds());
        assertEquals(2, error.ownerCount());
        Map<String, Object> result = ownership.result();
        assertEquals(1, result.get("failedFolders"));
        assertEquals(1, result.get("ambiguousRootCount"));
        assertEquals(0, result.get("scanErrorCount"));
        assertEquals(true, result.get("recoveryRequired"));
        assertEquals("review-catalog-ownership", result.get("recoveryAction"));
        Map<?, ?> diagnostic = (Map<?, ?>) ((List<?>) result.get("diagnostics")).getFirst();
        assertEquals("ambiguous_download_root", diagnostic.get("code"));
        assertEquals(root.toString(), diagnostic.get("root"));
        assertEquals(List.of("a-owner", "z-owner"), diagnostic.get("ownerIds"));
        assertEquals(0, result.get("diagnosticsTruncated"));
    }

    /** A large folder walk shares one raw census rather than one large request per folder or card. */
    @Test void allFolderIndexesUseOneCompleteRawCensus(@TempDir Path root) throws Exception {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (int i = 0; i < 150; i++) rows.add(title("title-" + i, "Title " + i, "manga", root.resolve("folder-" + i).toString()));
        RavenBrokerClient broker = census(rows);
        ScanCatalogOwnership ownership = ScanCatalogOwnership.load(broker);
        for (int i = 0; i < 150; i++) assertEquals("title-" + i, ownership.resolve(root.resolve("folder-" + i), "manga", "Renamed"));
        verify(broker, times(1)).listLibraryTitles();
        verify(broker, never()).listLibraryTitleCards(anyMap());
        verify(broker, never()).getLibraryTitle(anyString());
        assertEquals(150, ownership.result().get("titles"));
    }

    /** Explicit nullable or blank roots retain first-match legacy name/type behavior. */
    @Test void blankRootsKeepCompatibleLegacyFallback(@TempDir Path root) throws Exception {
        ScanCatalogOwnership ownership = ScanCatalogOwnership.load(census(List.of(title("first", "A Display Title", "manga", null),
            title("second", "A Display Title", "manga", " "), title("other-type", "A Display Title", "novel", ""))));
        assertEquals("first", ownership.resolve(root.resolve("unknown"), "Manga", "A--Display Title"));
        assertEquals("other-type", ownership.resolve(root.resolve("unknown"), "Novel", "A Display Title"));
        assertNull(ownership.resolve(root.resolve("unknown"), "manga", "Genuinely New"));
    }

    /** The exact under-lock reload must still own a root-selected folder, while blank legacy roots remain valid. */
    @Test void freshReloadRejectsMovedMissingOrDifferentRootOwner(@TempDir Path root) throws Exception {
        Path folder = root.resolve("owned");
        ScanCatalogOwnership ownership = ScanCatalogOwnership.load(census(List.of(title("owner", "Name", "manga", folder.toString()), title("legacy", "Legacy", "manga", null))));
        assertEquals("owner", ownership.resolve(folder, "manga", "Old Label"));
        ownership.assertReloadMatches(folder, "owner", folder.resolve("child/..").toString());
        assertThrows(IOException.class, () -> ownership.assertReloadMatches(folder, "owner", ""));
        assertThrows(IOException.class, () -> ownership.assertReloadMatches(folder, "owner", root.resolve("moved").toString()));
        assertThrows(IOException.class, () -> ownership.assertReloadMatches(folder, "different", folder.toString()));
        assertEquals("legacy", ownership.resolve(root.resolve("unknown"), "manga", "Legacy"));
        ownership.assertReloadMatches(root.resolve("unknown"), "legacy", null);
    }

    /** Successful registration remembers the broker's canonical id and refuses another owner. */
    @Test void registerUpdatesTinyIndexesWithoutConcealingConflict(@TempDir Path root) throws Exception {
        ScanCatalogOwnership ownership = ScanCatalogOwnership.load(census(List.of()));
        ownership.register(root, "manga", "Original", "new-owner");
        ownership.register(root.resolve("child/.."), "manga", "Renamed", "new-owner");
        assertEquals("new-owner", ownership.resolve(root, "manga", "Another Rename"));
        assertEquals(1, ownership.result().get("titles"));
        assertThrows(ScanCatalogOwnership.AmbiguousOwnership.class, () -> ownership.register(root, "manga", "Foreign", "other-owner"));
        assertThrows(IOException.class, () -> ownership.resolve(Path.of("relative"), "manga", "Original"));
    }

    /** Missing identity fields and a valid-looking id inside an error payload never become empty ownership. */
    @Test void malformedPartialRowsFailClosed(@TempDir Path root) throws Exception {
        List<Map<String, Object>> invalid = new ArrayList<>();
        for (String missing : List.of("downloadRoot", "chapters", "title", "libraryTypeSlug")) {
            Map<String, Object> row = title("owner", "Name", "manga", root.toString()); row.remove(missing); invalid.add(row);
        }
        Map<String, Object> error = title("owner", "Name", "manga", root.toString()); error.put("error", "unavailable"); invalid.add(error);
        Map<String, Object> noChaptersArray = title("owner", "Name", "manga", root.toString()); noChaptersArray.put("chapters", Map.of()); invalid.add(noChaptersArray);
        invalid.add(title("owner", "", "manga", root.toString()));
        invalid.add(title("owner", "Name", "", root.toString()));
        invalid.add(title("owner", "Name", "manga", "relative/root"));
        invalid.add(title("owner", "Name", "manga", root + "\ninvalid"));
        for (Map<String, Object> row : invalid) assertThrows(IOException.class, () -> ScanCatalogOwnership.load(census(List.of(row))));
    }

    /** Non-array responses and repeated canonical ids make the entire census unusable. */
    @Test void malformedCensusOrDuplicateCanonicalIdFailsClosed(@TempDir Path root) throws Exception {
        RavenBrokerClient missing = mock(RavenBrokerClient.class);
        when(missing.listLibraryTitles()).thenReturn(null, JSON.valueToTree(Map.of("error", "unavailable")));
        assertThrows(IOException.class, () -> ScanCatalogOwnership.load(missing));
        assertThrows(IOException.class, () -> ScanCatalogOwnership.load(missing));
        assertThrows(IOException.class, () -> ScanCatalogOwnership.load(census(List.of(title("same", "First", "manga", root.toString()),
            title("same", "Second", "manga", root.resolve("other").toString())))));
    }

    /** A failed census never returns an authoritative empty index and never writes through the broker. */
    @Test void brokerFailureDoesNotBecomeEmptyOwnership() throws Exception {
        RavenBrokerClient broker = mock(RavenBrokerClient.class);
        when(broker.listLibraryTitles()).thenThrow(new IOException("unavailable"));
        assertThrows(IOException.class, () -> ScanCatalogOwnership.load(broker));
        verify(broker, never()).putLibraryTitle(anyString(), anyMap());
    }

    /** Interruption is preserved so background startup can stop instead of publishing a partial index. */
    @Test void interruptedCensusRestoresThreadInterrupt() throws Exception {
        RavenBrokerClient broker = mock(RavenBrokerClient.class);
        when(broker.listLibraryTitles()).thenThrow(new InterruptedException("stop"));
        try { assertThrows(IOException.class, () -> ScanCatalogOwnership.load(broker)); assertTrue(Thread.currentThread().isInterrupted()); }
        finally { Thread.interrupted(); }
    }

    /** Diagnostic storage is bounded while failure counts stay exact and exception secrets are excluded. */
    @Test void genericDiagnosticsRemainBoundedAndDoNotCopyMessages(@TempDir Path root) throws Exception {
        ScanCatalogOwnership ownership = ScanCatalogOwnership.load(census(List.of()));
        for (int i = 0; i < 101; i++) ownership.recordFailure(root.resolve("folder-" + i), new IOException("provider-secret"));
        assertEquals(101, ownership.result().get("failedFolders"));
        assertEquals(101, ownership.result().get("scanErrorCount"));
        assertEquals(100, ((List<?>) ownership.result().get("diagnostics")).size());
        assertEquals(1, ownership.result().get("diagnosticsTruncated"));
        assertEquals("retry-library-rescan", ownership.result().get("recoveryAction"));
        assertFalse(ownership.result().toString().contains("provider-secret"));
    }

    /** Truncated owner display retains the true cardinality so it cannot masquerade as an expected pair. */
    @Test void ambiguityRetainsActualOwnerCountBeyondDisplayLimit(@TempDir Path root) throws Exception {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (int i = 0; i < 21; i++) rows.add(title("owner-" + i, "Name " + i, "manga", root.toString()));
        ScanCatalogOwnership ownership = ScanCatalogOwnership.load(census(rows));
        ScanCatalogOwnership.AmbiguousOwnership error = assertThrows(ScanCatalogOwnership.AmbiguousOwnership.class, () -> ownership.resolve(root, "manga", "Name 0"));
        assertEquals(21, error.ownerCount());
        assertEquals(20, error.ownerIds().size());
    }

    /** @param rows complete raw canonical rows @return one-census broker @throws Exception for mock setup */
    private static RavenBrokerClient census(List<Map<String, Object>> rows) throws Exception {
        RavenBrokerClient broker = mock(RavenBrokerClient.class);
        when(broker.listLibraryTitles()).thenReturn(JSON.valueToTree(rows));
        return broker;
    }

    /** @param id canonical id @param name display label @param type library type @param root nullable stored root @return raw row with deliberately unparseable chapter elements */
    private static Map<String, Object> title(String id, String name, String type, String root) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", id); row.put("title", name); row.put("libraryTypeSlug", type); row.put("downloadRoot", root);
        row.put("chapters", List.of(Map.of("not-a-valid-chapter-DTO", true)));
        return row;
    }
}
