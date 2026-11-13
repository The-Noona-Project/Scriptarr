package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Function;

/** Journal complete chapter candidates while the old canonical archive and reader remain published. */
final class ChapterRepairPublication {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final Path downloads;
    private final LibraryIngestService ingest;
    private final LibraryTitleLocks locks;
    private final Function<String, LibraryTitle> load;
    private final BiFunction<String, LibraryChapter, LibraryChapter> checkpoint;
    private final Consumer<String> summarize;

    /** @param downloads managed root @param ingest existing fenced converter @param locks shared title leases @param load strict title reader @param checkpoint ordinary isolated-test checkpoint */
    ChapterRepairPublication(Path downloads, LibraryIngestService ingest, LibraryTitleLocks locks,
        Function<String, LibraryTitle> load, BiFunction<String, LibraryChapter, LibraryChapter> checkpoint) {
        this(downloads, ingest, locks, load, checkpoint, id -> {});
    }

    /** @param downloads managed root @param ingest fenced converter @param locks title leases @param load strict reader @param checkpoint ordinary checkpoint @param summarize acknowledged title-card refresh */
    ChapterRepairPublication(Path downloads, LibraryIngestService ingest, LibraryTitleLocks locks,
        Function<String, LibraryTitle> load, BiFunction<String, LibraryChapter, LibraryChapter> checkpoint, Consumer<String> summarize) {
        this.downloads = downloads.toAbsolutePath().normalize(); this.ingest = ingest; this.locks = locks; this.load = load; this.checkpoint = checkpoint; this.summarize = summarize;
    }

    /**
     * Convert a complete private candidate, then commit only its chapter without replacing siblings.
     * @param taskId approved repair identity
     * @param titleId canonical title
     * @param chapterId exact chapter
     * @param candidate isolated candidate CBZ
     * @param expectedSource frozen exact source URL
     * @param expectedNumber frozen catalog chapter number
     * @param cancelled cooperative cancellation
     * @param progress meaningful conversion progress
     * @return acknowledged ready chapter
     * @throws Exception when conversion, identity or persistence cannot be verified
     */
    LibraryChapter publish(String taskId, String titleId, String chapterId, Path candidate, String expectedSource, String expectedNumber,
        BooleanSupplier cancelled, Consumer<IngestProgress> progress) throws Exception {
        try (var maintenance = ContentMaintenance.enter("title:" + titleId); var lease = locks.acquire(titleId)) {
            Path file = journal(downloads, taskId, chapterId); Files.createDirectories(file.getParent());
            if (Files.isRegularFile(file)) {
                JsonNode saved = read(file);
                if (!expectedSource.equals(saved.path("originalChapter").path("sourceUrl").asText())
                    || !expectedNumber.equals(saved.path("originalChapter").path("chapterNumber").asText())) throw new IOException("Frozen repair source changed.");
                if (List.of("publishing", "completed").contains(saved.path("phase").asText())) return finish(file, saved);
            }
            if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new InterruptedException("Chapter repair cancelled.");
            LibraryTitle title = requireTitle(titleId); LibraryChapter old = chapter(title, chapterId);
            if (!expectedSource.equals(old.sourceUrl()) || !expectedNumber.equals(old.chapterNumber())) throw new IOException("Frozen repair chapter identity changed.");
            Path source = candidate.toAbsolutePath().normalize();
            if (!source.startsWith(file.getParent()) || Files.isSymbolicLink(source) || !Files.isRegularFile(source)
                || !source.toRealPath().startsWith(file.getParent().toRealPath())) throw new IOException("Repair candidate escaped its managed scope.");
            int pages = ArchiveImageEntries.verifiedCount(source);
            if (pages <= 0) throw new IOException("Repair candidate has no valid source pages.");
            if (ArchiveDownloadEvidence.read(source, old.sourceUrl(), pages) != null) throw new IOException("Repair candidate still contains missing-page evidence.");
            int expectedPages = old.sourcePageCount() != null && old.sourcePageCount() > 0 ? old.sourcePageCount() : old.expectedPageCount();
            if (expectedPages > 0 && expectedPages != pages) throw new IOException("Source page count changed; review the source before repair.");
            String hash = WebpChapterEncoder.sha256(source);
            Path canonicalRoot = canonicalRoot(title);
            String base = old.archivePath() == null || old.archivePath().isBlank() ? source.getFileName().toString() : Path.of(old.archivePath()).getFileName().toString();
            String name = base.replaceFirst("(?i)\\.cbz$", "") + " [repair-" + hash.substring(0, 16) + "].cbz";
            Path target = canonicalRoot.resolve(name);
            Map<String, Object> state = new LinkedHashMap<>();
            if (Files.isRegularFile(file)) {
                state.putAll(JSON.convertValue(read(file), new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() { }));
                if (!hash.equals(state.get("candidateSha256")) || !source.toString().equals(state.get("candidatePath"))) throw new IOException("The staged repair source changed; review a new repair request.");
            } else {
                state.putAll(Map.of("version", 1, "taskId", taskId, "titleId", titleId, "chapterId", chapterId,
                    "sourceUrl", title.sourceUrl(), "candidatePath", source.toString(), "candidateSha256", hash,
                    "candidateSize", Files.size(source), "targetPath", target.toString(), "phase", "prepared"));
                state.put("originalChapter", old); state.put("originalSha256", "");
                if (old.archivePath() != null && !old.archivePath().isBlank() && Files.isRegularFile(Path.of(old.archivePath()))) {
                    Path original = scopedCanonical(Path.of(old.archivePath()), canonicalRoot);
                    String originalHash = WebpChapterEncoder.sha256(original); state.put("originalSha256", originalHash);
                    Path backup = file.getParent().resolve("original.cbz");
                    Files.copy(original, backup, StandardCopyOption.REPLACE_EXISTING);
                    if (!originalHash.equals(WebpChapterEncoder.sha256(backup))) throw new IOException("Original archive backup could not be verified.");
                }
                write(file, state);
            }
            LibraryChapter input = new LibraryChapter(old.id(), old.label(), old.chapterNumber(), pages, old.releaseDate(), true,
                source.toString(), old.sourceUrl(), "clean", pages, 0, List.of(), List.of(), "pending", "", 0, null, "", "", old.updatedAt());
            LibraryIngestResult result;
            try (var attribution = IngestExecutionContext.enter("interactive", Map.of("taskId", taskId, "repairTaskId", taskId))) {
                result = ingest.ingestChapter(title, input, cancelled, progress);
            }
            if (!result.revision().startsWith("webp-")) throw new IOException("Chapter repair requires complete WebP output.");
            LibraryChapter ready = new LibraryChapter(input.id(), input.label(), input.chapterNumber(), pages, input.releaseDate(), true,
                input.archivePath(), input.sourceUrl(), "clean", pages, 0, List.of(), List.of(), "ready", result.revision(),
                result.pageCount(), result.ingestedAt(), "", result.manifestPath(), old.updatedAt());
            target = scopedCanonical(Path.of(String.valueOf(state.get("targetPath"))), canonicalRoot);
            Map<String, Object> fields = JSON.convertValue(ready, new com.fasterxml.jackson.core.type.TypeReference<>() { });
            fields.putAll(DerivedPageManifest.catalogFields(ready)); fields.put("archivePath", target.toString());
            if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new InterruptedException("Chapter repair cancelled before publication.");
            state.put("readyChapter", fields); state.put("conversion", result); state.put("phase", "publishing");
            write(file, state);
            return finish(file, JSON.valueToTree(state));
        }
    }

