package com.scriptarr.raven.library;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Immutable reviewed cleanup inventory and a separate durable completion receipt, safe across partial deletion. */
public final class CleanupInventoryJournal {
    private static final long MAX_BYTES = 256L * 1024 * 1024;
    private static final int MAX_ENTRIES = 1_000_000;
    private static final Object IO_LOCK = new Object();
    private static final ObjectMapper JSON = new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() { };
    private final Path downloads;
    private final Path directory;
    private final Path proof;
    private final Path receipt;
    private final Path lockPath;
    private final String operationId;

    /**
     * Bind a journal to one existing normal managed root and a safe operation name.
     * @param downloads existing canonical managed root
     * @param operationId immutable reviewed operation identity
     * @throws IOException when the root or journal path is unsafe
     */
    public CleanupInventoryJournal(Path downloads, String operationId) throws IOException {
        if (downloads == null || operationId == null || !operationId.matches("[A-Za-z0-9_-]{1,120}")) throw conflict();
        this.downloads = downloads.toAbsolutePath().normalize();
        this.operationId = operationId;
        directory = this.downloads.resolve(".content-maintenance");
        proof = directory.resolve(operationId + ".proof");
        receipt = directory.resolve(operationId + ".result");
        lockPath = directory.resolve(operationId + ".lock");
        ensureDirectory();
    }

    /**
     * Save the original reviewed snapshot once, or return it unchanged on the same operation/digest replay.
     * Later inventory observations never replace the reviewed inventory; supplied scope/path keys must still agree.
     * @param preview original full preview or a replay carrying its original operation and two digests
     * @return an independent copy of the immutable original preview
     * @throws IOException when identity, stored proof or current initial filesystem observations disagree
     */
    public Map<String, Object> saveOrLoad(Map<String, Object> preview) throws IOException {
        return locked(() -> {
            requireIdentity(preview);
            if (exists(proof)) {
                Map<String, Object> stored = reviewed();
                for (String key : List.of("operationId", "scopeDigest", "filesystemScopeDigest", "paths", "maintenanceKeys", "titleIds", "planCount")) {
                    if (preview.containsKey(key) && !sameJson(preview.get(key), stored.get(key))) throw conflict();
                }
                return stored;
            }
            if (exists(receipt)) throw conflict();
            Map<String, Object> original = JSON.convertValue(preview, MAP);
            validatePreview(original);
            Map<String, Object> remaining = verify(original);
            if (number(remaining.get("missingEntries")) != 0) throw conflict();
            atomicCreate(proof, Map.of("version", 1, "reviewed", original, "reviewedSha256", digest(original)));
            return reviewed();
        });
    }

    /**
     * Recover the original review before computing a new observation after a partial cleanup.
     * The caller must still compare its current durable scope identity before using this saved review.
     * @return an independent original review, or null before the initial preview was saved
     * @throws IOException when the stored proof is malformed or unsafe
     */
    public Map<String, Object> reviewedPreview() throws IOException {
        return locked(() -> exists(proof) ? reviewed() : null);
    }

    /**
     * Verify only the saved reviewed scope, allowing reviewed entries to be missing after earlier deletions.
     * Regular-file size, millisecond mtime and file key must agree; directory file keys must agree.
     * @return compact surviving/missing inventory counts and a successful verification flag
     * @throws IOException when any new path, changed identity, special file or symlink appears
     */
    public Map<String, Object> verifyRemaining() throws IOException {
        return locked(() -> verify(reviewed()));
    }

    /**
     * Save a separate atomic result only after every reviewed entry is absent, without replacing the original proof.
     * @param result acknowledged filesystem/catalog completion result
     * @throws IOException when files remain, proof differs or a different result already exists
     */
    public void markComplete(Map<String, Object> result) throws IOException {
        locked(() -> {
            if (result == null || result.containsKey("operationId") && !operationId.equals(result.get("operationId"))) throw conflict();
            Map<String, Object> original = reviewed();
            Map<String, Object> copy = JSON.convertValue(result, MAP);
            if (exists(receipt)) {
                if (!sameJson(completed(), copy)) throw conflict();
                return null;
            }
            if (number(verify(original).get("remainingEntries")) != 0) throw conflict();
            atomicCreate(receipt, Map.of("version", 1, "operationId", operationId, "reviewedSha256", digest(original), "result", copy, "resultSha256", digest(copy)));
            return null;
        });
    }

