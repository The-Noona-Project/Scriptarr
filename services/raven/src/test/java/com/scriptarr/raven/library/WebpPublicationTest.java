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
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Content revisions survive new transfer epochs without mutable reader artifacts. */
class WebpPublicationTest {
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
