package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Actual metadata and scan operations must retain canonical folder ownership and readable checkpoints. */
class LibraryRescanOwnershipTest {
    private static final String FIRST = "11111111-1111-4111-8111-111111111111";
    private static final String SECOND = "22222222-2222-4222-8222-222222222222";
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Normal metadata renaming cannot cause a second UUID for the same canonical source and ready WebP files. */
    @Test void metadataRenameRescanRetainsReadyOwner(@TempDir Path root) throws Exception {
        renamedOwner(root, false);
    }

    /** A real newly discovered chapter must not make a rescan undo the metadata display name or old checkpoint. */
    @Test void renamedOwnerWithNewChapterKeepsMetadata(@TempDir Path root) throws Exception {
        renamedOwner(root, true);
    }

    /** Legacy folders without any durable owner still backfill normally. */
    @Test void unownedLegacyFolderStillBackfills(@TempDir Path root) throws Exception {
        try (Fixture fixture = new Fixture(root, new FakeRavenBrokerClient())) {
            Path folder = root.resolve("manga/Legacy_Source"); archive(folder.resolve("Legacy Source c001.cbz"));
            fixture.service.rescanDownloadedFiles();
            List<LibraryTitle> titles = fixture.service.listTitles(); assertEquals(1, titles.size());
            assertEquals(folder.toString(), titles.getFirst().downloadRoot()); assertEquals("Legacy Source", titles.getFirst().title());
            assertEquals("completed", fixture.scan().path("status").asText());
        }
    }

    /** Source-less legacy metadata retains the existing type/name fallback when no root owner exists. */
    @Test void legacyNameFallbackRemainsAvailable(@TempDir Path root) throws Exception {
        try (Fixture fixture = new Fixture(root, new FakeRavenBrokerClient())) {
            fixture.seed(FIRST, "Legacy Source", "", "", List.of());
            Path folder = root.resolve("downloaded/manga/Legacy_Source"); archive(folder.resolve("Legacy Source c001.cbz"));
            fixture.service.rescanDownloadedFiles();
            assertEquals(1, fixture.service.listTitles().size());
            assertEquals(folder.toString(), fixture.service.findTitle(FIRST).downloadRoot());
            assertEquals(1, fixture.service.findTitle(FIRST).chapters().size());
        }
    }

    /** Conflicting normalized roots retain both owners and files, diagnose the exact ambiguity, and scan unrelated work. */
    @Test void ambiguousOwnersFailClosedAndRemainDurable(@TempDir Path root) throws Exception {
        try (Fixture fixture = new Fixture(root, new FakeRavenBrokerClient())) {
            Path folder = root.resolve("downloaded/manga/Shared_Source"); archive(folder.resolve("Shared Source c001.cbz"));
            fixture.seed(FIRST, "Same Metadata Name", folder.toString(), "", List.of());
            fixture.seed(SECOND, "Same Metadata Name", folder.resolve("unused/..").toString(), "", List.of());
            JsonNode first = fixture.broker.getLibraryTitle(FIRST).deepCopy(), second = fixture.broker.getLibraryTitle(SECOND).deepCopy();
            Map<Path, SavedFile> files = snapshot(folder);
            archive(root.resolve("downloaded/manga/Unrelated_Source/Unrelated Source c001.cbz"));
            fixture.service.rescanDownloadedFiles();
            assertEquals(3, fixture.broker.listLibraryTitles().size(), "Only the unrelated unowned folder may create a raw catalog title.");
            assertEquals(first, fixture.broker.getLibraryTitle(FIRST)); assertEquals(second, fixture.broker.getLibraryTitle(SECOND));
            unchanged(files);
            JsonNode job = fixture.scan(), result = job.path("result"); assertEquals("failed", job.path("status").asText());
            assertEquals(1, result.path("failedFolders").asInt()); assertEquals(1, result.path("ambiguousRootCount").asInt());
            assertEquals(0, result.path("scanErrorCount").asInt()); assertTrue(result.path("recoveryRequired").asBoolean());
            assertEquals(0, result.path("diagnosticsTruncated").asInt()); assertEquals(1, result.path("diagnostics").size());
            JsonNode issue = result.path("diagnostics").get(0);
            assertEquals("ambiguous_download_root", issue.path("code").asText()); assertEquals(folder.toAbsolutePath().normalize().toString(), issue.path("root").asText());
            assertEquals(List.of(FIRST, SECOND), JSON.convertValue(issue.path("ownerIds"), List.class)); assertEquals(2, issue.path("ownerCount").asInt());
            JsonNode task = fixture.broker.listJobTasks("raven-library-rescan", null).get(0);
            assertEquals("failed", task.path("status").asText()); assertEquals(result, task.path("result"));
        }
    }

