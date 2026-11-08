package com.scriptarr.raven.library;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** Verify immutable cleanup review survives partial deletion while rejecting changed or unreviewed filesystem state. */
class CleanupInventoryJournalTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SCOPE = "a".repeat(64);
    private static final String FILESYSTEM = "b".repeat(64);
    @TempDir Path downloads;

    /** Verify a new instance replays the original inventory rather than replacing it with a partial observation. */
    @Test
    void restartRetainsOriginalReviewAfterPartialDeletion() throws Exception {
        Fixture fixture = fixture("partial");
        Map<String, Object> saved = fixture.journal().saveOrLoad(fixture.preview());
        byte[] original = Files.readAllBytes(proof("partial"));
        Files.delete(fixture.archive());
        Files.setLastModifiedTime(fixture.root(), FileTime.fromMillis(System.currentTimeMillis() + 10_000));
        CleanupInventoryJournal restarted = new CleanupInventoryJournal(downloads, "partial");
        Map<String, Object> replay = new LinkedHashMap<>(fixture.preview());
        replay.put("inventory", List.of());
        replay.put("activity", Map.of("running", 0));
        assertEquals(saved, restarted.saveOrLoad(replay));
        assertArrayEquals(original, Files.readAllBytes(proof("partial")));
        assertEquals(Map.of("remainingEntries", 1, "missingEntries", 1, "verified", true), restarted.verifyRemaining());
        Files.delete(fixture.root());
        assertEquals(0, restarted.verifyRemaining().get("remainingEntries"));
    }

    /** Verify preview recovery needs no newly calculated filesystem digest and never returns a mutable stored reference. */
    @Test
    void recoversOriginalPreviewWithoutAcceptingNewFilesystemObservation() throws Exception {
        Fixture fixture = fixture("preview-replay");
        assertNull(fixture.journal().reviewedPreview());
        Map<String, Object> original = fixture.journal().saveOrLoad(fixture.preview());
        Files.delete(fixture.archive());
        CleanupInventoryJournal restarted = new CleanupInventoryJournal(downloads, "preview-replay");
        assertEquals(original, restarted.reviewedPreview());
        Map<String, Object> returned = restarted.reviewedPreview();
        returned.put("filesystemScopeDigest", "e".repeat(64));
        assertEquals(FILESYSTEM, restarted.reviewedPreview().get("filesystemScopeDigest"));
        Map<String, Object> changedObservation = new LinkedHashMap<>(fixture.preview());
        changedObservation.put("filesystemScopeDigest", "e".repeat(64));
        assertThrows(IOException.class, () -> restarted.saveOrLoad(changedObservation));
    }

    /** Verify new files inside an otherwise reviewed title root cannot become authorized by a replay. */
    @Test
    void rejectsNewPathsRatherThanExpandingReviewedScope() throws Exception {
        Fixture fixture = fixture("new-path");
        fixture.journal().saveOrLoad(fixture.preview());
        Files.writeString(fixture.root().resolve("unreviewed.cbz"), "new content");
        IOException failure = assertThrows(IOException.class, fixture.journal()::verifyRemaining);
        assertTrue(failure.getMessage().startsWith("cleanup_inventory_conflict"));
        assertFalse(failure.getMessage().contains(downloads.toString()));
    }

    /** Verify changed regular-file size or mtime fails even when the same reviewed path survives. */
    @Test
    void rejectsChangedFileAttributes() throws Exception {
        Fixture size = fixture("changed-size");
        size.journal().saveOrLoad(size.preview());
        Files.writeString(size.archive(), "changed and longer");
        assertThrows(IOException.class, size.journal()::verifyRemaining);
        Fixture time = fixture("changed-time");
        time.journal().saveOrLoad(time.preview());
        Files.setLastModifiedTime(time.archive(), FileTime.fromMillis(123_000));
        assertThrows(IOException.class, time.journal()::verifyRemaining);
    }

    /** Verify replacing an approved directory or file cannot inherit its previous filesystem identity. */
    @Test
    void rejectsReplacedFilesystemIdentity() throws Exception {
        Fixture fixture = fixture("replacement");
        fixture.journal().saveOrLoad(fixture.preview());
        Path retained = fixture.root().resolveSibling("retained-original");
        Files.move(fixture.root(), retained);
        Files.createDirectory(fixture.root());
        Files.writeString(fixture.archive(), "chapter");
        assertThrows(IOException.class, fixture.journal()::verifyRemaining);
        Fixture file = fixture("file-replacement");
        file.journal().saveOrLoad(file.preview());
        FileTime modified = Files.getLastModifiedTime(file.archive());
        Files.move(file.archive(), file.root().resolveSibling("saved-original-file.cbz"));
        Files.writeString(file.archive(), "chapter");
        Files.setLastModifiedTime(file.archive(), modified);
        assertThrows(IOException.class, file.journal()::verifyRemaining);
    }

    /** Verify only title-owned subtrees are accepted, never a library-wide, overlapping or external scope. */
    @Test
    void rejectsBroadExternalAndOverlappingScope() throws Exception {
        Fixture fixture = fixture("scope");
        Map<String, Object> broad = new LinkedHashMap<>(fixture.preview());
        broad.put("paths", List.of(downloads.resolve("downloaded/manhua").toString()));
        assertThrows(IOException.class, () -> fixture.journal().saveOrLoad(broad));
        Map<String, Object> outside = new LinkedHashMap<>(fixture.preview());
        outside.put("paths", List.of(downloads.resolveSibling("unrelated").toString()));
        assertThrows(IOException.class, () -> fixture.journal().saveOrLoad(outside));
        Map<String, Object> overlap = new LinkedHashMap<>(fixture.preview());
        overlap.put("paths", List.of(fixture.root().toString(), fixture.archive().toString()));
        assertThrows(IOException.class, () -> fixture.journal().saveOrLoad(overlap));
    }

    /** Verify replay must retain both digests and the exact original approved paths and maintenance identities. */
    @Test
    void rejectsChangedReviewIdentity() throws Exception {
        Fixture fixture = fixture("identity");
        fixture.journal().saveOrLoad(fixture.preview());
        for (Map.Entry<String, Object> change : Map.<String, Object>of(
            "scopeDigest", "c".repeat(64), "filesystemScopeDigest", "d".repeat(64),
            "paths", List.of(fixture.root().resolveSibling("other").toString()),
            "maintenanceKeys", List.of("title:other"), "titleIds", List.of("other"), "planCount", 2).entrySet()) {
            Map<String, Object> replay = new LinkedHashMap<>(fixture.preview());
            replay.put(change.getKey(), change.getValue());
            assertThrows(IOException.class, () -> fixture.journal().saveOrLoad(replay));
        }
        assertEquals(fixture.preview().get("paths"), fixture.journal().saveOrLoad(identity("identity")).get("paths"));
    }

    /** Verify completion is durable and repeatable without deleting later content that reuses the same managed path. */
    @Test
    void completionReceiptDoesNotReplaceProofOrTouchFutureContent() throws Exception {
        Fixture fixture = fixture("complete");
        fixture.journal().saveOrLoad(fixture.preview());
        byte[] original = Files.readAllBytes(proof("complete"));
        Map<String, Object> result = Map.of("operationId", "complete", "removedPathCount", 2L, "completed", true);
        assertNull(fixture.journal().completedResult());
        assertThrows(IOException.class, () -> fixture.journal().markComplete(result));
        Files.delete(fixture.archive());
        Files.delete(fixture.root());
        fixture.journal().markComplete(result);
        CleanupInventoryJournal restarted = new CleanupInventoryJournal(downloads, "complete");
        assertEquals(2, restarted.completedResult().get("removedPathCount"));
        Files.createDirectory(fixture.root());
        Files.writeString(fixture.archive(), "fresh later run");
        restarted.markComplete(Map.of("completed", true, "removedPathCount", 2, "operationId", "complete"));
        assertEquals("fresh later run", Files.readString(fixture.archive()));
        assertArrayEquals(original, Files.readAllBytes(proof("complete")));
        assertThrows(IOException.class, () -> restarted.markComplete(Map.of("completed", false)));
    }

    /** Verify corrupted original bytes, trailing documents and tampered receipt payloads cannot be replayed. */
    @Test
    void rejectsMalformedOrTamperedStoredDocuments() throws Exception {
        Fixture trailing = fixture("trailing");
        trailing.journal().saveOrLoad(trailing.preview());
        Files.writeString(proof("trailing"), " {}", StandardOpenOption.APPEND);
        assertThrows(IOException.class, trailing.journal()::verifyRemaining);
        Fixture tampered = fixture("tampered");
        tampered.journal().saveOrLoad(tampered.preview());
        Map<String, Object> envelope = JSON.readValue(Files.readAllBytes(proof("tampered")), new TypeReference<>() { });
        @SuppressWarnings("unchecked") Map<String, Object> reviewed = (Map<String, Object>) envelope.get("reviewed");
        reviewed.put("planCount", 9);
        Files.write(proof("tampered"), JSON.writeValueAsBytes(envelope));
        assertThrows(IOException.class, tampered.journal()::verifyRemaining);
        Fixture receipt = fixture("receipt");
        receipt.journal().saveOrLoad(receipt.preview());
        Files.delete(receipt.archive()); Files.delete(receipt.root());
        receipt.journal().markComplete(Map.of("completed", true));
        Path result = downloads.resolve(".content-maintenance/receipt.result");
        String encoded = Files.readString(result).replace("\"completed\":true", "\"completed\":false");
        Files.writeString(result, encoded);
        assertThrows(IOException.class, receipt.journal()::completedResult);
    }

    /** Verify symlinks in content, journal leaves or the managed root never authorize traversal or deletion. */
    @Test
    void rejectsSymbolicLinksAtContentAndJournalBoundaries() throws Exception {
        Fixture fixture = fixture("links");
        fixture.journal().saveOrLoad(fixture.preview());
        Path target = downloads.resolve("unrelated-file");
        Files.writeString(target, "unrelated");
        Path link = fixture.root().resolve("linked.cbz");
        try { Files.createSymbolicLink(link, target); }
        catch (UnsupportedOperationException | IOException unavailable) { assumeTrue(false, "Symbolic links are unavailable on this test host."); }
        assertThrows(IOException.class, fixture.journal()::verifyRemaining);
        Files.delete(link);
        Files.delete(proof("links"));
        Files.createSymbolicLink(proof("links"), target);
        assertThrows(IOException.class, () -> new CleanupInventoryJournal(downloads, "links"));
        Path rootLink = downloads.resolveSibling(downloads.getFileName() + "-link");
        try {
            Files.createSymbolicLink(rootLink, downloads);
            assertThrows(IOException.class, () -> new CleanupInventoryJournal(rootLink, "root-link"));
        } finally { Files.deleteIfExists(rootLink); }
        assertEquals("unrelated", Files.readString(target));
    }

    /** Verify a large reviewed inventory document is not accidentally limited to a small control-message payload. */
    @Test
    void supportsOrdinaryReviewsLargerThanOneMegabyte() throws Exception {
        Fixture fixture = fixture("large");
        Map<String, Object> preview = new LinkedHashMap<>(fixture.preview());
        preview.put("entries", List.of(Map.of("notes", "x".repeat(1_100_000))));
        fixture.journal().saveOrLoad(preview);
        assertTrue(Files.size(proof("large")) > 1_048_576);
        assertEquals(preview.get("entries"), new CleanupInventoryJournal(downloads, "large").saveOrLoad(identity("large")).get("entries"));
    }

    /** Verify concurrent cooperating instances create one immutable original proof and return the same snapshot. */
    @Test
    void concurrentInstancesShareOneReview() throws Exception {
        Fixture fixture = fixture("concurrent");
        try (var executor = Executors.newFixedThreadPool(2)) {
            var one = executor.submit(() -> fixture.journal().saveOrLoad(fixture.preview()));
            var two = executor.submit(() -> new CleanupInventoryJournal(downloads, "concurrent").saveOrLoad(fixture.preview()));
            assertEquals(one.get(5, TimeUnit.SECONDS), two.get(5, TimeUnit.SECONDS));
        }
        assertTrue((Boolean) fixture.journal().verifyRemaining().get("verified"));
    }

    /**
     * Build a real title-owned tree and its full initial attribute inventory.
     * @param operation unique operation and title suffix
     * @return initial proof fixture
     * @throws Exception when fixture creation fails
     */
    private Fixture fixture(String operation) throws Exception {
        Path root = downloads.resolve("downloaded/manhua/" + operation);
        Files.createDirectories(root);
        Path archive = root.resolve("c001.cbz");
        Files.writeString(archive, "chapter");
        Map<String, Object> preview = identity(operation);
        preview.put("paths", List.of(root.toString()));
        preview.put("maintenanceKeys", List.of("title:" + operation));
        preview.put("titleIds", List.of(operation));
        preview.put("planCount", 1);
        preview.put("entries", List.of());
        preview.put("activity", Map.of("running", 0));
        List<Map<String, Object>> inventory = new ArrayList<>();
        try (var walk = Files.walk(root)) {
            for (Path path : walk.sorted().toList()) {
                BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                inventory.add(Map.of("path", path.toString(), "directory", attributes.isDirectory(), "size", attributes.size(),
                    "modified", attributes.lastModifiedTime().toMillis(), "fileKey", String.valueOf(attributes.fileKey())));
            }
        }
        preview.put("inventory", inventory);
        return new Fixture(root, archive, preview, new CleanupInventoryJournal(downloads, operation));
    }

    /** @param operation reviewed operation @return required immutable replay identity */
    private Map<String, Object> identity(String operation) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("operationId", operation); result.put("scopeDigest", SCOPE); result.put("filesystemScopeDigest", FILESYSTEM);
        return result;
    }

    /** @param operation reviewed operation @return original proof document */
    private Path proof(String operation) { return downloads.resolve(".content-maintenance/" + operation + ".proof"); }

    /** Real managed files, initial preview and the journal bound to one cleanup operation. */
    private record Fixture(Path root, Path archive, Map<String, Object> preview, CleanupInventoryJournal journal) { }
}
