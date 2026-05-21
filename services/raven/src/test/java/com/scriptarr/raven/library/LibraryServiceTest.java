package com.scriptarr.raven.library;

import com.scriptarr.raven.downloader.TitleDetails;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Unit tests for Raven's durable library projection behavior.
 */
class LibraryServiceTest {
    /**
     * Verify completed downloads persist opaque ids and dynamic type fields.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the test fixture cannot be prepared
     */
    @Test
    void recordDownloadedTitlePersistsOpaqueIdsAndTypeRoots(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        Path workingRoot = tempDir.resolve("downloading").resolve("manhwa").resolve("Solo_Leveling");
        Path downloadRoot = tempDir.resolve("downloaded").resolve("manhwa").resolve("Solo_Leveling");
        Files.createDirectories(downloadRoot);
        Path archivePath = writeArchive(downloadRoot.resolve("Solo_Leveling_c1.cbz"));

        LibraryTitle persisted = service.recordDownloadedTitle(
            "Solo Leveling",
            "Manhwa",
            "https://weebcentral.com/series/solo-leveling",
            "https://images.example/solo.jpg",
            new TitleDetails(
                "Hunter action series.",
                "Manhwa",
                List.of("Only I Level Up"),
                "Ongoing",
                "2018",
                false,
                true,
                true,
                List.of(),
                List.of(Map.of("title", "Solo Leveling: Ragnarok", "relation", "Sequel"))
            ),
            List.of(new LibraryChapter("", "Chapter 1", "1", 1, null, true, archivePath.toString(), "https://weebcentral.com/chapters/solo-1", null)),
            workingRoot,
            downloadRoot
        );

        assertNotNull(persisted);
        UUID.fromString(persisted.id());
        assertEquals("Manhwa", persisted.libraryTypeLabel());
        assertEquals("manhwa", persisted.libraryTypeSlug());
        assertEquals("manhwa", persisted.mediaType());
        assertEquals(workingRoot.toString(), persisted.workingRoot());
        assertEquals(downloadRoot.toString(), persisted.downloadRoot());
        assertEquals(1, persisted.chapters().size());
        assertEquals("https://weebcentral.com/chapters/solo-1", persisted.chapters().getFirst().sourceUrl());
        assertNotNull(persisted.chapters().getFirst().releaseDate());
    }

    /**
     * Verify managed downloaded folders are indexed with their dynamic type.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the test fixture cannot be prepared
     */
    @Test
    void rescanDownloadedFilesIndexesManagedTypedFolders(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        Path titleFolder = tempDir.resolve("downloaded").resolve("webtoon").resolve("Tower_of_God");
        Files.createDirectories(titleFolder);
        writeArchive(titleFolder.resolve("Tower_of_God_c1.cbz"));

        service.rescanDownloadedFiles();
        List<LibraryTitle> titles = service.listTitles();

        assertEquals(1, titles.size());
        LibraryTitle title = titles.getFirst();
        UUID.fromString(title.id());
        assertEquals("Tower of God", title.title());
        assertEquals("Webtoon", title.libraryTypeLabel());
        assertEquals("webtoon", title.libraryTypeSlug());
        assertEquals("webtoon", title.mediaType());
        assertEquals(titleFolder.toString(), title.downloadRoot());
        assertFalse(title.chapters().isEmpty());
        assertTrue(title.chapters().getFirst().archivePath().endsWith(".cbz"));
        assertNotNull(title.chapters().getFirst().releaseDate());
    }

    /**
     * Verify Raven rescans chapter archives with the configured naming template
     * instead of falling back to the first number in the file name.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the test fixture cannot be prepared
     */
    @Test
    void rescanDownloadedFilesHonorsConfiguredChapterTemplate(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        brokerClient.setSetting("raven.naming", Map.of(
            "chapterTemplate", "{title} v{volume_padded} - {chapter_padded}.cbz",
            "pageTemplate", "{chapter_padded}_p{page}{ext}",
            "chapterPad", 3,
            "pagePad", 2,
            "volumePad", 2
        ));
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        Path titleFolder = tempDir.resolve("downloaded").resolve("comic").resolve("Blacksad");
        Files.createDirectories(titleFolder);
        writeArchive(titleFolder.resolve("Blacksad v07 - 001.cbz"));

        service.rescanDownloadedFiles();
        List<LibraryTitle> titles = service.listTitles();

        assertEquals(1, titles.size());
        assertEquals("1", titles.getFirst().chapters().getFirst().chapterNumber());
    }

