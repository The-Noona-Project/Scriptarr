package com.scriptarr.raven.library;

import com.scriptarr.raven.settings.RavenNamingSettings;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Unit tests for Raven's safe naming-template import.
 */
class LibraryNamingTest {
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
