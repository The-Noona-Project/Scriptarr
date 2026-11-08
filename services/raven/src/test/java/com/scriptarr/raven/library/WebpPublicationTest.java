package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.FakeRavenBrokerClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.LinkOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Content revisions survive new transfer epochs without mutable reader artifacts. */
class WebpPublicationTest {
    /** A process death after a prepared copy must leave its private stage recoverable without polluting immutable output. */
    @Test void interruptedPreparedCopyDoesNotPoisonRetry(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            LibraryIngestResult first = f.service.ingestChapter(f.title, f.chapter); Path manifest = Path.of(first.manifestPath()); f.completed(first);
            Path missing = manifest.getParent().resolve("p000001-s0001.webp"); Files.delete(manifest); Files.delete(missing);
            Path abandonedStage = root.resolve(".ingest-staging/abandoned"); Files.createDirectories(abandonedStage);
            Path source = Files.copy(f.files.resolve(missing.getFileName()), abandonedStage.resolve(missing.getFileName()));
            Path pending = ImmutableManifestRecovery.prepareCopy(source, missing);
            assertTrue(Files.isRegularFile(pending), "The exact production pre-move checkpoint is intentionally left behind.");
            Map<Path, FileSnapshot> retained = snapshots(manifest.getParent(), Path.of(f.chapter.archivePath()));
            LibraryIngestResult restored = f.service.ingestChapter(f.title, f.chapter);
            assertEquals(first.ingestedAt(), restored.ingestedAt()); assertEquals(abandonedStage, pending.getParent());
            assertTrue(Files.isRegularFile(pending), "Retry must not broadly delete another stage's leftover files.");
            Map<Path, FileSnapshot> after = snapshots(manifest.getParent(), Path.of(f.chapter.archivePath()));
            retained.forEach((file, value) -> assertEquals(value, after.get(file))); verifyNoInteractions(f.localEncoder);
        }
    }

    /** A lost manifest is restored last from the exact accepted artifact without replacing retained tiles or completion time. */
    @Test void missingManifestRestoresOriginalCompletedRevision(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            LibraryIngestResult first = f.service.ingestChapter(f.title, f.chapter); Path manifest = Path.of(first.manifestPath());
            String manifestHash = WebpChapterEncoder.sha256(manifest); ObjectNode original = f.completed(first);
            String receiptBefore = original.toString(); Map<Path, FileSnapshot> retained = snapshots(manifest.getParent(), Path.of(f.chapter.archivePath()));
            Files.delete(manifest);
            LibraryIngestResult restored = f.service.ingestChapter(f.title, f.chapter);
            assertEquals(first.revision(), restored.revision()); assertEquals(first.ingestedAt(), restored.ingestedAt());
            assertEquals(manifestHash, WebpChapterEncoder.sha256(manifest)); assertEquals(retained, snapshots(manifest.getParent(), Path.of(f.chapter.archivePath())));
            assertEquals(receiptBefore, original.toString()); verifyNoInteractions(f.localEncoder);
            verify(f.remote, never()).complete(any(), any());
        }
    }

    /** Partial immutable output may recover absent accepted files while leaving all surviving files byte- and identity-stable. */
    @Test void missingManifestCopiesOnlyAbsentAcceptedFiles(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            LibraryIngestResult first = f.service.ingestChapter(f.title, f.chapter); Path manifest = Path.of(first.manifestPath()); f.completed(first);
            Path missing = manifest.getParent().resolve("p000001-s0001.webp"); String missingHash = WebpChapterEncoder.sha256(missing);
            Files.delete(manifest); Files.delete(missing); Map<Path, FileSnapshot> retained = snapshots(manifest.getParent(), Path.of(f.chapter.archivePath()));
            LibraryIngestResult restored = f.service.ingestChapter(f.title, f.chapter);
            assertEquals(first.ingestedAt(), restored.ingestedAt()); assertEquals(missingHash, WebpChapterEncoder.sha256(missing));
            Map<Path, FileSnapshot> after = snapshots(manifest.getParent(), Path.of(f.chapter.archivePath()));
            retained.forEach((file, value) -> assertEquals(value, after.get(file))); verifyNoInteractions(f.localEncoder);
        }
    }

    /** Foreign entries, differing retained bytes and changed completion identities must fail before any retained output is replaced. */
    @Test void missingManifestRejectsUnverifiedRetainedContent(@TempDir Path root) throws Exception {
        for (String damage : List.of("foreign", "different", "receipt", "artifact")) {
            try (Fixture f = new Fixture(root.resolve(damage))) {
                LibraryIngestResult first = f.service.ingestChapter(f.title, f.chapter); Path manifest = Path.of(first.manifestPath()); ObjectNode original = f.completed(first);
                Files.delete(manifest);
                if (damage.equals("foreign")) Files.writeString(manifest.getParent().resolve("unrelated.bin"), "foreign content");
                if (damage.equals("different")) Files.write(manifest.getParent().resolve("p000001-s0000.webp"), new byte[]{9, 9});
                if (damage.equals("receipt")) original.put("ingestRevision", "webp-" + "9".repeat(16));
                if (damage.equals("artifact")) Files.write(f.files.resolve("p000001-s0000.webp"), new byte[]{8, 8});
                Map<Path, FileSnapshot> retained = snapshots(manifest.getParent(), Path.of(f.chapter.archivePath()));
                assertThrows(LibraryIngestException.class, () -> f.service.ingestChapter(f.title, f.chapter));
                assertFalse(Files.exists(manifest, LinkOption.NOFOLLOW_LINKS)); assertEquals(retained, snapshots(manifest.getParent(), Path.of(f.chapter.archivePath())));
                verifyNoInteractions(f.localEncoder); verify(f.remote, never()).complete(any(), any());
            }
        }
    }

    /** A retained symlink is never followed or replaced during missing-manifest repair. */
    @Test void missingManifestRejectsRetainedSymlink(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            LibraryIngestResult first = f.service.ingestChapter(f.title, f.chapter); Path manifest = Path.of(first.manifestPath()); f.completed(first);
            Path tile = manifest.getParent().resolve("p000001-s0000.webp"); Files.delete(manifest); Files.delete(tile);
            try { Files.createSymbolicLink(tile, f.files.resolve(tile.getFileName())); }
            catch (UnsupportedOperationException | java.nio.file.FileSystemException unsupported) { org.junit.jupiter.api.Assumptions.assumeTrue(false, "Fixture filesystem cannot create symlinks."); }
            Path link = Files.readSymbolicLink(tile); String accepted = WebpChapterEncoder.sha256(f.files.resolve(tile.getFileName()));
            assertThrows(LibraryIngestException.class, () -> f.service.ingestChapter(f.title, f.chapter));
            assertTrue(Files.isSymbolicLink(tile)); assertEquals(link, Files.readSymbolicLink(tile)); assertFalse(Files.exists(manifest));
            assertEquals(accepted, WebpChapterEncoder.sha256(f.files.resolve(tile.getFileName())));
        }
    }

    /** @param directory retained revision @param archive canonical source @return exact hashes and file identities excluding the deliberately lost manifest @throws Exception when fixture reads fail */
    private static Map<Path, FileSnapshot> snapshots(Path directory, Path archive) throws Exception {
        Map<Path, FileSnapshot> result = new LinkedHashMap<>();
        try (var files = Files.list(directory)) { for (Path file : files.filter(path -> !path.getFileName().toString().equals("manifest.json")).sorted().toList()) result.put(file, snapshot(file)); }
        result.put(archive, snapshot(archive)); return result;
    }

    /** @param file exact regular fixture @return immutable byte and metadata evidence @throws Exception when reading fails */
    private static FileSnapshot snapshot(Path file) throws Exception {
        BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        return new FileSnapshot(WebpChapterEncoder.sha256(file), attributes.size(), attributes.lastModifiedTime().toString(), String.valueOf(attributes.fileKey()));
    }

    /** Retained output evidence includes inode/file key and timestamp, not only byte equality. */
    private record FileSnapshot(String sha256, long size, String modified, String fileKey) { }
    /** Same source/profile/files reuse the immutable manifest despite a new epoch and ZIP timestamp hash. */
    @Test void newEpochPreservesIdenticalPublishedContent(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            LibraryIngestResult first = f.service.ingestChapter(f.title, f.chapter); Path manifest = Path.of(first.manifestPath());
            String before = WebpChapterEncoder.sha256(manifest); long modified = Files.getLastModifiedTime(manifest).toMillis();
            when(f.remote.convert(any(), any(), any(), any(), any(), any())).thenReturn(new RemoteChapterProcessor.Result("raven_webp_" + "a".repeat(64), 2, "b".repeat(64), f.files, f.bundle));
            LibraryIngestResult second = f.service.ingestChapter(f.title, f.chapter);
            assertEquals(first.revision(), second.revision()); assertEquals(first.ingestedAt(), second.ingestedAt()); assertEquals(2, second.conversionEpoch());
            assertEquals(before, WebpChapterEncoder.sha256(manifest)); assertEquals(modified, Files.getLastModifiedTime(manifest).toMillis()); verifyNoInteractions(f.localEncoder);
        }
    }

    /** A genuinely changed logical-page declaration cannot replace an existing content revision. */
    @Test void changedArtifactCannotOverwriteImmutableRevision(@TempDir Path root) throws Exception {
        try (Fixture f = new Fixture(root)) {
            LibraryIngestResult first = f.service.ingestChapter(f.title, f.chapter); String before = WebpChapterEncoder.sha256(Path.of(first.manifestPath()));
            ObjectNode changed = f.bundle.deepCopy(); ((ObjectNode) changed.path("pages").path(0).path("segments").path(0)).put("sha256", "c".repeat(64));
            when(f.remote.convert(any(), any(), any(), any(), any(), any())).thenReturn(new RemoteChapterProcessor.Result("raven_webp_" + "a".repeat(64), 2, "b".repeat(64), f.files, changed));
            assertThrows(LibraryIngestException.class, () -> f.service.ingestChapter(f.title, f.chapter));
            assertEquals(before, WebpChapterEncoder.sha256(Path.of(first.manifestPath()))); verifyNoInteractions(f.localEncoder);
        }
    }

    /** Only the already validated remote output boundary is stubbed; actual coordinator staging and publication run. */
    private static final class Fixture implements AutoCloseable {
        private final RemoteChapterProcessor remote = mock(RemoteChapterProcessor.class);
        private final PageTranscoder localEncoder = mock(PageTranscoder.class);
        private final LibraryTitle title = mock(LibraryTitle.class);
        private final LibraryChapter chapter;
        private final Path files;
        private final ObjectNode bundle;
        private final LibraryIngestService service;
        /** @param first original publication @return exact completed checkpoint retained by the mocked broker @throws Exception when fixture conversion fails */
        private ObjectNode completed(LibraryIngestResult first) throws Exception {
            ObjectNode original = new ObjectMapper().valueToTree(chapter);
            original.put("ingestRevision", first.revision()).put("ingestManifestPath", first.manifestPath()).put("ingestedAt", first.ingestedAt())
                .put("sourcePageCount", 1).put("expectedSegmentCount", 2).put("ingestedSegmentCount", 2).put("segmentsReady", true);
            when(remote.convert(any(), any(), any(), any(), any(), any())).thenReturn(new RemoteChapterProcessor.Result("raven_webp_" + "a".repeat(64), 1, "a".repeat(64), files, bundle, original));
            return original;
        }
        /** @param root isolated canonical and output mount @throws Exception when fixture preparation fails */
        private Fixture(Path root) throws Exception {
            chapter = DerivedPageManifestTest.chapter(root.resolve("fixture")); files = Path.of(chapter.ingestManifestPath()).getParent(); bundle = (ObjectNode) new ObjectMapper().readTree(files.resolve("manifest.json").toFile());
            bundle.set("profile", new ObjectMapper().valueToTree(RemoteChapterProcessor.PROFILE));
            when(title.id()).thenReturn("title"); when(title.libraryTypeSlug()).thenReturn("manga"); when(remote.required()).thenReturn(true);
            when(remote.convert(any(), any(), any(), any(), any(), any())).thenReturn(new RemoteChapterProcessor.Result("raven_webp_" + "a".repeat(64), 1, "a".repeat(64), files, bundle));
            ScriptarrLogger logger = mock(ScriptarrLogger.class); when(logger.getDownloadsRoot()).thenReturn(root);
            service = new LibraryIngestService(new RavenSettingsService(new FakeRavenBrokerClient(), logger, List.of()), logger, localEncoder, remote);
        }
        /** Close only the isolated page executor. */
        @Override public void close() { service.shutdown(); }
    }
}