    /**
     * Verify manual imports copy staged CBZ files into canonical downloaded
     * storage and publish reader-ready WebP ingest output.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the import fixture cannot be prepared
     */
    @Test
    void importLibraryCopiesStagedCbzAndRunsWebpIngest(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        Path sourceRoot = tempDir.resolve("import-staging").resolve("manual-title");
        Files.createDirectories(sourceRoot);
        Path sourceArchive = writeArchive(sourceRoot.resolve("Manual Title c001.cbz"), Map.of(
            "page-002.png", pngPage(20),
            "page-001.png", pngPage(10)
        ));

        Map<String, Object> result = service.importLibrary(Map.of(
            "titleName", "Manual Title",
            "libraryType", "Manga",
            "requestedBy", "owner-1",
            "chapters", List.of(Map.of(
                "sourcePath", sourceArchive.toString(),
                "chapterNumber", "1",
                "label", "Chapter 1"
            ))
        ));

        LibraryTitle title = (LibraryTitle) result.get("title");
        assertNotNull(title);
        assertEquals(1, result.get("importedChapters"));
        assertEquals("ready", result.get("ingestStatus"));
        assertEquals("ready", title.ingestStatus());
        assertEquals(1, title.chapters().size());
        LibraryChapter chapter = title.chapters().getFirst();
        assertEquals("ready", chapter.ingestStatus());
        assertEquals(2, chapter.ingestedPageCount());
        assertTrue(chapter.archivePath().contains(tempDir.resolve("downloaded").resolve("manga").resolve("Manual_Title").toString()));
        assertTrue(Files.exists(Path.of(chapter.archivePath())));
        assertTrue(Files.exists(Path.of(chapter.ingestManifestPath())));
        assertTrue(Files.exists(Path.of(chapter.ingestManifestPath()).getParent().resolve("p000001.webp")));
        assertArrayEquals(pngPage(10), service.renderReaderPage(title.id(), chapter.id(), 0).bytes());
    }

    /**
     * Verify imports can append a CBZ chapter to an existing title without
     * replacing the canonical title id.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the import fixture cannot be prepared
     */
    @Test
    void importLibraryAppendsChapterToExistingTitle(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        Path titleRoot = tempDir.resolve("downloaded").resolve("manga").resolve("Existing_Title");
        Files.createDirectories(titleRoot);
        Path firstArchive = writeArchive(titleRoot.resolve("Existing Title c001.cbz"), Map.of("001.png", pngPage(30)));
        LibraryTitle existing = service.recordDownloadedTitle(
            "Existing Title",
            "Manga",
            "",
            "",
            null,
            List.of(new LibraryChapter("", "Chapter 1", "1", 1, null, true, firstArchive.toString(), "", null)),
            titleRoot,
            titleRoot
        );

        Path sourceRoot = tempDir.resolve("import-staging").resolve("existing-title");
        Files.createDirectories(sourceRoot);
        Path secondArchive = writeArchive(sourceRoot.resolve("Existing Title c002.cbz"), Map.of("001.png", pngPage(40)));

        Map<String, Object> result = service.importLibrary(Map.of(
            "existingTitleId", existing.id(),
            "requestedBy", "owner-1",
            "chapters", List.of(Map.of(
                "sourcePath", secondArchive.toString(),
                "chapterNumber", "2",
                "label", "Chapter 2"
            ))
        ));

        LibraryTitle title = (LibraryTitle) result.get("title");
        assertEquals(existing.id(), title.id());
        assertEquals(2, title.chapters().size());
        assertEquals("ready", title.ingestStatus());
        assertTrue(title.chapters().stream().allMatch((chapter) -> "ready".equals(chapter.ingestStatus())));
        assertTrue(title.chapters().stream().anyMatch((chapter) -> "2".equals(chapter.chapterNumber())));
        LibraryChapter importedChapter = title.chapters().stream()
            .filter((chapter) -> "2".equals(chapter.chapterNumber()))
            .findFirst()
            .orElseThrow();
        assertTrue(Path.of(importedChapter.archivePath()).startsWith(titleRoot));
        assertTrue(Files.exists(Path.of(importedChapter.archivePath())));
    }

