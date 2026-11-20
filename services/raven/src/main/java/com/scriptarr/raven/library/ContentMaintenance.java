package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/** Persistent exact-scope maintenance fences and actual writer leases, independent of task status labels. */
public final class ContentMaintenance {
    private static final Map<String, List<String>> FENCES = new LinkedHashMap<>();
    private static final Map<String, Integer> WRITERS = new LinkedHashMap<>();
    private static final java.util.Set<String> TRANSIENT = new java.util.HashSet<>();
    private static final Map<String, Integer> WAITERS = new LinkedHashMap<>();
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Prevent construction of this process-wide writer gate. */
    private ContentMaintenance() { }

    /**
     * Load only this coordinator's small maintenance journals before startup writers execute.
     * @param downloads canonical managed root
     * @throws IOException when a persisted fence is malformed
     */
    public static synchronized void restore(Path downloads) throws IOException {
        Path directory = downloads.resolve(".content-maintenance");
        if (!Files.exists(directory)) return;
        if (Files.isSymbolicLink(directory) || !Files.isDirectory(directory)) throw new IOException("Invalid scoped maintenance directory.");
        try (var files = Files.list(directory)) {
            for (Path file : files.filter(p -> p.getFileName().toString().endsWith(".json")).toList()) {
                if (Files.isSymbolicLink(file) || Files.size(file) > 1_048_576) throw new IOException("Invalid scoped maintenance journal.");
                var row = JSON.readTree(file.toFile()); List<String> keys = new ArrayList<>();
                String operation = row.path("operationId").asText();
                if (!row.isObject() || !operation.matches("[A-Za-z0-9_-]{1,120}") || !file.getFileName().toString().equals(operation + ".json") || !row.path("keys").isArray()) throw new IOException("Invalid scoped maintenance identity.");
                for (var key : row.path("keys")) { if (!key.isTextual() || key.asText().isBlank() || key.asText().length() > 8192) throw new IOException("Invalid scoped maintenance key."); keys.add(key.asText()); }
                if (keys.isEmpty()) throw new IOException("Empty scoped maintenance journal.");
                FENCES.put(row.path("operationId").asText(), List.copyOf(keys));
            }
        }
    }

