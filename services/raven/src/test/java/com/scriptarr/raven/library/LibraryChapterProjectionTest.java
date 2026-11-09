package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** Durable segment evidence survives catalogue, reader and metadata-only chapter DTO projections. */
class LibraryChapterProjectionTest {
    private final ObjectMapper json = new ObjectMapper();

    /** Jackson must retain all four Vault checkpoint fields on every actual reader-facing DTO. */
    @Test void vaultChapterRoundTripsThroughLibraryAndReaderPayloads() throws Exception {
        LibraryChapter chapter = checkpoint();
        LibraryTitle title = json.treeToValue(json.valueToTree(Map.of("id", "title", "title", "Title", "chapters", List.of(chapter))), LibraryTitle.class);
        for (JsonNode row : List.of(json.valueToTree(chapter), json.valueToTree(title).path("chapters").get(0),
            json.valueToTree(new ReaderManifest(title, List.of(chapter))).path("chapters").get(0),
            json.valueToTree(new ReaderChapterPayload(title, chapter, List.of(), null, null)).path("chapter"))) {
            assertCheckpoint(row, true);
        }
        assertEquals(Integer.valueOf(2), title.chapters().getFirst().sourcePageCount());
        assertEquals(Boolean.TRUE, title.chapters().getFirst().segmentsReady());
    }

    /** Legacy constructors omit optional fields, so serializing AVIF cannot manufacture a failed segment checkpoint. */
    @Test void legacyAvifAndMissingWebpEvidenceRemainAbsent() throws Exception {
        LibraryChapter avif = legacyCopy("chapter", "ready", "avif-0123456789abcdef", "/downloads/ingested/chapter/manifest.json");
        LibraryChapter webp = legacyCopy("chapter", "ready", "webp-0123456789abcdef", "/downloads/ingested/chapter/manifest.json");
        for (LibraryChapter chapter : List.of(avif, webp)) {
            JsonNode row = json.valueToTree(chapter);
            for (String field : List.of("sourcePageCount", "expectedSegmentCount", "ingestedSegmentCount", "segmentsReady")) assertFalse(row.has(field));
            assertNull(json.treeToValue(row, LibraryChapter.class).segmentsReady());
        }
    }

    /** A valid metadata copy keeps explicit durable readiness; quality failure keeps counts but writes false. */
    @Test void metadataAndFailedCopiesRetainOnlyMatchingCheckpointEvidence() throws Exception {
        LibraryChapter previous = checkpoint();
        LibraryChapter metadata = legacyCopy(previous.id(), "ready", previous.ingestRevision(), previous.ingestManifestPath()).preserveSegmentCheckpointFrom(previous);
        assertCheckpoint(json.valueToTree(metadata), true);
        LibraryChapter failed = legacyCopy(previous.id(), "failed", previous.ingestRevision(), previous.ingestManifestPath()).preserveSegmentCheckpointFrom(previous);
        assertCheckpoint(json.valueToTree(failed), false);
        assertEquals(Integer.valueOf(3), failed.ingestedSegmentCount());
        assertFalse(json.treeToValue(json.valueToTree(failed), LibraryChapter.class).segmentsReady());
        ObjectNode explicit = json.valueToTree(metadata); explicit.put("segmentsReady", false);
        assertFalse(json.treeToValue(explicit, LibraryChapter.class).preserveSegmentCheckpointFrom(previous).segmentsReady());
    }

    /** Rekey, new revision and new manifest copies cannot inherit the old output's readiness. */
    @Test void changedIdentityDoesNotBorrowSegmentEvidence() throws Exception {
        LibraryChapter previous = checkpoint();
        for (LibraryChapter target : List.of(legacyCopy("different", "ready", previous.ingestRevision(), previous.ingestManifestPath()),
            legacyCopy(previous.id(), "ready", "webp-fedcba9876543210", previous.ingestManifestPath()),
            legacyCopy(previous.id(), "ready", previous.ingestRevision(), "/downloads/ingested/other/manifest.json"))) {
            assertNull(target.preserveSegmentCheckpointFrom(previous).segmentsReady());
        }
        ObjectNode missingFlag = json.valueToTree(previous); missingFlag.remove("segmentsReady");
        LibraryChapter incomplete = json.treeToValue(missingFlag, LibraryChapter.class);
        assertNull(legacyCopy(previous.id(), "ready", previous.ingestRevision(), previous.ingestManifestPath()).preserveSegmentCheckpointFrom(incomplete).segmentsReady());
    }

    /** @return one real-shaped Vault chapter with a durable all-segment checkpoint @throws Exception when JSON decoding fails */
    private LibraryChapter checkpoint() throws Exception {
        ObjectNode row = json.valueToTree(legacyCopy("chapter", "ready", "webp-0123456789abcdef", "/downloads/ingested/chapter/manifest.json"));
        row.put("sourcePageCount", 2); row.put("expectedSegmentCount", 3); row.put("ingestedSegmentCount", 3); row.put("segmentsReady", true);
        return json.treeToValue(row, LibraryChapter.class);
    }

    /** @param id chapter identity @param status processing state @param revision saved output identity @param manifest saved output path @return an old-constructor metadata copy */
    private LibraryChapter legacyCopy(String id, String status, String revision, String manifest) {
        return new LibraryChapter(id, "Chapter 1", "1", 2, "", true, "/downloads/downloaded/title/c001.cbz", "", "clean", 2, 0,
            List.of(), List.of(), status, revision, 2, "2026-11-08T00:00:00Z", "", manifest, "2026-11-08T00:00:00Z");
    }

    /** @param row emitted reader chapter @param ready expected explicit readiness */
    private void assertCheckpoint(JsonNode row, boolean ready) {
        assertEquals(2, row.path("sourcePageCount").asInt(-1)); assertEquals(3, row.path("expectedSegmentCount").asInt(-1));
        assertEquals(3, row.path("ingestedSegmentCount").asInt(-1)); assertEquals(ready, row.path("segmentsReady").asBoolean());
        assertTrue(row.has("segmentsReady"));
    }
}