    /**
     * Verify Raven sorts archive pages with the configured page template so
     * custom file names still render in the correct order.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the test fixture cannot be prepared
     */
    @Test
    void renderReaderPageSortsTemplateNamedPages(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        brokerClient.setSetting("raven.naming", Map.of(
            "chapterTemplate", "{title} c{chapter_padded}.cbz",
            "pageTemplate", "{chapter_padded}_p{page}{ext}",
            "chapterPad", 3,
            "pagePad", 2,
            "volumePad", 2
        ));
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        Path titleFolder = tempDir.resolve("downloaded").resolve("manga").resolve("Blue_Box");
        Files.createDirectories(titleFolder);
        Path archive = writeArchive(titleFolder.resolve("Blue Box c001.cbz"), Map.of(
            "001_p10.png", pngPage(10),
            "001_p2.png", pngPage(2),
            "001_p1.png", pngPage(1)
        ));
        LibraryTitle title = service.recordDownloadedTitle(
            "Blue Box",
            "Manga",
            "https://weebcentral.com/series/blue-box",
            "",
            null,
            List.of(new LibraryChapter("", "Chapter 1", "1", 3, null, true, archive.toString(), "", null)),
            titleFolder,
            titleFolder
        );
        title = service.ingestTitle(title.id(), "test");

        assertArrayEquals(pngPage(2), service.renderReaderPage(title.id(), title.chapters().getFirst().id(), 1).bytes());
    }

    /**
     * Verify Raven reuses the sorted archive index and media type metadata for
     * repeated reader page renders from the same chapter archive.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the archive fixture cannot be prepared
     */
    @Test
    void readerArchiveIndexCacheReusesPageMetadata(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        brokerClient.setSetting("raven.naming", Map.of(
            "chapterTemplate", "{title} c{chapter_padded}.cbz",
            "pageTemplate", "{chapter_padded}_p{page}{ext}",
            "chapterPad", 3,
            "pagePad", 2,
            "volumePad", 2
        ));
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        Path titleFolder = tempDir.resolve("downloaded").resolve("manga").resolve("Frieren");
        Files.createDirectories(titleFolder);
        Path archive = writeArchive(titleFolder.resolve("Frieren c001.cbz"), Map.of(
            "001_p3.png", pngPage(3),
            "001_p1.png", pngPage(1),
            "001_p2.png", pngPage(2)
        ));
        LibraryTitle title = service.recordDownloadedTitle(
            "Frieren",
            "Manga",
            "https://weebcentral.com/series/frieren",
            "",
            null,
            List.of(new LibraryChapter("", "Chapter 1", "1", 3, null, true, archive.toString(), "", null)),
            titleFolder,
            titleFolder
        );
        title = service.ingestTitle(title.id(), "test");

        RenderedPage secondPage = service.renderReaderPage(title.id(), title.chapters().getFirst().id(), 1);
        RenderedPage thirdPage = service.renderReaderPage(title.id(), title.chapters().getFirst().id(), 2);

        assertEquals(0, service.readerArchiveIndexCacheSize());
        assertArrayEquals(pngPage(2), secondPage.bytes());
        assertEquals("image/webp", secondPage.mediaType());
        assertArrayEquals(pngPage(3), thirdPage.bytes());
        assertEquals("image/webp", thirdPage.mediaType());
        assertEquals(0, service.readerArchiveIndexCacheSize());
    }

