package com.scriptarr.raven.downloader;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Metadata search shortening must not turn another series or edition into the source title. */
final class BulkMetadataAnchorTest {
    /** Complete names normalize punctuation, case and one leading article without shortening. */
    @Test
    void fullTitleNormalizesPunctuationAndArticle() {
        assertTrue(BulkMetadataAnchor.matches("The Clockmaker's Journey", List.of(), Map.of("title", "CLOCKMAKERS JOURNEY")));
        assertTrue(BulkMetadataAnchor.matches("The Clockmaker’s Journey", List.of(), Map.of("details", Map.of("title", "Clockmakers Journey"))));
        assertFalse(BulkMetadataAnchor.matches("The Clockmaker's Journey", List.of(), Map.of("title", "Journey", "matchedQuery", "Journey")));
    }

    /** Only a provider-declared full translated alias can bridge different language titles. */
    @Test
    void declaredTranslationIsAFullAnchor() {
        assertTrue(BulkMetadataAnchor.matches("Clockmaker Journey", List.of("時計職人の旅"), Map.of("title", "Different Translation", "aliases", List.of("時計職人の旅"))));
        assertTrue(BulkMetadataAnchor.matches("Clockmaker Journey", List.of(), Map.of("details", Map.of("aliases", List.of("The Clockmaker Journey")))));
        assertFalse(BulkMetadataAnchor.matches("Clockmaker Journey", List.of(), Map.of("title", "時計職人の旅", "matchedQuery", "Clockmaker")));
    }

    /** Reboot markers cannot be erased by matching the base title through a provider alias. */
    @Test
    void baseAliasDoesNotDiscardEdition() {
        assertFalse(BulkMetadataAnchor.matches("Clockmaker Journey (Reboot)", List.of("Clockmaker Journey"), Map.of("title", "Clockmaker Journey")));
        assertFalse(BulkMetadataAnchor.matches("Clockmaker Journey (Reboot)", List.of("Clockmaker Journey"), Map.of("title", "Clockmaker Journey", "editionClass", "remake")));
        assertTrue(BulkMetadataAnchor.matches("Clockmaker Journey (Reboot)", List.of("Clockmaker Journey"), Map.of("title", "Clockmaker Journey", "editionClass", "reboot")));
        assertTrue(BulkMetadataAnchor.matches("Clockmaker Journey (Reboot)", List.of(), Map.of("aliases", List.of("The Clockmaker Journey Reboot"))));
    }

    /** Every explicit original edition marker must survive the selected metadata evidence. */
    @Test
    void coloredNovelAndRemakeArePreserved() {
        for (String edition : List.of("Colored", "Novel", "Remake")) {
            String title = "Clockmaker Journey (" + edition + ")";
            assertFalse(BulkMetadataAnchor.matches(title, List.of("Clockmaker Journey"), Map.of("title", "Clockmaker Journey")));
            assertTrue(BulkMetadataAnchor.matches(title, List.of("Clockmaker Journey"), Map.of("details", Map.of("title", "Clockmaker Journey", "editionLabel", edition))));
        }
        assertFalse(BulkMetadataAnchor.matches("Clockmaker Journey Reboot Novel", List.of("Clockmaker Journey"), Map.of("title", "Clockmaker Journey", "editionLabel", "Reboot")));
        assertTrue(BulkMetadataAnchor.matches("Clockmaker Journey Reboot Novel", List.of("Clockmaker Journey"), Map.of("title", "Clockmaker Journey", "editionLabel", "Reboot Novel")));
    }

    /** Empty or malformed snapshots never invent an anchor from query or unrelated values. */
    @Test
    void malformedEvidenceFailsClosed() {
        assertFalse(BulkMetadataAnchor.matches(null, List.of("Alias"), Map.of("title", "Alias")));
        assertFalse(BulkMetadataAnchor.matches("Title", null, null));
        assertFalse(BulkMetadataAnchor.matches("Title", null, Map.of("matchedQuery", "Title")));
        assertFalse(BulkMetadataAnchor.matches("Title", null, Map.of("title", 42, "aliases", List.of(Map.of("title", "Title")))));
        assertFalse(BulkMetadataAnchor.matches("Title", null, Map.of("details", "Title")));
    }
}
