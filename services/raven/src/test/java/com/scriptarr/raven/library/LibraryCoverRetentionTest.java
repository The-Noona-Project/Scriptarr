package com.scriptarr.raven.library;

import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

/** Verify cover repair changes title metadata while retaining ready chapter state. */
class LibraryCoverRetentionTest {
    /** A title copy must preserve its exact ready chapter objects and aggregate metadata. */
    @Test
    void coverCopyPreservesAllOtherTitleFields() {
        LibraryTitle title = title("");
        LibraryTitle changed = title.withCoverUrl("https://images.example/cover.jpg");
        assertEquals(title, changed.withCoverUrl(""));
        assertSame(title.chapters().getFirst(), changed.chapters().getFirst());
        assertEquals(title.ingestedChapterCount(), changed.ingestedChapterCount());
        assertEquals(title.ingestStatus(), changed.ingestStatus());
    }

    /** Source-only art repairs an empty title without any chapter-list or ingest writes. */
    @Test
    void retainCoverWritesOnlyMissingTitleArt() {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient();
        LibraryTitle original = title("");
        broker.setLibraryTitle(original);
        LibraryService service = service(broker);
        LibraryTitle repaired = service.retainCoverUrl(original.id(), "https://images.example/source.jpg");
        assertEquals(original.withCoverUrl("https://images.example/source.jpg"), repaired);
        assertEquals(original.chapters(), repaired.chapters());
        assertEquals(0, broker.replaceChapterListWrites());
        assertEquals(0, broker.singleChapterWrites());
        assertEquals(repaired, service.retainCoverUrl(original.id(), "https://images.example/replacement.jpg"));
        assertEquals(repaired, service.retainCoverUrl(original.id(), " "));
    }

    /** Metadata can fill blank art and must preserve previously selected artwork. */
    @Test
    void metadataFillsMissingCoverWithoutReplacingExistingArtwork() {
        FakeRavenBrokerClient broker = new FakeRavenBrokerClient();
        LibraryTitle original = title("");
        broker.setLibraryTitle(original);
        LibraryService service = service(broker);
        service.applyMetadata(original.id(), "mangadex", "2026-11-08T00:00:00Z", Map.of("coverUrl", "https://images.example/metadata.jpg"));
        LibraryTitle repaired = service.findTitleById(original.id());
        assertEquals("https://images.example/metadata.jpg", repaired.coverUrl());
        assertEquals(original.chapters(), repaired.chapters());
        service.applyMetadata(original.id(), "mangadex", "2026-11-08T00:00:01Z", Map.of("coverUrl", "https://images.example/other.jpg"));
        assertEquals(repaired.coverUrl(), service.findTitleById(original.id()).coverUrl());
        service.applyMetadata(original.id(), "mangadex", "2026-11-08T00:00:02Z", Map.of("coverUrl", ""));
        assertEquals(repaired.coverUrl(), service.findTitleById(original.id()).coverUrl());
        assertEquals(0, broker.replaceChapterListWrites());
    }

    /** Assemble the real library service over durable in-memory title rows. */
    private LibraryService service(FakeRavenBrokerClient broker) {
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        return new LibraryService(broker, new RavenSettingsService(broker, logger, List.of()), logger);
    }

    /** Build a title with ready reader state whose every field must survive a cover-only repair. */
    private LibraryTitle title(String cover) {
        LibraryChapter chapter = new LibraryChapter("chapter", "Chapter 1", "1", 1, "", true,
            "/downloads/downloaded/manhua/Cover/chapter.cbz", "", "clean", 1, 0, List.of(), List.of(),
            "ready", "avif-1234567890abcdef", 1, "2026-11-07T00:00:00Z", "",
            "/downloads/ingested/manhua/title/chapter/manifest.json", "2026-11-07T00:00:00Z");
        return new LibraryTitle("title", "Cover", "manga", "Manhua", "manhua", "active", "1", "#123456",
            "Summary", "2026", 1, 1, "Author", List.of("Fantasy"), List.of("Alias"), "", "", List.of(),
            "", cover, "", "/downloads/downloaded/manhua/Cover", List.of(chapter), "clean", 1, 0, 0, "",
            "ready", 1, "", "2026-11-07T00:00:00Z");
    }
}
