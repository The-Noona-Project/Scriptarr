package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Cross-language order identity, version compatibility and immutable output regression checks. */
class OrderedPageIdentityTest {
    private final ObjectMapper json = new ObjectMapper();

    /** Independently computed Node compact-JSON goldens bind Java and Vault without changing legacy job IDs. */
    @Test void compactJsonIdentityMatchesVaultGolden() throws Exception {
        List<String> entries = List.of("001_p2.png", "002_p1.png");
        assertEquals("4b0f5a02f1e1896d7aad8df2b60988ef8a9d4878ed642ffffa6ed26abefe68d6", OrderedPageIdentity.digest(entries));
        assertEquals("raven_webp_e34a056fd6c2b79a6dfc21d949c6362f3efb911742eb9ff438272af98ca8db30", RemoteChapterProcessor.jobId("title", "chapter", "a".repeat(64), entries));
        assertEquals("raven_webp_034f6974ed73996b8425563ae9fc1d4936bc750d91a2958bb2dcf8de9911871b", RemoteChapterProcessor.jobId("title", "chapter", "a".repeat(64)));
    }

    /** Names containing possible delimiters remain distinct rather than sharing a concatenated identity. */
    @Test void compactArraysAvoidDelimiterCollisions() throws Exception {
        assertNotEquals(OrderedPageIdentity.digest(List.of("a,b.png", "c.png")), OrderedPageIdentity.digest(List.of("a", "b.png,c.png")));
        assertNotEquals(OrderedPageIdentity.digest(List.of("a", "bc")), OrderedPageIdentity.digest(List.of("ab", "c")));
        assertNotEquals(OrderedPageIdentity.digest(List.of("a\"b", "c\\d")), OrderedPageIdentity.digest(List.of("a", "b\"c\\d")));
    }

    /** The same CBZ and encoding profile allocate separate immutable revisions only when the logical order differs. */
    @Test void orderedRevisionIsStableAndSeparateFromLegacy(@TempDir Path root) throws Exception {
        Path source = DerivedPageManifestTest.source(root);
        String first = OrderedPageIdentity.digest(List.of("001.png", "002.png")), reversed = OrderedPageIdentity.digest(List.of("002.png", "001.png"));
        String revision = DerivedPageManifest.revision(source, 2, "webp", "ffmpeg/libwebp", 85, 2, first);
        assertEquals(revision, DerivedPageManifest.revision(source, 2, "webp", "ffmpeg/libwebp", 85, 2, OrderedPageIdentity.digest(List.of("001.png", "002.png"))));
        assertNotEquals(revision, DerivedPageManifest.revision(source, 2, "webp", "ffmpeg/libwebp", 85, 2, reversed));
        assertNotEquals(revision, DerivedPageManifest.revision(source, 2, "webp", "ffmpeg/libwebp", 85, 2));
        assertTrue(DerivedPageManifest.reusable(DerivedPageManifestTest.chapter(root.resolve("legacy"))));
    }

    /** Partial, unsupported or mismatched version2 data cannot fall back to an old identity. */
    @Test void versionedInputFailsClosed() throws Exception {
        ObjectNode input = input(List.of("001.png", "002.png"));
        assertEquals(OrderedPageIdentity.create(List.of("001.png", "002.png")), OrderedPageIdentity.validateInput(input));
        ObjectNode missingVersion = input.deepCopy(); missingVersion.remove("contentIdentityVersion");
        assertThrows(IOException.class, () -> OrderedPageIdentity.validateInput(missingVersion));
        ObjectNode missingHash = input.deepCopy(); missingHash.remove("orderedEntriesSha256");
        assertThrows(IOException.class, () -> OrderedPageIdentity.validateInput(missingHash));
        ObjectNode unknown = input.deepCopy(); unknown.put("contentIdentityVersion", 3);
        assertThrows(IOException.class, () -> OrderedPageIdentity.validateInput(unknown));
        unknown.put("contentIdentityVersion", 4_294_967_298L);
        assertThrows(IOException.class, () -> OrderedPageIdentity.validateInput(unknown));
        ObjectNode corrupt = input.deepCopy(); corrupt.put("orderedEntriesSha256", "0".repeat(64));
        assertThrows(IOException.class, () -> OrderedPageIdentity.validateInput(corrupt));
    }

