package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.BooleanSupplier;

/** Restore a lost immutable manifest without replacing retained content or accepting foreign revision files. */
final class ImmutableManifestRecovery {
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Prevent construction of the scoped publication utility. */
    private ImmutableManifestRecovery() { }

    /**
     * Validate every retained file before installing absent accepted files and the manifest last.
     * Private-stage temporary copies use ordinary moves without REPLACE_EXISTING on the downloads filesystem; the held
     * title/maintenance lease serializes coordinator writers, and an occupied path is never overwritten.
     * @param stage complete private accepted publication stage
     * @param destination existing exact immutable revision directory
     * @param ingestRoot coordinator-owned ingested storage root
     * @param cancelled owning cancellation predicate
     * @throws IOException when identity, hashes, scope or create-new publication fails
     * @throws InterruptedException when the owner cancels before a publication checkpoint
     */
    static void restore(Path stage, Path destination, Path ingestRoot, BooleanSupplier cancelled) throws IOException, InterruptedException {
        checkScope(destination, ingestRoot);
        Path manifest = stage.resolve("manifest.json"), targetManifest = destination.resolve("manifest.json");
        if (Files.isSymbolicLink(stage) || !Files.isDirectory(stage, LinkOption.NOFOLLOW_LINKS)
            || Files.isSymbolicLink(manifest) || !Files.isRegularFile(manifest, LinkOption.NOFOLLOW_LINKS)
            || Files.size(manifest) <= 0 || Files.size(manifest) > 8_388_608 || Files.exists(targetManifest, LinkOption.NOFOLLOW_LINKS)) throw invalid();
        JsonNode metadata = JSON.readTree(manifest.toFile());
        if (!"webp".equals(metadata.path("format").asText()) || !"image/webp".equals(metadata.path("mediaType").asText())
            || !destination.getFileName().toString().equals(metadata.path("revision").asText())
            || !destination.getParent().getFileName().toString().equals(metadata.path("chapterId").asText())
            || !destination.getParent().getParent().getFileName().toString().equals(metadata.path("titleId").asText())
            || !metadata.path("pages").isArray() || metadata.path("pages").isEmpty()
            || metadata.path("pageCount").asInt() != metadata.path("pages").size()) throw invalid();
        Map<String, JsonNode> expected = new TreeMap<>();
        for (JsonNode page : metadata.path("pages")) {
            if (!page.path("segments").isArray() || page.path("segments").isEmpty()) throw invalid();
            for (JsonNode segment : page.path("segments")) add(expected, segment);
        }
        add(expected, metadata.path("pages").get(0).path("thumbnail"));
        try (var paths = Files.list(stage)) {
            for (Path file : paths.toList()) if (!file.equals(manifest) && !expected.containsKey(file.getFileName().toString())) throw invalid();
        }
        for (var row : expected.entrySet()) checkFile(stage.resolve(row.getKey()), row.getValue());
        try (var paths = Files.list(destination)) {
            for (Path retained : paths.toList()) {
                JsonNode row = expected.get(retained.getFileName().toString());
                if (row == null) throw invalid();
                checkFile(retained, row);
            }
        }
        for (var row : expected.entrySet()) {
            checkCancelled(cancelled); Path target = destination.resolve(row.getKey());
            if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) installNew(stage.resolve(row.getKey()), target);
            checkFile(target, row.getValue());
        }
        checkCancelled(cancelled);
        installNew(manifest, targetManifest);
    }

    /** @param source complete validated stage file @param target absent immutable destination @throws IOException when copy verification or non-replacing publication fails */
    private static void installNew(Path source, Path target) throws IOException {
        long size = Files.size(source); String hash = WebpChapterEncoder.sha256(source);
        Path temporary = prepareCopy(source, target);
        try {
            try { Files.move(temporary, target); }
            catch (FileAlreadyExistsException raced) {
                if (Files.isSymbolicLink(target) || !Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)
                    || Files.size(target) != size || !WebpChapterEncoder.sha256(target).equals(hash)) throw invalid();
            }
        } finally { Files.deleteIfExists(temporary); }
    }

    /** @param source validated stage file @param target immutable publication destination @return verified temporary copy ready for non-replacing publication @throws IOException when staging fails */
    static Path prepareCopy(Path source, Path target) throws IOException {
        Path temporary = Files.createTempFile(source.getParent(), "restore-", ".tmp");
        try {
            Files.copy(source, temporary, StandardCopyOption.REPLACE_EXISTING);
            if (Files.size(temporary) != Files.size(source) || !WebpChapterEncoder.sha256(temporary).equals(WebpChapterEncoder.sha256(source))) throw invalid();
            return temporary;
        } catch (IOException | RuntimeException failure) { Files.deleteIfExists(temporary); throw failure; }
    }

    /** @param destination exact revision path @param root allowed storage category @throws IOException when a directory is foreign, linked or missing */
    private static void checkScope(Path destination, Path root) throws IOException {
        Path target = destination.toAbsolutePath().normalize(), allowed = root.toAbsolutePath().normalize();
        if (!target.startsWith(allowed) || target.equals(allowed)) throw invalid();
        for (Path cursor = target; cursor != null && cursor.startsWith(allowed); cursor = cursor.getParent()) {
            if (Files.isSymbolicLink(cursor) || !Files.isDirectory(cursor, LinkOption.NOFOLLOW_LINKS)) throw invalid();
            if (cursor.equals(allowed)) break;
        }
        if (!target.toRealPath().startsWith(allowed.toRealPath())) throw invalid();
    }

    /** @param expected exact accepted filenames @param row accepted file declaration @throws IOException when names or declarations are unsafe */
    private static void add(Map<String, JsonNode> expected, JsonNode row) throws IOException {
        String name = row.path("slug").asText();
        if (!name.matches("p[0-9]{6}(?:-s[0-9]{4}|-thumbnail)\\.webp") || !row.path("sha256").asText().matches("[a-f0-9]{64}")
            || !row.path("size").isIntegralNumber() || row.path("size").asLong() <= 0 || row.path("size").asLong() > 134_217_728
            || expected.putIfAbsent(name, row) != null) throw invalid();
    }

    /** @param file staged or retained accepted file @param expected immutable declaration @throws IOException when bytes or ownership differ */
    private static void checkFile(Path file, JsonNode expected) throws IOException {
        if (Files.isSymbolicLink(file) || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) != expected.path("size").asLong()
            || !WebpChapterEncoder.sha256(file).equals(expected.path("sha256").asText())) throw invalid();
    }

    /** @param cancelled owner predicate @throws InterruptedException when publication must stop before creating another path */
    private static void checkCancelled(BooleanSupplier cancelled) throws InterruptedException {
        if (Thread.currentThread().isInterrupted() || cancelled != null && cancelled.getAsBoolean()) throw new InterruptedException("Immutable publication was cancelled.");
    }

    /** @return bounded conflict without private paths, source URLs or output metadata */
    private static IOException invalid() { return new IOException("Missing-manifest recovery found unverified immutable content."); }
}