    /** @param titleId locked canonical owner @throws Exception when a previously approved publication remains unresolved */
    void recover(String titleId) throws Exception {
        Path root = downloads.resolve(".chapter-repairs");
        if (!Files.isDirectory(root)) return;
        try (var paths = Files.walk(root, 3)) {
            for (Path file : paths.filter(p -> p.getFileName().toString().equals("publication.json")).toList()) {
                JsonNode saved = read(file);
                if (titleId.equals(saved.path("titleId").asText()) && "publishing".equals(saved.path("phase").asText())) finish(file, saved);
            }
        }
    }

    /** @param taskId durable repair @param titleId canonical title @param chapterId exact chapter @return whether its prior approved publication has committed @throws Exception when recovery cannot be verified */
    boolean completed(String taskId, String titleId, String chapterId) throws Exception {
        try (var lease = locks.acquire(titleId)) {
            Path file = journal(downloads, taskId, chapterId);
            if (!Files.isRegularFile(file)) return false;
            JsonNode saved = read(file);
            if (!List.of("publishing", "completed").contains(saved.path("phase").asText())) return false;
            finish(file, saved); return true;
        }
    }

    private LibraryChapter finish(Path file, JsonNode state) throws Exception {
        String titleId = state.path("titleId").asText(), chapterId = state.path("chapterId").asText();
        if (state.path("version").asInt() != 1 || !file.equals(journal(downloads, state.path("taskId").asText(), chapterId))) throw new IOException("Repair journal identity differs.");
        LibraryTitle title = requireTitle(titleId);
        if (!title.sourceUrl().equals(state.path("sourceUrl").asText())) throw new IOException("Repair source ownership changed.");
        LibraryChapter old = JSON.treeToValue(state.path("originalChapter"), LibraryChapter.class);
        LibraryChapter ready = JSON.treeToValue(state.path("readyChapter"), LibraryChapter.class), current = chapter(title, chapterId);
        Path root = canonicalRoot(title);
        Path target = scopedCanonical(Path.of(state.path("targetPath").asText()), root);
        if (!chapterId.equals(old.id()) || !chapterId.equals(ready.id()) || !target.toString().equals(ready.archivePath())
            || !java.util.Objects.equals(old.sourceUrl(), ready.sourceUrl()) || ready.expectedPageCount() <= 0
            || ready.expectedPageCount() != ready.pageCount() || ready.pageCount() != ready.ingestedPageCount()) throw new IOException("Repair publication identity differs.");
        if (!samePublished(current, ready)) {
            if (!JSON.valueToTree(old).equals(JSON.valueToTree(current))) throw new IOException("The chapter changed after this repair was prepared.");
            Path source = input(downloads, state.path("taskId").asText(), titleId, chapterId, state.path("candidateSha256").asText(), state.path("candidateSize").asLong());
            if (Files.exists(target)) {
                if (!state.path("candidateSha256").asText().equals(WebpChapterEncoder.sha256(target))) throw new IOException("Immutable repaired archive differs.");
            } else {
                Path temp = Files.createTempFile(target.getParent(), ".repair-", ".tmp");
                try { Files.copy(source, temp, StandardCopyOption.REPLACE_EXISTING); move(temp, target); }
                finally { Files.deleteIfExists(temp); }
            }
            if (!DerivedPageManifest.reusable(ready)) throw new IOException("Repair publication cannot verify every reader page.");
            LibraryIngestResult result = JSON.treeToValue(state.path("conversion"), LibraryIngestResult.class);
            try { current = result.conversionJobId().isBlank() ? checkpoint.apply(titleId, ready) : ingest.commitRemoteChapter(titleId, ready, result); }
            catch (RuntimeException uncertain) {
                current = chapter(requireTitle(titleId), chapterId);
                if (!samePublished(current, ready)) throw uncertain;
            }
            if (!samePublished(current, ready)) throw new IOException("Repair catalog publication was not acknowledged.");
        }
        if (!state.path("candidateSha256").asText().equals(WebpChapterEncoder.sha256(target))) throw new IOException("Published repair archive differs.");
        if (!DerivedPageManifest.reusable(current)) throw new IOException("Published repair is no longer reader-ready.");
        summarize.accept(titleId);
        String oldHash = state.path("originalSha256").asText();
        if (!oldHash.isBlank() && old.archivePath() != null && !old.archivePath().isBlank()) {
            Path original = scopedCanonical(Path.of(old.archivePath()), root);
            Path backup = file.getParent().resolve("original.cbz");
            if (!oldHash.equals(WebpChapterEncoder.sha256(backup))) throw new IOException("Retained original archive evidence differs.");
            if (!original.equals(target) && Files.exists(original)) {
                if (!oldHash.equals(WebpChapterEncoder.sha256(original))) throw new IOException("Original archive changed before archival.");
                Files.delete(original);
            }
        }
        Map<String, Object> completed = JSON.convertValue(state, new com.fasterxml.jackson.core.type.TypeReference<>() { });
        completed.put("phase", "completed"); write(file, completed); return current;
    }