    /**
     * Persist a fence before deletion, retaining it across coordinator crashes and partial failures.
     * @param downloads canonical managed root
     * @param operationId reviewed cleanup identity
     * @param keys exact catalog, task, logical and path scopes
     * @throws IOException when the durable local fence cannot be saved
     */
    public static synchronized void block(Path downloads, String operationId, List<String> keys) throws IOException {
        if (!operationId.matches("[A-Za-z0-9_-]{1,120}") || keys.isEmpty()) throw new IOException("Invalid scoped maintenance identity.");
        if (TRANSIENT.contains(operationId)) throw new IOException("This maintenance identity is already active.");
        List<String> prior = FENCES.get(operationId);
        if (prior != null && !prior.equals(keys)) throw new IOException("Maintenance operation scope changed.");
        Path directory = downloads.resolve(".content-maintenance"); Files.createDirectories(directory);
        Path temp = Files.createTempFile(directory, "fence-", ".tmp");
        try { JSON.writeValue(temp.toFile(), Map.of("operationId", operationId, "keys", keys)); Files.move(temp, directory.resolve(operationId + ".json"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
        finally { Files.deleteIfExists(temp); }
        FENCES.put(operationId, List.copyOf(keys));
    }

    /** @param downloads managed root @param operationId completed cleanup @throws IOException when its exact journal cannot be removed */
    public static synchronized void release(Path downloads, String operationId) throws IOException {
        if (!operationId.matches("[A-Za-z0-9_-]{1,120}")) throw new IOException("Invalid maintenance identity.");
        if (TRANSIENT.contains(operationId)) throw new IOException("Transient maintenance must release its own fence.");
        Files.deleteIfExists(downloads.resolve(".content-maintenance").resolve(operationId + ".json")); FENCES.remove(operationId);
    }

    /** @param keys exact writer scopes @return lease retained until actual writer cleanup has finished */
    public static Lease enter(String... keys) { return enter(null, keys); }

    /** @param cancelled cooperative owner cancellation @param keys exact writer scopes @return lease after transient cleanup yields; permanent maintenance still rejects */
    public static synchronized Lease enter(java.util.function.BooleanSupplier cancelled, String... keys) {
        boolean registered = false;
        try {
            while (true) {
                if (Thread.currentThread().isInterrupted() || (cancelled != null && cancelled.getAsBoolean())) throw new java.util.concurrent.CancellationException("Waiting content writer cancelled.");
                boolean waiting = false;
                for (String key : keys) for (var fence : FENCES.entrySet()) if (fence.getValue().stream().anyMatch(blocked -> intersects(key, blocked))) {
                    if (!TRANSIENT.contains(fence.getKey())) throw new IllegalStateException("This title's content is under scoped maintenance.");
                    waiting = true;
                }
                if (!waiting) {for (String key : keys) WRITERS.merge(key, 1, Integer::sum);return new Lease(List.of(keys));}
                if (!registered) {for (String key : keys) WAITERS.merge(key, 1, Integer::sum);registered = true;}
                try {ContentMaintenance.class.wait(100);}
                catch (InterruptedException interrupted) {Thread.currentThread().interrupt();throw new java.util.concurrent.CancellationException("Waiting content writer cancelled.");}
            }
        } finally {if (registered) for (String key : keys) WAITERS.computeIfPresent(key, (_key, count) -> count == 1 ? null : count - 1);}
    }

    /** @param keys cleanup scopes @return number of actual writers and active transient cleanup operations */
    public static synchronized int active(List<String> keys) {
        return WRITERS.entrySet().stream().filter(row -> keys.stream().anyMatch(key -> intersects(row.getKey(), key))).mapToInt(Map.Entry::getValue).sum()
            + (int) TRANSIENT.stream().filter(id -> FENCES.get(id).stream().anyMatch(a -> keys.stream().anyMatch(b -> intersects(a, b)))).count();
    }

    /** @param operation unique process-local reclamation @param keys exact scopes @return temporary fence, or null when writers/maintenance already own the scope */
    public static synchronized TransientFence tryQuiescent(String operation, List<String> keys) {
        if (FENCES.containsKey(operation) || active(keys) != 0 || WAITERS.keySet().stream().anyMatch(a -> keys.stream().anyMatch(b -> intersects(a, b)))
            || FENCES.values().stream().anyMatch(existing -> existing.stream().anyMatch(a -> keys.stream().anyMatch(b -> intersects(a, b))))) return null;
        FENCES.put(operation, List.copyOf(keys));
        TRANSIENT.add(operation);
        return new TransientFence(operation);
    }

    /** Process-local exclusion for duplicate-artifact removal; canonical content is never removed by this fence. */
    public static final class TransientFence implements AutoCloseable {
        private final String operation;
        private final AtomicBoolean closed = new AtomicBoolean();
        /** @param operation exact process-local fence */
        private TransientFence(String operation) { this.operation = operation; }
        /** Release only this temporary exclusion. */
        @Override public void close() { synchronized (ContentMaintenance.class) {if (closed.compareAndSet(false, true)) {TRANSIENT.remove(operation);FENCES.remove(operation);ContentMaintenance.class.notifyAll();}} }
    }

    /** @param path managed path @return normalized writer key */
    public static String pathKey(Path path) { return "path:" + path.toAbsolutePath().normalize(); }

    /** @param first writer key @param second fenced key @return whether scopes intersect */
    private static boolean intersects(String first, String second) {
        if (first.startsWith("path:") && second.startsWith("path:")) { Path a = Path.of(first.substring(5)), b = Path.of(second.substring(5)); return a.startsWith(b) || b.startsWith(a); }
        return first.equals(second);
    }

    /** A writer lease closes only after the protected filesystem/catalog operation finishes. */
    public static final class Lease implements AutoCloseable {
        private final List<String> keys;
        private final AtomicBoolean closed = new AtomicBoolean();
        /** @param keys actual scopes held */
        private Lease(List<String> keys) { this.keys = keys; }
        /** Release actual writer counts exactly once. */
        @Override public void close() { synchronized (ContentMaintenance.class) { if (!closed.compareAndSet(false, true)) return; for (String key : keys) { int count = WRITERS.getOrDefault(key, 1) - 1; if (count == 0) WRITERS.remove(key); else WRITERS.put(key, count); } } }
    }
}