    /**
     * Read the original completed receipt for idempotent apply replay.
     * @return saved completion result, or null when no completion was acknowledged
     * @throws IOException when a receipt or its original reviewed proof is malformed or changed
     */
    public Map<String, Object> completedResult() throws IOException {
        return locked(() -> exists(receipt) ? completed() : null);
    }

    /**
     * Read and check the separate result against the unchanged original review.
     * @return validated stored result
     * @throws IOException when receipt validation fails
     */
    private Map<String, Object> completed() throws IOException {
        Map<String, Object> row = read(receipt), original = reviewed();
        Map<String, Object> result = map(row.get("result"));
        if (number(row.get("version")) != 1 || !operationId.equals(row.get("operationId"))
            || !digest(original).equals(row.get("reviewedSha256")) || !digest(result).equals(row.get("resultSha256"))) throw conflict();
        return result;
    }

    /**
     * Read and validate the original immutable inventory envelope.
     * @return saved original preview
     * @throws IOException when original content or checksum is invalid
     */
    private Map<String, Object> reviewed() throws IOException {
        Map<String, Object> row = read(proof), original = map(row.get("reviewed"));
        if (number(row.get("version")) != 1 || !digest(original).equals(row.get("reviewedSha256"))) throw conflict();
        validatePreview(original);
        return original;
    }

    /**
     * Validate immutable scope structure without following content paths.
     * @param preview original preview
     * @throws IOException when any scope row or identity is invalid
     */
    private void validatePreview(Map<String, Object> preview) throws IOException {
        requireIdentity(preview);
        List<String> roots = strings(preview.get("paths"));
        if (strings(preview.get("maintenanceKeys")).isEmpty()) throw conflict();
        List<?> inventory = list(preview.get("inventory"));
        if (inventory.size() > MAX_ENTRIES) throw conflict();
        Set<Path> paths = new HashSet<>();
        List<Path> approved = new ArrayList<>();
        for (String value : roots) {
            Path path = contentPath(value);
            if (approved.stream().anyMatch(other -> other.startsWith(path) || path.startsWith(other))) throw conflict();
            approved.add(path);
        }
        for (Object item : inventory) {
            Map<String, Object> row = map(item);
            Path path = contentPath(string(row.get("path")));
            if (!paths.add(path) || approved.stream().noneMatch(path::startsWith) || !(row.get("directory") instanceof Boolean)
                || string(row.get("fileKey")).isBlank() || "null".equals(row.get("fileKey"))) throw conflict();
            number(row.get("size")); number(row.get("modified"));
        }
    }

    /**
     * Check surviving files against the reviewed path set and immutable file attributes.
     * @param original original reviewed preview
     * @return remaining and missing entry counts
     * @throws IOException when surviving content is outside the original inventory or changed
     */
    private Map<String, Object> verify(Map<String, Object> original) throws IOException {
        Map<Path, Map<String, Object>> expected = new HashMap<>();
        for (Object value : list(original.get("inventory"))) {
            Map<String, Object> row = map(value); expected.put(contentPath(string(row.get("path"))), row);
        }
        Set<Path> seen = new HashSet<>();
        for (String value : strings(original.get("paths"))) {
            Path root = contentPath(value); noSymlinkAncestors(root);
            if (!exists(root)) continue;
            try (var walk = Files.walk(root)) {
                for (var iterator = walk.iterator(); iterator.hasNext();) {
                    Path file = iterator.next().toAbsolutePath().normalize();
                    BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                    Map<String, Object> prior = expected.get(file);
                    if (prior == null || !seen.add(file) || attributes.isSymbolicLink()
                        || !(attributes.isDirectory() || attributes.isRegularFile())
                        || attributes.isDirectory() != Boolean.TRUE.equals(prior.get("directory"))
                        || !String.valueOf(attributes.fileKey()).equals(prior.get("fileKey"))) throw conflict();
                    if (!attributes.isDirectory() && (attributes.size() != number(prior.get("size"))
                        || attributes.lastModifiedTime().toMillis() != number(prior.get("modified")))) throw conflict();
                }
            }
        }
        return Map.of("remainingEntries", seen.size(), "missingEntries", expected.size() - seen.size(), "verified", true);
    }