    /**
     * Verify corrupt archive bytes become deterministic reader diagnostics and
     * durable missing-content quality markers instead of broken image panels.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the archive fixture cannot be prepared
     */
    @Test
    void readerPageProbeMarksCorruptArchivePageQuality(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        Path titleFolder = tempDir.resolve("downloaded").resolve("manga").resolve("Witch_Watch");
        Files.createDirectories(titleFolder);
        Path archive = writeArchive(titleFolder.resolve("Witch Watch c001.cbz"), Map.of(
            "001.jpg", new byte[]{1, 2, 3}
        ));
        LibraryTitle title = service.recordDownloadedTitle(
            "Witch Watch",
            "Manga",
            "https://weebcentral.com/series/witch-watch",
            "",
            null,
            List.of(new LibraryChapter("", "Chapter 1", "1", 1, null, true, archive.toString(), "", null)),
            titleFolder,
            titleFolder
        );

        ReaderPageProbe probe = service.probeReaderPage(title.id(), title.chapters().getFirst().id(), 0);
        assertEquals(false, probe.ok());
        assertEquals(404, probe.status());
        assertEquals("missing_page", probe.failureCode());
    }

    /**
     * Verify Raven sorts persisted reader manifests newest-first even when the
     * stored chapter payload order is stale or inconsistent.
     */
    @Test
    void readerManifestSortsChaptersNewestFirst() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        brokerClient.setLibraryTitle(new LibraryTitle(
            "kenja-id",
            "Kenja no Mago",
            "manga",
            "Manga",
            "manga",
            "active",
            "94",
            "#de6d3a",
            "",
            "",
            2,
            2,
            "",
            List.of(),
            List.of(),
            "",
            null,
            List.of(),
            "",
            "",
            "/downloads/downloading/manga/Kenja_no_Mago",
            "/downloads/downloaded/manga/Kenja_no_Mago",
            List.of(
                readyChapter("kenja-id-c79", "Chapter 79", "79", 55, Instant.parse("2026-04-18T08:00:00Z").toString(), "/downloads/downloaded/manga/Kenja_no_Mago/ch79.cbz"),
                readyChapter("kenja-id-c94", "Chapter 94", "94", 52, Instant.parse("2026-04-20T08:00:00Z").toString(), "/downloads/downloaded/manga/Kenja_no_Mago/ch94.cbz")
            ),
            null
        ));

        ReaderManifest manifest = service.readerManifest("kenja-id");