    /**
     * Resolve a coordinator-approved staged input; a worker never supplies a filesystem path.
     * @param downloads managed root @param taskId approved task @param titleId exact title @param chapterId exact chapter
     * @param hash immutable source digest @param size immutable source size @return verified private candidate @throws IOException when binding differs
     */
    static Path input(Path downloads, String taskId, String titleId, String chapterId, String hash, long size) throws IOException {
        Path file = journal(downloads, taskId, chapterId); JsonNode saved = read(file);
        if (saved.path("version").asInt() != 1 || !taskId.equals(saved.path("taskId").asText())
            || !titleId.equals(saved.path("titleId").asText()) || !chapterId.equals(saved.path("chapterId").asText())
            || !hash.equals(saved.path("candidateSha256").asText()) || size != saved.path("candidateSize").asLong()) throw new IOException("Repair source binding differs.");
        Path candidate = Path.of(saved.path("candidatePath").asText()).toAbsolutePath().normalize();
        if (!candidate.startsWith(file.getParent()) || Files.isSymbolicLink(candidate) || !Files.isRegularFile(candidate)
            || !candidate.toRealPath().startsWith(file.getParent().toRealPath()) || Files.size(candidate) != size
            || !hash.equals(WebpChapterEncoder.sha256(candidate))) throw new IOException("Repair candidate fingerprint differs.");
        return candidate;
    }

