package com.scriptarr.raven.library;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** The production lane resolver must honor its legacy deployment setting without changing limits. */
class LibraryIngestTitleLanesTest {
    private static final String LEGACY = "SCRIPTARR_RAVEN_AVIF_TITLE_LANES";
    private static final String FALLBACK = "SCRIPTARR_RAVEN_INGEST_TITLE_LANES";

    /** Existing one-lane deployments must remain one-lane after reader output changes. */
    @Test void documentedLegacyOneLaneSettingIsHonored() {
        assertEquals(1, LibraryIngestRunService.resolveConfiguredTitleLanes(Map.of(LEGACY, "1")));
    }

    /** A nonblank legacy value retains precedence over the existing generic fallback. */
    @Test void legacySettingKeepsPriorityOverFallback() {
        assertEquals(1, LibraryIngestRunService.resolveConfiguredTitleLanes(Map.of(LEGACY, "1", FALLBACK, "3")));
        assertEquals(3, LibraryIngestRunService.resolveConfiguredTitleLanes(Map.of(LEGACY, " 3 ", FALLBACK, "1")));
        assertEquals(2, LibraryIngestRunService.resolveConfiguredTitleLanes(Map.of(LEGACY, "invalid", FALLBACK, "1")),
            "An invalid selected primary keeps the existing default rather than selecting another policy.");
    }

    /** Only absent or blank legacy values select the generic setting; missing or invalid values default to two. */
    @Test void missingBlankAndInvalidFallbackKeepExistingDefaults() {
        assertEquals(1, LibraryIngestRunService.resolveConfiguredTitleLanes(Map.of(FALLBACK, "1")));
        assertEquals(1, LibraryIngestRunService.resolveConfiguredTitleLanes(Map.of(LEGACY, " \t", FALLBACK, "1")));
        assertEquals(2, LibraryIngestRunService.resolveConfiguredTitleLanes(Map.of()));
        assertEquals(2, LibraryIngestRunService.resolveConfiguredTitleLanes(Map.of(LEGACY, "", FALLBACK, " ")));
        assertEquals(2, LibraryIngestRunService.resolveConfiguredTitleLanes(Map.of(FALLBACK, "invalid")));
    }

    /** Both supported keys retain trimming, integer validation and the original one-to-three clamp. */
    @Test void boundsAndParsingRemainUnchangedForBothSettings() {
        Map<String, Integer> cases = Map.of("0", 1, "-8", 1, "1", 1, "2", 2, " 3 ", 3,
            "4", 3, "999", 3, "1.5", 2, "2147483648", 2);
        for (String key : new String[]{LEGACY, FALLBACK}) {
            for (var entry : cases.entrySet()) assertEquals(entry.getValue(),
                LibraryIngestRunService.resolveConfiguredTitleLanes(Map.of(key, entry.getKey())),
                () -> "Unexpected lane policy for " + key + " value " + entry.getKey());
        }
    }
}
