package com.scriptarr.raven.downloader;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.library.LibraryTitle;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Source ownership must be stable independently of titles, aliases and canonical folder collisions. */
final class CanonicalSourceOwnershipTest {
    private static final String FIRST = "https://weebcentral.com/series/01J11111111111111111111111/Original-Title";
    private static final String SECOND = "https://weebcentral.com/series/01J22222222222222222222222/Original-Title";

    /** Same provider id remains owned after display-slug, case, tracking and default-port changes. */
    @Test
    void stableProviderIdIgnoresDisplaySlug() {
        String changed = "HTTPS://WEEBCENTRAL.COM:443/series/01j11111111111111111111111/Translated-Alias?tracking=1#latest";
        assertEquals(CanonicalSourceOwnership.sourceKey(FIRST), CanonicalSourceOwnership.sourceKey(changed));
        assertDoesNotThrow(() -> CanonicalSourceOwnership.assertSameSource(FIRST, changed));
        assertDoesNotThrow(() -> CanonicalSourceOwnership.assertCompatible(catalog(FIRST, true, "archive.cbz", 1), changed));
    }

    /** Distinct stable series identities cannot be reconciled by the same title or metadata alias. */
    @Test
    void differentSeriesAndOriginFailClosed() {
        for (String incoming : List.of(SECOND, FIRST.replace("weebcentral.com", "other.invalid"), FIRST.replace("https:", "http:"))) {
            assertThrows(IllegalStateException.class, () -> CanonicalSourceOwnership.assertSameSource(FIRST, incoming));
            assertThrows(IllegalStateException.class, () -> CanonicalSourceOwnership.assertCompatible(catalog(FIRST, true, "archive.cbz", 1), incoming));
        }
    }

    /** MangaDex display aliases do not change its canonical UUID identity. */
    @Test
    void mangaDexUsesStableUuid() {
        String id = "12345678-abcd-1234-abcd-123456789abc";
        assertDoesNotThrow(() -> CanonicalSourceOwnership.assertSameSource("https://mangadex.org/title/" + id + "/one",
            "https://mangadex.org:443/title/" + id.toUpperCase(java.util.Locale.ROOT) + "/two"));
        assertThrows(IllegalStateException.class, () -> CanonicalSourceOwnership.assertSameSource("https://mangadex.org/title/" + id,
            "https://mangadex.org/title/22345678-abcd-1234-abcd-123456789abc/two"));
    }

    /** Unrecognized providers retain their normalized origin/path instead of guessing from title labels. */
    @Test
    void otherSourcesCompareNormalizedPath() {
        assertEquals("https://source.invalid/series/one", CanonicalSourceOwnership.sourceKey("https://SOURCE.invalid:443/old/../series/one/?tracking=1"));
        assertThrows(IllegalStateException.class, () -> CanonicalSourceOwnership.assertSameSource("https://source.invalid/series/one", "https://source.invalid/series/two"));
    }

    /** Existing readable or archive-backed content cannot acquire source identity by inference. */
    @Test
    void blankSourceWithContentIsAmbiguous() {
        assertThrows(IllegalStateException.class, () -> CanonicalSourceOwnership.assertCompatible(catalog("", true, "", 0), FIRST));
        assertThrows(IllegalStateException.class, () -> CanonicalSourceOwnership.assertCompatible(catalog("", false, "archive.cbz", 0), FIRST));
        assertThrows(IllegalStateException.class, () -> CanonicalSourceOwnership.assertCompatible(catalog("", false, "", 1), FIRST));
        assertThrows(IllegalStateException.class, () -> CanonicalSourceOwnership.assertSameSource(FIRST, ""));
    }

    /** New titles and empty unavailable placeholders can receive a source before any content exists. */
    @Test
    void newAndEmptyPlaceholderAreAllowed() {
        assertDoesNotThrow(() -> CanonicalSourceOwnership.assertCompatible(null, FIRST));
        assertDoesNotThrow(() -> CanonicalSourceOwnership.assertCompatible(catalog("", false, "", 0), FIRST));
        assertEquals("", CanonicalSourceOwnership.sourceKey(null));
    }

    /** Invalid/credentialed URLs fail with bounded diagnostics that never reveal their input. */
    @Test
    void malformedOwnershipNeverLeaksUrl() {
        for (String source : List.of("not-a-url", "file:///private/path", "https://user:secret@weebcentral.com/series/01J11111111111111111111111/title",
            FIRST.replace("/Original-Title", "%2Fhidden/Original-Title"))) {
            IllegalStateException error = assertThrows(IllegalStateException.class, () -> CanonicalSourceOwnership.sourceKey(source));
            assertTrue(error.getMessage().startsWith("source_identity_conflict"));
            assertTrue(error.getMessage().length() < 160);
            assertFalse(error.getMessage().contains(source));
            assertFalse(error.getMessage().contains("secret"));
        }
    }

    /**
     * Build a complete title through the same JSON record contract used by the broker.
     * @param source optional stored source URL
     * @param available whether the chapter is usable
     * @param archive optional archive backing
     * @param downloaded stored downloaded count
     * @return normalized test title
     */
    private static LibraryTitle catalog(String source, boolean available, String archive, int downloaded) {
        return new ObjectMapper().convertValue(Map.of("id", "catalog", "title", "Unrelated Display Name", "sourceUrl", source,
            "chaptersDownloaded", downloaded, "chapters", List.of(Map.of("id", "chapter", "chapterNumber", "1", "available", available, "archivePath", archive))), LibraryTitle.class);
    }
}