    /**
     * Require original operation and complete digest values.
     * @param preview caller identity
     * @throws IOException when identity is absent or changed
     */
    private void requireIdentity(Map<String, Object> preview) throws IOException {
        if (preview == null || !operationId.equals(preview.get("operationId"))) throw conflict();
        for (String key : List.of("scopeDigest", "filesystemScopeDigest")) if (!string(preview.get(key)).matches("[a-f0-9]{64}")) throw conflict();
    }

    /**
     * Validate a title-owned lexical path below one supported managed content category.
     * @param value absolute reviewed path
     * @return safe lexical path
     * @throws IOException when path scope is not an owned content subtree
     */
    private Path contentPath(String value) throws IOException {
        Path path;
        try { path = Path.of(value); } catch (RuntimeException invalid) { throw conflict(); }
        if (!path.isAbsolute() || !path.equals(path.normalize()) || !path.startsWith(downloads) || path.equals(downloads)) throw conflict();
        Path relative = downloads.relativize(path); String category = relative.getName(0).toString();
        int minimum = List.of("downloaded", "downloading", "ingested").contains(category) ? 3
            : List.of(".ingest-staging", ".ingest-jobs").contains(category) ? 2 : Integer.MAX_VALUE;
        if (relative.getNameCount() < minimum) throw conflict();
        return path;
    }

    /**
     * Reject symbolic links in every existing ancestor without requiring removed paths to exist.
     * @param path candidate path
     * @throws IOException when a link exists in the path chain
     */
    private static void noSymlinkAncestors(Path path) throws IOException {
        for (Path cursor = path; cursor != null; cursor = cursor.getParent()) if (Files.isSymbolicLink(cursor)) throw conflict();
    }