        assertNotNull(manifest);
        assertEquals("kenja-id-c94", manifest.chapters().getFirst().id());
        assertEquals("kenja-id-c79", manifest.chapters().get(1).id());
    }

    /**
     * Verify reader button adjacency follows chapter reading order even though
     * the manifest itself remains newest-first for list displays.
     */
    @Test
    void readerChapterUsesReadingOrderAdjacentIds() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        brokerClient.setLibraryTitle(new LibraryTitle(
            "tomb-raider-king",
            "Tomb Raider King",
            "manhwa",
            "Manhwa",
            "manhwa",
            "active",
            "253",
            "#de6d3a",
            "",
            "",
            3,
            3,
            "",
            List.of(),
            List.of(),
            "",
            null,
            List.of(),
            "",
            "",
            "/downloads/downloading/manhwa/Tomb_Raider_King",
            "/downloads/downloaded/manhwa/Tomb_Raider_King",
            List.of(
                readyChapter("tomb-raider-king-c253", "Chapter 253", "253", 24, Instant.parse("2026-04-21T08:00:00Z").toString(), "/downloads/downloaded/manhwa/Tomb_Raider_King/ch253.cbz"),
                readyChapter("tomb-raider-king-c252", "Chapter 252", "252", 71, Instant.parse("2026-04-20T08:00:00Z").toString(), "/downloads/downloaded/manhwa/Tomb_Raider_King/ch252.cbz"),
                readyChapter("tomb-raider-king-c251", "Chapter 251", "251", 48, Instant.parse("2026-04-19T08:00:00Z").toString(), "/downloads/downloaded/manhwa/Tomb_Raider_King/ch251.cbz")
            ),
            null
        ));

        ReaderChapterPayload payload = service.readerChapter("tomb-raider-king", "tomb-raider-king-c252");

        assertNotNull(payload);
        assertEquals("tomb-raider-king-c251", payload.previousChapterId());
        assertEquals("tomb-raider-king-c253", payload.nextChapterId());
    }

    /**
     * Verify Raven's card view uses the compact broker projection instead of
     * loading full title/chapter records.
     */
    @Test
    void titleCardPageUsesCompactBrokerProjection() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        brokerClient.setLibraryTitle(new LibraryTitle(
            "dandadan",
            "Dandadan",
            "manga",
            "Manga",
            "manga",
            "active",
            "166",
            "#de6d3a",
            "Aliens and yokai.",
            "2021",
            2,
            2,
            "Yukinobu Tatsu",
            List.of("action"),
            List.of("Dan Da Dan"),
            "mangadex",
            Instant.parse("2026-04-18T08:00:00Z").toString(),
            List.of(),
            "https://weebcentral.com/series/dandadan",
            "https://images.example/dandadan.jpg",
            "/downloads/downloading/manga/Dandadan",
            "/downloads/downloaded/manga/Dandadan",
            List.of(new LibraryChapter("dandadan-c166", "Chapter 166", "166", 24, Instant.parse("2026-04-20T08:00:00Z").toString(), true, "/downloads/downloaded/manga/Dandadan/ch166.cbz", null, null)),
            null
        ));

        Map<String, Object> page = service.listTitleCardPage(Map.of("pageSize", "1"));

        assertEquals(1, brokerClient.listLibraryTitleCardsCalls());
        assertEquals(0, brokerClient.listLibraryTitlesCalls());
        assertTrue(page.get("titles") instanceof List<?>);
        List<?> titles = (List<?>) page.get("titles");
        assertEquals(1, titles.size());
        assertTrue(titles.getFirst() instanceof Map<?, ?>);
        Map<?, ?> card = (Map<?, ?>) titles.getFirst();
        assertEquals("Dandadan", card.get("title"));
        assertFalse(card.containsKey("chapters"));
        assertFalse(card.containsKey("downloadRoot"));
        assertFalse(card.containsKey("workingRoot"));
        assertTrue(page.get("pageInfo") instanceof Map<?, ?>);
        assertEquals(1, ((Map<?, ?>) page.get("pageInfo")).get("pageSize"));
    }

    /**
     * Verify source download lifecycle labels are normalized into the shared
     * Scriptarr title status vocabulary.
     *
     * @param tempDir temporary test directory
     * @throws Exception when the archive fixture cannot be prepared
     */
    @Test
    void recordDownloadedTitleNormalizesLifecycleStatus(@TempDir Path tempDir) throws Exception {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        when(logger.getDownloadsRoot()).thenReturn(tempDir);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        Path downloadRoot = tempDir.resolve("downloaded").resolve("manga").resolve("Bakuman");
        Files.createDirectories(downloadRoot);
        Path archivePath = writeArchive(downloadRoot.resolve("Bakuman ch001.cbz"));

        LibraryTitle persisted = service.recordDownloadedTitle(
            "Bakuman",
            "Manga",
            "https://weebcentral.com/series/bakuman",
            "",
            new TitleDetails(
                "Creators chase serialization success.",
                "Manga",
                List.of(),
                "Finished",
                "2008",
                false,
                true,
                true,
                List.of(),
                List.of()
            ),
            List.of(new LibraryChapter("", "Chapter 1", "1", 10, null, true, archivePath.toString(), "", null)),
            downloadRoot,
            downloadRoot
        );

        assertEquals("completed", persisted.status());
    }

    /**
     * Verify Raven collapses duplicate title records that point at the same
     * download root and keeps the richer metadata-backed payload.
     */
    @Test
    void listTitlesCollapsesDuplicateDownloadRoots() {
        FakeRavenBrokerClient brokerClient = new FakeRavenBrokerClient();
        ScriptarrLogger logger = mock(ScriptarrLogger.class);
        LibraryService service = new LibraryService(brokerClient, new RavenSettingsService(brokerClient, logger, List.of()), logger);

        brokerClient.setLibraryTitle(new LibraryTitle(
            "older-id",
            "Absolute Duo",
            "manga",
            "Manga",
            "manga",
            "active",
            "22",
            "#de6d3a",
            "",
            "",
            23,
            23,
            "",
            List.of(),
            List.of(),
            "",
            null,
            List.of(),
            "",
            "",
            "/downloads/downloading/manga/Absolute_Duo",
            "/downloads/downloaded/manga/Absolute_Duo",
            List.of(new LibraryChapter("older-id-c22", "Chapter 22", "22", 37, null, true, "/downloads/downloaded/manga/Absolute_Duo/Absolute Duo c022 [Scriptarr].cbz", null, null)),
            null
        ));
        brokerClient.setLibraryTitle(new LibraryTitle(
            "newer-id",
            "Absolute Duo",
            "manga",
            "Manga",
            "manga",
            "complete",
            "22",
            "#4a78d4",
            "Metadata-backed summary.",
            "2013",
            23,
            23,
            "",
            List.of(),
            List.of("Absolute Duo"),
            "mangadex",
            "2026-04-20T00:00:00Z",
            List.of(),
            "https://weebcentral.com/series/absolute-duo",
            "https://images.example/absolute-duo.jpg",
            "/downloads/downloading/manga/Absolute_Duo",
            "/downloads/downloaded/manga/Absolute_Duo",
            List.of(new LibraryChapter("newer-id-c22", "Chapter 22", "22", 37, null, true, "/downloads/downloaded/manga/Absolute_Duo/Absolute Duo c022 [Scriptarr].cbz", "https://weebcentral.com/chapters/absolute-duo-22", null)),
            null
        ));

        List<LibraryTitle> titles = service.listTitles();

        assertEquals(1, titles.size());
        LibraryTitle canonical = titles.getFirst();
        assertEquals("newer-id", canonical.id());
        assertEquals("completed", canonical.status());
        assertEquals("https://images.example/absolute-duo.jpg", canonical.coverUrl());
        assertEquals("Metadata-backed summary.", canonical.summary());
        assertEquals("https://weebcentral.com/series/absolute-duo", canonical.sourceUrl());
        assertEquals("https://weebcentral.com/chapters/absolute-duo-22", canonical.chapters().getFirst().sourceUrl());
        assertEquals("newer-id", service.findTitle("older-id").id());
    }

    private Path writeArchive(Path archivePath) throws IOException {
        return writeArchive(archivePath, Map.of("001.jpg", new byte[]{1, 2, 3}));
    }

    private Path writeArchive(Path archivePath, Map<String, byte[]> entries) throws IOException {
        Files.createDirectories(archivePath.getParent());
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archivePath))) {
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                zip.putNextEntry(new ZipEntry(entry.getKey()));
                zip.write(entry.getValue());
                zip.closeEntry();
            }
        }
        return archivePath;
    }

    private byte[] pngPage(int shade) throws IOException {
        BufferedImage image = new BufferedImage(1, 1, BufferedImage.TYPE_INT_RGB);
        int value = Math.max(0, Math.min(255, shade));
        image.setRGB(0, 0, (value << 16) | (value << 8) | value);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return output.toByteArray();
    }

    private LibraryChapter readyChapter(String id, String label, String chapterNumber, int pageCount, String releaseDate, String archivePath) {
        return new LibraryChapter(
            id,
            label,
            chapterNumber,
            pageCount,
            releaseDate,
            true,
            archivePath,
            "",
            "clean",
            pageCount,
            0,
            List.of(),
            List.of(),
            "ready",
            "test-revision",
            pageCount,
            releaseDate,
            "",
            "/downloads/ingested/" + id + "/manifest.json",
            releaseDate
        );
    }
}
