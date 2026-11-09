package com.scriptarr.raven.library;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Bounded process-local migration hints; final completion always performs a fresh strict content sweep. */
final class MigrationVerificationCursor {
    private static final int MAX_SCOPES = 32;
    private final Map<Scope, State> scopes = new ConcurrentHashMap<>();

    /** @param context exact durable migration attribution @param titleId canonical owner @param chapters current ordered checkpoints @return validated prefix hint for this pass */
    Pass begin(Map<String, Object> context, String titleId, List<LibraryChapter> chapters) {
        String run = string(context.get("runId")), task = string(context.get("taskId"));
        Scope scope = "migration".equals(context.get("kind")) && !run.isBlank() && !task.isBlank() ? new Scope(run, task, titleId) : null;
        if (scopes.size() >= MAX_SCOPES && (scope == null || !scopes.containsKey(scope))) scopes.clear();
        State state = scope == null ? new State() : scopes.computeIfAbsent(scope, key -> new State());
        int start = 0;
        while (start < chapters.size() && start < state.prefix.size() && state.prefix.get(start).matches(chapters.get(start))) start++;
        if (start < state.prefix.size()) state.prefix.subList(start, state.prefix.size()).clear();
        return new Pass(scope, state, start);
    }

    /** @param value optional attribution @return exact text or empty */
    private static String string(Object value) { return value instanceof String text ? text : ""; }

    /** One lock-protected migration quantum over an existing process-local prefix. */
    final class Pass {
        private final Scope scope;
        private final State state;
        private final int start;

        /** @param scope explicit owner, or null for an unscoped compatibility call @param state current proof hints @param start first unverified chapter */
        private Pass(Scope scope, State state, int start) { this.scope = scope; this.state = state; this.start = start; }

        /** @return first chapter requiring this pass's strict validation */
        int start() { return start; }

        /** @param index acknowledged chapter position @param chapter strictly verified or newly committed checkpoint */
        void record(int index, LibraryChapter chapter) {
            if (scope == null || index != state.prefix.size()) return;
            try { state.prefix.add(Evidence.capture(chapter)); }
            catch (IOException | RuntimeException unavailable) { discard(); }
        }

        /** Discard proof on terminal completion, cancellation or any failed pass. */
        void discard() { state.prefix.clear(); if (scope != null) scopes.remove(scope, state); }
    }

    /** Exact migration owner; another run/task cannot inherit a prior execution's proof. */
    private record Scope(String runId, String taskId, String titleId) { }

    /** Ordered contiguous prefix, accessed under LibraryService's existing canonical title lock. */
    private static final class State { private final List<Evidence> prefix = new ArrayList<>(); }

    /** Content checkpoint identity deliberately excludes mutable title summaries and descriptive metadata. */
    private record Identity(String id, boolean available, String archive, int pages, String status, String revision,
                            int ingestedPages, String ingestedAt, String manifest, Integer sourcePages,
                            Integer expectedSegments, Integer ingestedSegments, Boolean segmentsReady) {
        /** @param chapter durable checkpoint @return all fields which can change content/readiness identity */
        static Identity of(LibraryChapter chapter) {
            return new Identity(chapter.id(), chapter.available(), chapter.archivePath(), chapter.pageCount(), chapter.ingestStatus(),
                chapter.ingestRevision(), chapter.ingestedPageCount(), chapter.ingestedAt(), chapter.ingestManifestPath(),
                chapter.sourcePageCount(), chapter.expectedSegmentCount(), chapter.ingestedSegmentCount(), chapter.segmentsReady());
        }
    }

    /** No content bytes are trusted from this hint: every source, manifest, tile and thumbnail retains its file identity and nanosecond timestamp. */
    private record Stamp(Path path, Object fileKey, long size, FileTime modified) {
        /** @param path exact previously validated regular file @return non-following file evidence @throws IOException when missing or replaced by a link */
        static Stamp capture(Path path) throws IOException {
            BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile() || attributes.isSymbolicLink()) throw new IOException("Migration evidence is unavailable.");
            return new Stamp(path, attributes.fileKey(), attributes.size(), attributes.lastModifiedTime());
        }
    }

    /** Process-local evidence never survives restart and never substitutes for the final strict sweep. */
    private record Evidence(Identity identity, List<Stamp> files) {
        /** @param chapter acknowledged checkpoint @return exact immutable-file evidence @throws IOException when a saved output is unavailable */
        static Evidence capture(LibraryChapter chapter) throws IOException {
            if (!chapter.available() || chapter.archivePath() == null || chapter.archivePath().isBlank()) return new Evidence(Identity.of(chapter), List.of());
            if (!"ready".equals(chapter.ingestStatus()) || chapter.ingestRevision() == null || !chapter.ingestRevision().startsWith("webp-")) throw new IOException("Migration checkpoint is not ready WebP.");
            Path manifest = Path.of(chapter.ingestManifestPath()).toAbsolutePath().normalize(), root = manifest.getParent();
            var saved = DerivedPageManifest.read(chapter);
            LinkedHashSet<Path> paths = new LinkedHashSet<>(List.of(Path.of(chapter.archivePath()).toAbsolutePath().normalize(), manifest));
            for (var page : saved.path("pages")) {
                for (var segment : page.path("segments")) paths.add(scoped(root, segment.path("slug").asText()));
                if (page.has("thumbnail")) paths.add(scoped(root, page.path("thumbnail").path("slug").asText()));
            }
            List<Stamp> stamps = new ArrayList<>(); for (Path file : paths) stamps.add(Stamp.capture(file));
            return new Evidence(Identity.of(chapter), List.copyOf(stamps));
        }

        /** @param root validated output directory @param slug saved file basename @return exact non-linked output file @throws IOException when scope differs */
        private static Path scoped(Path root, String slug) throws IOException {
            if (slug.isBlank() || slug.contains("/") || slug.contains("\\") || slug.equals(".") || slug.equals("..")) throw new IOException("Migration evidence path differs.");
            Path file = root.resolve(slug); if (Files.isSymbolicLink(file) || !file.toRealPath().getParent().equals(root.toRealPath())) throw new IOException("Migration evidence path differs.");
            return file;
        }

        /** @param chapter latest checkpoint @return whether cheap immutable identity/stat evidence still agrees */
        boolean matches(LibraryChapter chapter) {
            if (!identity.equals(Identity.of(chapter))) return false;
            try { for (Stamp file : files) if (!file.equals(Stamp.capture(file.path()))) return false; return true; }
            catch (IOException | RuntimeException unavailable) { return false; }
        }
    }
}
