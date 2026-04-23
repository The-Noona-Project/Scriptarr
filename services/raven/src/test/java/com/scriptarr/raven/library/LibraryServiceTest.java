package com.scriptarr.raven.library;

import com.scriptarr.raven.downloader.TitleDetails;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

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
import static org.junit.jupiter.api.Assertions.assertNull;
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
            List.of(new LibraryChapter("", "Chapter 1", "1", 1, null, true, archivePath.toString(), "https://weebcentral.com/chapters/solo-1")),
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
            "001_p10.jpg", new byte[]{10},
            "001_p2.jpg", new byte[]{2},
            "001_p1.jpg", new byte[]{1}
        ));
        LibraryTitle title = service.recordDownloadedTitle(
            "Blue Box",
            "Manga",
            "https://weebcentral.com/series/blue-box",
            "",
            null,
            List.of(new LibraryChapter("", "Chapter 1", "1", 3, null, true, archive.toString(), "")),
            titleFolder,
            titleFolder
        );

        assertArrayEquals(new byte[]{2}, service.renderReaderPage(title.id(), title.chapters().getFirst().id(), 1).bytes());
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
                new LibraryChapter("kenja-id-c79", "Chapter 79", "79", 55, Instant.parse("2026-04-18T08:00:00Z").toString(), true, "/downloads/downloaded/manga/Kenja_no_Mago/ch79.cbz", null),
                new LibraryChapter("kenja-id-c94", "Chapter 94", "94", 52, Instant.parse("2026-04-20T08:00:00Z").toString(), true, "/downloads/downloaded/manga/Kenja_no_Mago/ch94.cbz", null)
            )
        ));

        ReaderManifest manifest = service.readerManifest("kenja-id");

        assertNotNull(manifest);
        assertEquals("kenja-id-c94", manifest.chapters().getFirst().id());
        assertEquals("kenja-id-c79", manifest.chapters().get(1).id());
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
            List.of(new LibraryChapter("", "Chapter 1", "1", 10, null, true, archivePath.toString(), "")),
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
            List.of(new LibraryChapter("older-id-c22", "Chapter 22", "22", 37, null, true, "/downloads/downloaded/manga/Absolute_Duo/Absolute Duo c022 [Scriptarr].cbz", null))
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
            List.of(new LibraryChapter("newer-id-c22", "Chapter 22", "22", 37, null, true, "/downloads/downloaded/manga/Absolute_Duo/Absolute Duo c022 [Scriptarr].cbz", "https://weebcentral.com/chapters/absolute-duo-22"))
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
}