    /** Workers must return the exact requested ordering identity; old jobs still accept old artifact metadata. */
    @Test void acceptedArtifactCannotChangeOrOmitOrderingIdentity() throws Exception {
        ObjectNode input = input(List.of("001.png", "002.png")); JsonNode bundle = json.valueToTree(OrderedPageIdentity.fields(input));
        assertDoesNotThrow(() -> OrderedPageIdentity.requireBundle(bundle, input));
        assertThrows(IOException.class, () -> OrderedPageIdentity.requireBundle(json.createObjectNode(), input));
        assertThrows(IOException.class, () -> OrderedPageIdentity.requireBundle(json.valueToTree(OrderedPageIdentity.create(List.of("002.png", "001.png"))), input));
        assertDoesNotThrow(() -> OrderedPageIdentity.requireBundle(json.createObjectNode(), json.valueToTree(Map.of("entries", List.of("001.png")))));
        assertThrows(IOException.class, () -> OrderedPageIdentity.requireBundle(bundle, json.createObjectNode()));
    }

    /** The production worker loop consumes the frozen list, emits its identity, and rejects a forged digest before codecs run. */
    @Test void workerConsumesAndReturnsFrozenLogicalOrder(@TempDir Path root) throws Exception {
        Path archive = root.resolve("source.cbz");
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archive))) {
            for (int value = 1; value <= 2; value++) {
                zip.putNextEntry(new ZipEntry("00" + value + ".png")); byte[] bytes = new byte[20]; java.util.Arrays.fill(bytes, (byte) value); zip.write(bytes); zip.closeEntry();
            }
        }
        ObjectNode input = input(List.of("002.png", "001.png")); input.put("sourcePageCount", 2);
        input.set("sourceFingerprint", json.valueToTree(Map.of("sha256", WebpChapterEncoder.sha256(archive))));
        JsonNode spec = json.valueToTree(Map.of("input", input, "profile", RemoteChapterProcessor.PROFILE));
        try (var source = mockStatic(VipsImageSource.class); var media = mockStatic(MediaProcess.class)) {
            source.when(() -> VipsImageSource.dimensions(any())).thenReturn(new int[]{1, 1});
            source.when(() -> VipsImageSource.region(any(), any(), any())).thenAnswer(call -> { Files.copy((Path) call.getArgument(0), (Path) call.getArgument(1)); return null; });
            source.when(() -> VipsImageSource.thumbnail(any(), any())).thenAnswer(call -> { Files.copy((Path) call.getArgument(0), (Path) call.getArgument(1)); return null; });
            media.when(() -> MediaProcess.run(anyList(), anyBoolean())).thenAnswer(call -> {
                List<String> command = call.getArgument(0);
                if (command.contains("-c:v")) Files.copy(Path.of(command.get(command.indexOf("-i") + 1)), Path.of(command.getLast()));
                return new byte[0];
            });
            Path artifact = new WebpChapterEncoder().encode(archive, spec, root.resolve("output"), completed -> { });
            try (ZipFile zip = new ZipFile(artifact.toFile())) {
                JsonNode bundle; try (var stream = zip.getInputStream(zip.getEntry("bundle.json"))) { bundle = json.readTree(stream); }
                assertEquals(OrderedPageIdentity.fields(input), OrderedPageIdentity.fields(bundle));
                assertEquals(2, bundle.path("pageCount").asInt());
                try (var first = zip.getInputStream(zip.getEntry("p000001-s0000.webp")); var last = zip.getInputStream(zip.getEntry("p000002-s0000.webp"))) {
                    assertEquals(2, first.read()); assertEquals(1, last.read());
                }
            }
            ObjectNode invalid = spec.deepCopy(); ((ObjectNode) invalid.path("input")).put("orderedEntriesSha256", "0".repeat(64));
            source.clearInvocations(); media.clearInvocations();
            assertThrows(IOException.class, () -> new WebpChapterEncoder().encode(archive, invalid, root.resolve("invalid"), completed -> { }));
            source.verifyNoInteractions(); media.verifyNoInteractions();
        }
    }

    /** @param entries frozen logical ZIP entries @return versioned worker input @throws IOException when digest creation fails */
    private ObjectNode input(List<String> entries) throws IOException {
        ObjectNode value = json.valueToTree(Map.of("entries", entries)); value.setAll((ObjectNode) json.valueToTree(OrderedPageIdentity.create(entries))); return value;
    }
}
