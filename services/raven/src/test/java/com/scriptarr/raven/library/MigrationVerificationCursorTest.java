package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

/** Migration-only process evidence has strict ownership, current file identity, ordering and bounded lifetime. */
class MigrationVerificationCursorTest {
    /** A checkpoint is a reusable hint only inside the exact process/run/task/title scope. */
    @Test void scopeRestartAndTerminalDiscardRequireNewProof(@TempDir Path root) throws Exception {
        LibraryChapter chapter = DerivedPageManifestTest.chapter(root); var cursor = new MigrationVerificationCursor();
        var pass = cursor.begin(owner("run", "task"), "title", List.of(chapter)); pass.record(0, chapter);
        assertEquals(1, cursor.begin(owner("run", "task"), "title", List.of(chapter)).start());
        assertEquals(0, cursor.begin(owner("other", "task"), "title", List.of(chapter)).start());
        assertEquals(0, cursor.begin(owner("run", "other"), "title", List.of(chapter)).start());
        assertEquals(0, cursor.begin(owner("run", "task"), "other", List.of(chapter)).start());
        assertEquals(0, new MigrationVerificationCursor().begin(owner("run", "task"), "title", List.of(chapter)).start());
        assertEquals(0, cursor.begin(Map.of("kind", "interactive"), "title", List.of(chapter)).start());
        pass.discard(); assertEquals(0, cursor.begin(owner("run", "task"), "title", List.of(chapter)).start());
    }

    /** Missing tiles, thumbnail changes and canonical/manifest updates invalidate cheap evidence immediately. */
    @Test void allSourceAndDerivedFileStatsAreBound(@TempDir Path root) throws Exception {
        for (String name : List.of("source", "manifest", "tile", "thumbnail")) {
            LibraryChapter chapter = DerivedPageManifestTest.chapter(root.resolve(name)); var cursor = new MigrationVerificationCursor();
            cursor.begin(owner("run", "task"), "title", List.of(chapter)).record(0, chapter);
            Path path = switch (name) {
                case "source" -> Path.of(chapter.archivePath()); case "manifest" -> Path.of(chapter.ingestManifestPath());
                case "tile" -> Path.of(chapter.ingestManifestPath()).getParent().resolve("p000001-s0001.webp");
                default -> Path.of(chapter.ingestManifestPath()).getParent().resolve("p000001-thumbnail.webp");
            };
            Files.setLastModifiedTime(path, FileTime.fromMillis(Files.getLastModifiedTime(path).toMillis() + 1000));
            assertEquals(0, cursor.begin(owner("run", "task"), "title", List.of(chapter)).start(), name);
        }
        LibraryChapter chapter = DerivedPageManifestTest.chapter(root.resolve("missing")); var cursor = new MigrationVerificationCursor();
        cursor.begin(owner("run", "task"), "title", List.of(chapter)).record(0, chapter);
        Files.delete(Path.of(chapter.ingestManifestPath()).getParent().resolve("p000001-s0000.webp"));
        assertEquals(0, cursor.begin(owner("run", "task"), "title", List.of(chapter)).start());
    }

    /** Appending retains a verified prefix; reordering or changed output counts never reuse the wrong position. */
    @Test void chapterOrderAndIdentityControlTheCursor(@TempDir Path root) throws Exception {
        LibraryChapter first = DerivedPageManifestTest.chapter(root.resolve("first")), last = DerivedPageManifestTest.chapter(root.resolve("last"));
        var cursor = new MigrationVerificationCursor(); cursor.begin(owner("run", "task"), "title", List.of(first)).record(0, first);
        assertEquals(1, cursor.begin(owner("run", "task"), "title", List.of(first, last)).start());
        assertEquals(0, cursor.begin(owner("run", "task"), "title", List.of(last, first)).start());
        cursor.begin(owner("run", "task"), "title", List.of(first)).record(0, first);
        ObjectMapper json = new ObjectMapper(); ObjectNode changed = json.valueToTree(first); changed.put("pageCount", 9);
        assertEquals(0, cursor.begin(owner("run", "task"), "title", List.of(json.treeToValue(changed, LibraryChapter.class))).start());
    }

    /** Hints cannot accumulate indefinitely across abandoned scheduler identities. */
    @Test void abandonedScopesAreBounded(@TempDir Path root) throws Exception {
        LibraryChapter chapter = DerivedPageManifestTest.chapter(root); var cursor = new MigrationVerificationCursor();
        for (int index = 0; index < 33; index++) cursor.begin(owner("run-" + index, "task"), "title", List.of(chapter)).record(0, chapter);
        assertEquals(0, cursor.begin(owner("run-0", "task"), "title", List.of(chapter)).start());
    }

    /** @param run durable parent @param task durable title task @return exact migration attribution */
    private static Map<String, Object> owner(String run, String task) { return Map.of("kind", "migration", "runId", run, "taskId", task); }
}