    /** @param downloads managed root @param taskId approved repair @param chapterId chapter identity @param candidate private input @return original completed receipt's canonical target @throws IOException when its candidate binding differs */
    static Path publishedArchive(Path downloads, String taskId, String chapterId, Path candidate) throws IOException {
        JsonNode state = read(journal(downloads, taskId, chapterId));
        input(downloads, taskId, state.path("titleId").asText(), chapterId, state.path("candidateSha256").asText(), state.path("candidateSize").asLong());
        if (!candidate.toAbsolutePath().normalize().equals(Path.of(state.path("candidatePath").asText()).toAbsolutePath().normalize())) throw new IOException("Repair input identity changed.");
        return Path.of(state.path("targetPath").asText()).toAbsolutePath().normalize();
    }

    /** @param downloads managed root @param taskId approved repair @param chapterId exact chapter @return coordinator-private journal path @throws IOException when identifiers are unsafe */
    static Path journal(Path downloads, String taskId, String chapterId) throws IOException {
        if (!taskId.matches("task_repair_[a-f0-9]{64}") || (!chapterId.matches("[A-Za-z0-9_.:-]{1,160}") || List.of(".", "..").contains(chapterId))) throw new IOException("Invalid repair identity.");
        Path root = downloads.toAbsolutePath().normalize().resolve(".chapter-repairs");
        Path file = root.resolve(taskId).resolve(chapterId).resolve("publication.json");
        for (Path current = file.getParent(); current != null && current.startsWith(root); current = current.getParent()) {
            if (Files.isSymbolicLink(current)) throw new IOException("Repair scope must not follow a link.");
        }
        return file;
    }

    private LibraryTitle requireTitle(String id) throws IOException {
        LibraryTitle title = load.apply(id); if (title == null) throw new IOException("Repair title is unavailable."); return title;
    }
    private static LibraryChapter chapter(LibraryTitle title, String id) throws IOException {
        return title.chapters().stream().filter(c -> id.equals(c.id())).findFirst().orElseThrow(() -> new IOException("Repair chapter is unavailable."));
    }
    private static boolean samePublished(LibraryChapter current, LibraryChapter expected) {
        return current.id().equals(expected.id()) && current.archivePath().equals(expected.archivePath())
            && java.util.Objects.equals(current.sourceUrl(), expected.sourceUrl()) && java.util.Objects.equals(current.chapterNumber(), expected.chapterNumber())
            && current.pageCount() == expected.pageCount() && current.expectedPageCount() == expected.expectedPageCount()
            && current.ingestedPageCount() == expected.ingestedPageCount() && Boolean.TRUE.equals(current.segmentsReady())
            && java.util.Objects.equals(current.sourcePageCount(), expected.sourcePageCount())
            && java.util.Objects.equals(current.expectedSegmentCount(), expected.expectedSegmentCount())
            && java.util.Objects.equals(current.ingestedSegmentCount(), expected.ingestedSegmentCount())
            && current.ingestRevision().equals(expected.ingestRevision()) && current.ingestManifestPath().equals(expected.ingestManifestPath())
            && current.available() && "ready".equals(current.ingestStatus()) && "clean".equals(current.qualityStatus()) && current.missingPageCount() == 0;
    }
    private Path canonicalRoot(LibraryTitle title) throws IOException {
        Path root = Path.of(title.downloadRoot()).toAbsolutePath().normalize(), managed = downloads.resolve("downloaded");
        if (!root.startsWith(managed) || root.equals(managed) || !Files.isDirectory(root) || Files.isSymbolicLink(root)
            || !root.toRealPath().startsWith(managed.toRealPath())) throw new IOException("Canonical repair root is invalid.");
        return root;
    }
    private static Path scopedCanonical(Path path, Path root) throws IOException {
        Path normalized = path.toAbsolutePath().normalize();
        if (!normalized.startsWith(root) || normalized.equals(root) || Files.isSymbolicLink(normalized)
            || !normalized.getParent().toRealPath().startsWith(root.toRealPath())) throw new IOException("Canonical archive escaped its title scope.");
        return normalized;
    }
    private static JsonNode read(Path file) throws IOException {
        if (Files.isSymbolicLink(file) || !Files.isRegularFile(file) || Files.size(file) > 1048576) throw new IOException("Repair journal is unavailable.");
        return JSON.readTree(file.toFile());
    }
    private static void write(Path file, Object state) throws IOException {
        Path temp = Files.createTempFile(file.getParent(), "publication-", ".tmp");
        try { JSON.writeValue(temp.toFile(), state); move(temp, file); } finally { Files.deleteIfExists(temp); }
    }
    private static void move(Path source, Path target) throws IOException {
        try { Files.move(source, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
        catch (java.nio.file.AtomicMoveNotSupportedException unsupported) { Files.move(source, target, StandardCopyOption.REPLACE_EXISTING); }
    }
}