    /** An owner disappearing between indexing and the title lease must not become an unowned folder or a stale write. */
    @Test void selectedOwnerReloadFailureCannotWrite(@TempDir Path root) throws Exception {
        MissingReloadBroker broker = new MissingReloadBroker();
        try (Fixture fixture = new Fixture(root, broker)) {
            Path folder = root.resolve("downloaded/manga/Original_Source"); archive(folder.resolve("Original Source c001.cbz"));
            fixture.seed(FIRST, "Original Source", folder.toString(), "", List.of());
            JsonNode before = broker.getLibraryTitle(FIRST).deepCopy(); broker.arm();
            fixture.service.rescanDownloadedFiles(); broker.armed = false;
            assertEquals(0, broker.writesAfterArm, "A failed strict owner reload must suppress summary writes.");
            assertEquals(before, broker.getLibraryTitle(FIRST)); assertEquals(1, fixture.service.listTitles().size());
            assertEquals("failed", fixture.scan().path("status").asText());
            assertEquals(1, fixture.scan().path("result").path("scanErrorCount").asInt());
        }
    }

    /** @param root isolated storage @param extra whether to add a real new chapter @throws Exception when fixture operations fail */
    private void renamedOwner(Path root, boolean extra) throws Exception {
        try (Fixture fixture = new Fixture(root, new FakeRavenBrokerClient())) {
            Path folder = root.resolve("downloaded/manga/Original_Source");
            LibraryChapter ready = readyCheckpoint(DerivedPageManifestTest.chapter(folder));
            fixture.seed(FIRST, "Original Source", folder.resolve("unused/..").toString(), root.resolve("downloading/manga/Original_Source").toString(), List.of(ready));
            fixture.service.applyMetadata(FIRST, "qa-metadata", "2026-11-08T22:00:00Z", Map.of("title", "Selected Metadata Display", "summary", "Retained metadata summary."));
            LibraryTitle renamed = fixture.service.findTitle(FIRST); LibraryChapter checkpoint = renamed.chapters().getFirst();
            assertTrue(DerivedPageManifest.reusable(checkpoint));
            if (extra) archive(folder.resolve("Original Source c002.cbz"));
            Map<Path, SavedFile> files = snapshot(folder);
            fixture.service.rescanDownloadedFiles(); LibraryTitle after = fixture.service.findTitle(FIRST);
            assertEquals(1, fixture.service.listTitles().size(), "A display label is not a new canonical folder owner.");
            assertEquals(renamed.id(), after.id()); assertEquals(renamed.title(), after.title());
            assertEquals(renamed.summary(), after.summary()); assertEquals(renamed.metadataProvider(), after.metadataProvider());
            assertEquals(renamed.coverUrl(), after.coverUrl()); assertEquals(Path.of(renamed.downloadRoot()).normalize(), Path.of(after.downloadRoot()).normalize());
            assertEquals(extra ? 2 : 1, after.chapters().size());
            assertEquals(checkpoint, after.chapters().stream().filter(row -> row.id().equals(checkpoint.id())).findFirst().orElseThrow());
            assertTrue(DerivedPageManifest.reusable(after.chapters().stream().filter(row -> row.id().equals(checkpoint.id())).findFirst().orElseThrow()));
            unchanged(files); assertEquals("completed", fixture.scan().path("status").asText());
        }
    }