    /**
     * Require a normal existing data root and a safe private journal directory.
     * @throws IOException when root/journal directories are unavailable or linked
     */
    private void ensureDirectory() throws IOException {
        noSymlinkAncestors(downloads);
        if (!Files.isDirectory(downloads, LinkOption.NOFOLLOW_LINKS)) throw conflict();
        try { Files.createDirectory(directory); } catch (FileAlreadyExistsException existing) { /* Validate below. */ }
        if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(directory)) throw conflict();
        for (Path file : List.of(proof, receipt, lockPath)) if (exists(file)
            && (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(file))) throw conflict();
    }

    /**
     * Create a flushed same-directory atomic document while holding the operation lock.
     * @param target previously absent target
     * @param value bounded document
     * @throws IOException when an existing target, unsafe parent or atomic write prevents persistence
     */
    private void atomicCreate(Path target, Map<String, Object> value) throws IOException {
        ensureDirectory(); if (exists(target)) throw conflict();
        byte[] bytes = JSON.writeValueAsBytes(value); if (bytes.length > MAX_BYTES) throw conflict();
        Path temp = Files.createTempFile(directory, operationId + "-", ".tmp");
        try {
            try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                ByteBuffer buffer = ByteBuffer.wrap(bytes); while (buffer.hasRemaining()) channel.write(buffer); channel.force(true);
            }
            ensureDirectory(); if (exists(target)) throw conflict();
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE);
        } finally { Files.deleteIfExists(temp); }
    }

    /**
     * Read only a bounded normal journal file without following links.
     * @param file journal document
     * @return parsed object
     * @throws IOException when malformed, oversized or unsafe
     */
    private Map<String, Object> read(Path file) throws IOException {
        ensureDirectory();
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_BYTES) throw conflict();
        try (InputStream input = new BoundedInput(Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS))) {
            return JSON.readValue(input, MAP);
        } catch (IOException malformed) { throw conflict(); }
    }

    /**
     * Serialize cooperating instances and processes against the same operation's lock file.
     * @param action checked operation
     * @param <T> return type
     * @return operation result
     * @throws IOException when locking or the operation fails
     */
    private <T> T locked(Action<T> action) throws IOException {
        synchronized (IO_LOCK) {
            ensureDirectory();
            try (FileChannel channel = FileChannel.open(lockPath, StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
                 FileLock ignored = channel.lock()) { return action.run(); }
        }
    }

    /** Checked operation executed under an exclusive journal lock. */
    @FunctionalInterface
    private interface Action<T> {
        /** @return result @throws IOException when operation validation fails */
        T run() throws IOException;
    }

    /** JSON stream bound remains enforced even if a file grows while being read. */
    private static final class BoundedInput extends FilterInputStream {
        private long count;
        /** @param input journal stream */
        private BoundedInput(InputStream input) { super(input); }
        /** @return next byte @throws IOException when the file exceeds its bound */
        @Override public int read() throws IOException { int value = super.read(); if (value >= 0 && ++count > MAX_BYTES) throw conflict(); return value; }
        /** @param buffer target @param offset start @param length maximum @return bytes read @throws IOException when the file exceeds its bound */
        @Override public int read(byte[] buffer, int offset, int length) throws IOException {
            int size = in.read(buffer, offset, length); if (size > 0 && (count += size) > MAX_BYTES) throw conflict(); return size;
        }
    }

    /** @param value JSON value @return typed object @throws IOException when type differs */
    private static Map<String, Object> map(Object value) throws IOException {
        if (!(value instanceof Map<?, ?>)) throw conflict(); return JSON.convertValue(value, MAP);
    }
    /** @param value JSON value @return array @throws IOException when type differs */
    private static List<?> list(Object value) throws IOException { if (!(value instanceof List<?> values)) throw conflict(); return values; }
    /** @param value JSON value @return nonnegative integral count @throws IOException when type differs */
    private static long number(Object value) throws IOException {
        if (!(value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long)
            || ((Number) value).longValue() < 0) throw conflict();
        return ((Number) value).longValue();
    }
    /** @param left first JSON value @param right second JSON value @return equality independent of Java numeric wrappers or map order @throws IOException when serialization fails */
    private static boolean sameJson(Object left, Object right) throws IOException {
        return JSON.readTree(JSON.writeValueAsBytes(left)).equals(JSON.readTree(JSON.writeValueAsBytes(right)));
    }
    /** @param value JSON value @return text or empty */
    private static String string(Object value) { return value instanceof String text ? text : ""; }
    /** @param value JSON value @return unique text values @throws IOException when type differs */
    private static List<String> strings(Object value) throws IOException {
        List<String> result = new ArrayList<>(); Set<String> seen = new HashSet<>();
        for (Object item : list(value)) { String text = string(item); if (text.isBlank() || text.length() > 8192 || !seen.add(text)) throw conflict(); result.add(text); }
        return result;
    }
    /** @param value stored document @return stable digest of its preserved JSON key order @throws IOException when serialization fails */
    private static String digest(Map<String, Object> value) throws IOException {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(JSON.writeValueAsBytes(value))); }
        catch (java.security.NoSuchAlgorithmException unavailable) { throw new IOException("Cleanup digest unavailable."); }
    }
    /** @param path path without link following @return whether an entry exists */
    private static boolean exists(Path path) { return Files.exists(path, LinkOption.NOFOLLOW_LINKS); }
    /** @return bounded validation error with no paths or document contents */
    private static IOException conflict() { return new IOException("cleanup_inventory_conflict: reviewed filesystem proof is unsafe or changed."); }
}
