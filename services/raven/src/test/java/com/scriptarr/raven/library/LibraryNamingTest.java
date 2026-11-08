package com.scriptarr.raven.library;

import com.scriptarr.raven.settings.RavenNamingSettings;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Unit tests for Raven's safe naming-template import.
 */
class LibraryNamingTest {
    /** Numeric and hexadecimal series names must not replace the explicit default chapter suffix. */
    @Test
    void defaultChapterNamesRoundTripNumericTitlesAndOptionalVolume() {
        for (String title : java.util.List.of("Scriptarr Bulk QA Synthetic 3483bbd434cb mw76wri9", "Chapter 999 2026", "c 3483 Series", "86", "")) {
            for (String volume : java.util.List.of("", "7")) {
                for (String chapter : java.util.List.of("1", "2", "1.01")) {
                    String archive = LibraryNaming.buildChapterArchiveName(RavenNamingSettings.defaults(), title, "Manga", chapter, volume, 2, "source");
                    assertEquals(chapter, LibraryNaming.extractChapterNumber(archive, RavenNamingSettings.defaults(), "Manga"), archive);
                }
            }
        }
    }

    /** Legacy chapter markers need token boundaries and take precedence over earlier title numbers. */
    @Test
    void legacyChapterMarkersDoNotMatchInsideSeriesWordsOrHexTokens() {
        RavenNamingSettings settings = new RavenNamingSettings("{title} - {chapter_padded}.cbz", "{page_padded}{ext}", 3, 3, 2);
        assertEquals("1", LibraryNaming.extractChapterNumber("Synthetic 3483bbd434cb c001.cbz", settings, "Manga"));
        assertEquals("2", LibraryNaming.extractChapterNumber("Synthetic 3483bbd434cb c002.cbz", settings, "Manga"));
        assertEquals("2", LibraryNaming.extractChapterNumber("Chapter 3483 Side Story_c002.cbz", settings, "Manga"));
        assertEquals("1.01", LibraryNaming.extractChapterNumber("Topic 2026 c001.01.cbz", settings, "Manga"));
    }

    /**
     * Verify the default archive naming omits the volume token when no usable
     * volume mapping is available.
     */
    @Test
    void buildChapterArchiveNameOmitsVolumeWhenUnavailable() {
        String archiveName = LibraryNaming.buildChapterArchiveName(
            RavenNamingSettings.defaults(),
            "Solo Leveling",
            "Manhwa",
            "1",
            "",
            12,
            "weebcentral.com"
        );

        assertEquals("Solo Leveling c001 [Scriptarr].cbz", archiveName);
    }

    /**
     * Verify page naming falls back cleanly when volume placeholders are blank.
     */
    @Test
    void buildPageFileNameLeavesBlankVolumeSegmentsOut() {
        String pageName = LibraryNaming.buildPageFileName(
            new RavenNamingSettings(
                "{title} c{chapter_padded}.cbz",
                "{volume}{page_padded}{ext}",
                3,
                3,
                2
            ),
            "Solo Leveling",
            "Manhwa",
            "1",
            "",
            2,
            ".jpg"
        );

        assertEquals("002.jpg", pageName);
    }

    /**
     * Verify chapter parsing honors the configured template when another number
     * appears earlier in the archive file name.
     */
    @Test
    void extractChapterNumberPrefersConfiguredTemplateToken() {
        RavenNamingSettings settings = new RavenNamingSettings(
            "{title} v{volume_padded} - {chapter_padded}.cbz",
            "{page_padded}{ext}",
            3,
            3,
            2
        );

        assertEquals("1", LibraryNaming.extractChapterNumber("Blacksad v07 - 001.cbz", settings, "Comic"));
    }

    /**
     * Verify page ordering honors the configured template instead of the first
     * number in the file name.
     */
    @Test
    void extractPageOrderPrefersConfiguredTemplateToken() {
        RavenNamingSettings settings = new RavenNamingSettings(
            "{title} c{chapter_padded}.cbz",
            "{chapter_padded}_p{page}{ext}",
            2,
            3,
            2
        );

        assertEquals(2, LibraryNaming.extractPageOrder("001_p2.jpg", settings, "Manga"));
    }

    /**
     * Verify Raven can use a dedicated type profile without affecting the
     * global naming fallback for other library types.
     */
    @Test
    void buildChapterArchiveNameUsesPerTypeProfile() {
        RavenNamingSettings settings = new RavenNamingSettings(
            "{title} c{chapter_padded} [Scriptarr].cbz",
            "{page_padded}{ext}",
            3,
            3,
            2,
            java.util.Map.of(
                "webtoon",
                new com.scriptarr.raven.settings.RavenNamingProfile(
                    "{title} ep{chapter_padded}.cbz",
                    "{page_padded}{ext}",
                    3,
                    3,
                    2
                )
            )
        );

        assertEquals(
            "Tower of God ep012.cbz",
            LibraryNaming.buildChapterArchiveName(settings, "Tower of God", "Webtoon", "12", "", 28, "weebcentral.com")
        );
    }
}
