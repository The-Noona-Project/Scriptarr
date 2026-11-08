package com.scriptarr.raven.downloader;

import com.scriptarr.raven.library.LibraryChapter;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Verify append and partial recovery preserve earlier readable catalog chapters. */
class AppendChapterMergerTest {
    /** Verify appending a chapter retains the exact earlier ready chapter and all of its reader state. */
    @Test
    void appendingKeepsUntouchedReadyChapterVerbatim() {
        LibraryChapter ready = readyChapter("chapter-one", "1");
        LibraryChapter added = pendingChapter("", "2", "/downloaded/new-two.cbz");

        List<LibraryChapter> merged = AppendChapterMerger.merge(List.of(ready), List.of(added));

        assertEquals(2, merged.size());
        assertSame(ready, merged.get(0));
        assertSame(added, merged.get(1));
        assertEquals("/downloaded/original-one.cbz", merged.get(0).archivePath());
        assertEquals("/ingested/original/manifest.json", merged.get(0).ingestManifestPath());
        assertEquals("avif-original", merged.get(0).ingestRevision());
        assertEquals("ready", merged.get(0).ingestStatus());
        assertThrows(UnsupportedOperationException.class, () -> merged.add(added));
    }

    /** Verify an intentional repair replaces the requested chapter state while retaining its stable identity. */
    @Test
    void repairOverridesNormalizedChapterWithoutChangingItsIdentity() {
        LibraryChapter original = readyChapter("stable-chapter", "Chapter 01.00");
        LibraryChapter repair = pendingChapter("", "1.0", "/downloaded/repaired-one.cbz");

        List<LibraryChapter> merged = AppendChapterMerger.merge(List.of(original), List.of(repair));

        assertEquals(1, merged.size());
        LibraryChapter result = merged.getFirst();
        assertEquals("stable-chapter", result.id());
        assertEquals("/downloaded/repaired-one.cbz", result.archivePath());
        assertEquals("pending", result.ingestStatus());
        assertEquals("", result.ingestManifestPath());
        assertEquals(repair.sourceUrl(), result.sourceUrl());
        assertEquals("ready", original.ingestStatus());
        assertEquals("/ingested/original/manifest.json", original.ingestManifestPath());
    }

    /** Verify fractional chapters remain distinct and reused ready chapters keep their original objects. */
    @Test
    void fractionalAppendDoesNotCollapseDifferentChapters() {
        LibraryChapter original = readyChapter("fraction-original", "1.01");
        LibraryChapter added = pendingChapter("fraction-new", "1.1", "/downloaded/fraction.cbz");

        List<LibraryChapter> merged = AppendChapterMerger.merge(List.of(original), List.of(original, added));

        assertEquals(2, merged.size());
        assertSame(original, merged.getFirst());
        assertSame(added, merged.get(1));
    }

    /** Verify missing chapter numbers never make unrelated records overwrite one another. */
    @Test
    void unknownChapterNumbersRemainSeparate() {
        LibraryChapter original = pendingChapter("unknown-original", "", "/downloaded/unknown-one.cbz");
        LibraryChapter added = pendingChapter("unknown-new", "", "/downloaded/unknown-two.cbz");

        assertEquals(List.of(original, added), AppendChapterMerger.merge(List.of(original), List.of(added)));
        assertEquals(List.of(original), AppendChapterMerger.merge(List.of(original), null));
    }

    /** Verify stable identity projection retains explicit new segment evidence and matching prior evidence. */
    @Test
    void identityProjectionPreservesOnlyMatchingSegmentCheckpoint() {
        LibraryChapter previous = new LibraryChapter("stable", "Original", "1", 2, null, true,
            "/downloaded/one.cbz", "https://example.invalid/one", "clean", 2, 0, List.of(), List.of(),
            "ready", "webp-0123456789abcdef", 2, "2026-11-08T00:00:00Z", "", "/ingested/one/manifest.json",
            "2026-11-08T00:00:00Z", 2, 3, 3, true);
        LibraryChapter metadataCopy = new LibraryChapter("temporary", "Renamed", "1", 2, null, true,
            previous.archivePath(), previous.sourceUrl(), "clean", 2, 0, List.of(), List.of(), "ready",
            previous.ingestRevision(), 2, previous.ingestedAt(), "", previous.ingestManifestPath(), previous.updatedAt());
        LibraryChapter preserved = AppendChapterMerger.merge(List.of(previous), List.of(metadataCopy)).getFirst();
        assertEquals("stable", preserved.id());
        assertEquals(3, preserved.expectedSegmentCount());
        assertEquals(true, preserved.segmentsReady());
        LibraryChapter sameIdentityCopy = new LibraryChapter(previous.id(), metadataCopy.label(), "1", 2, null, true,
            previous.archivePath(), previous.sourceUrl(), "clean", 2, 0, List.of(), List.of(), "ready",
            previous.ingestRevision(), 2, previous.ingestedAt(), "", previous.ingestManifestPath(), previous.updatedAt());
        LibraryChapter sameIdentity = AppendChapterMerger.merge(List.of(previous), List.of(sameIdentityCopy)).getFirst();
        assertEquals(3, sameIdentity.expectedSegmentCount());
        assertEquals(true, sameIdentity.segmentsReady());
        LibraryChapter replacement = new LibraryChapter("temporary", "Repaired", "1", 2, null, true,
            previous.archivePath(), previous.sourceUrl(), "clean", 2, 0, List.of(), List.of(), "ready",
            "webp-fedcba9876543210", 2, previous.ingestedAt(), "", "/ingested/new/manifest.json", previous.updatedAt(),
            2, 4, 4, true);
        LibraryChapter replaced = AppendChapterMerger.merge(List.of(previous), List.of(replacement)).getFirst();
        assertEquals("stable", replaced.id());
        assertEquals(4, replaced.expectedSegmentCount());
        assertEquals(true, replaced.segmentsReady());
        LibraryChapter pending = pendingChapter("temporary", "1", previous.archivePath());
        assertNull(AppendChapterMerger.merge(List.of(previous), List.of(pending)).getFirst().segmentsReady());
        assertNull(AppendChapterMerger.merge(List.of(previous), List.of(pendingChapter(previous.id(), "1", previous.archivePath()))).getFirst().segmentsReady());
    }

    private LibraryChapter readyChapter(String id, String number) {
        return new LibraryChapter(id, "Earlier chapter", number, 2, "2026-11-01", true,
            "/downloaded/original-one.cbz", "https://weebcentral.com/chapters/original", "clean", 2, 0,
            List.of(), List.of(), "ready", "avif-original", 2, "2026-11-01T00:00:00Z", "",
            "/ingested/original/manifest.json", "2026-11-01T00:00:00Z");
    }

    private LibraryChapter pendingChapter(String id, String number, String archive) {
        return new LibraryChapter(id, "Incoming chapter", number, 3, "2026-11-07", true, archive,
            "https://weebcentral.com/chapters/incoming", "2026-11-07T00:00:00Z");
    }
}