    /** @param chapter validated saved WebP fixture @return its complete production-shaped checkpoint @throws Exception when projection fails */
    private static LibraryChapter readyCheckpoint(LibraryChapter chapter) throws Exception {
        com.fasterxml.jackson.databind.node.ObjectNode row = JSON.valueToTree(chapter);
        for (var field : DerivedPageManifest.catalogFields(chapter).entrySet()) row.set(field.getKey(), JSON.valueToTree(field.getValue()));
        return JSON.treeToValue(row, LibraryChapter.class);
    }

    /** @param file canonical fixture file @throws Exception when archive creation fails */
    private static void archive(Path file) throws Exception {
        Files.createDirectories(file.getParent());
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(file))) {zip.putNextEntry(new ZipEntry("001.png"));zip.write(new byte[]{1, 2, 3});zip.closeEntry();}
    }

    /** @param root exact fixture folder @return retained file bytes and modification times @throws Exception when enumeration fails */
    private static Map<Path, SavedFile> snapshot(Path root) throws Exception {
        Map<Path, SavedFile> files = new LinkedHashMap<>();
        try (var walk = Files.walk(root)) {for (Path file : walk.filter(Files::isRegularFile).toList()) files.put(file, new SavedFile(Files.readAllBytes(file), Files.getLastModifiedTime(file)));}
        return files;
    }

    /** @param files exact saved source and derived files @throws Exception when reading fails */
    private static void unchanged(Map<Path, SavedFile> files) throws Exception {
        for (var entry : files.entrySet()) {assertArrayEquals(entry.getValue().bytes(), Files.readAllBytes(entry.getKey()));assertEquals(entry.getValue().modified(), Files.getLastModifiedTime(entry.getKey()));}
    }

    /** Exact fixture file preservation evidence. */
    private record SavedFile(byte[] bytes, FileTime modified) { }

    /** Isolated real LibraryService with only its durable broker replaced by the standard in-memory test broker. */
    private static final class Fixture implements AutoCloseable {
        private final FakeRavenBrokerClient broker;
        private final LibraryService service;

        /** @param root isolated downloads root @param broker synthetic durable broker */
        private Fixture(Path root, FakeRavenBrokerClient broker) {
            this.broker = broker; ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
            service = new LibraryService(broker, new RavenSettingsService(broker, logger, List.of()), logger);
        }

        /** @param id stable synthetic identity @param name display label @param downloadRoot canonical owner path @param workingRoot managed path @param chapters saved chapters */
        @SuppressWarnings("unchecked")
        private void seed(String id, String name, String downloadRoot, String workingRoot, List<LibraryChapter> chapters) {
            LibraryTitle title = new LibraryTitle(id, name, "manga", "Manga", "manga", "active", "Chapter 1", "blue", "Summary", "2026", chapters.size(), chapters.size(), "Author", List.of("Action"), List.of(), "", null, List.of(), "", "https://images.example/cover.jpg", workingRoot, downloadRoot, chapters, "2026-11-08T00:00:00Z");
            broker.putLibraryTitle(id, JSON.convertValue(title, Map.class)); broker.putLibraryChapters(id, Map.of("chapters", chapters));
        }

        /** @return actual durable rescan job */
        private JsonNode scan() {return broker.listJobs("scriptarr-raven", "library-rescan", null).get(0);}

        /** Stop only this fixture's unused startup executor. */
        @Override public void close() {service.shutdownCatalogScanExecutor();}
    }

    /** Fail only the strict reload after the initial exact identity read. */
    private static final class MissingReloadBroker extends FakeRavenBrokerClient {
        private boolean armed;
        private int reads;
        private int writesAfterArm;

        /** Begin the deterministic post-index owner disappearance window. */
        private void arm() {armed = true; reads = 0; writesAfterArm = 0;}

        /** @param id requested canonical identity @return original owner or simulated missing response */
        @Override public JsonNode getLibraryTitle(String id) {
            if (armed && ++reads >= 1) return JSON.valueToTree(Map.of("error", "Title not found."));
            return super.getLibraryTitle(id);
        }

        /** @param id requested canonical identity @param payload title checkpoint @return synthetic durable acknowledgement */
        @Override public JsonNode putLibraryTitle(String id, Map<String, Object> payload) {
            if (armed) writesAfterArm++;
            return super.putLibraryTitle(id, payload);
        }
    }
}
