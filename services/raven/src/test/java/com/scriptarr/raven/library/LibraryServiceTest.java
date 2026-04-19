package com.scriptarr.raven.library;

import com.scriptarr.raven.downloader.TitleDetails;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

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
        LibraryService service = new LibraryService(brokerClient, logger);

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
                true,
                true,
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
        LibraryService service = new LibraryService(brokerClient, logger);

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
    }

    private Path writeArchive(Path archivePath) throws IOException {
        Files.createDirectories(archivePath.getParent());
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archivePath))) {
            zip.putNextEntry(new ZipEntry("001.jpg"));
            zip.write(new byte[]{1, 2, 3});
            zip.closeEntry();
        }
        return archivePath;
    }
}
