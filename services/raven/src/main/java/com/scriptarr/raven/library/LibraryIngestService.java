package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.settings.RavenNamingSettings;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.ScriptarrLogger;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Converts canonical CBZ chapters into reader-ready AVIF page folders.
 */
@Service
public final class LibraryIngestService {
    static final String INGESTED_FOLDER_NAME = "ingested";
    static final String INGEST_STAGING_FOLDER_NAME = ".ingest-staging";
    private static final int AVIF_QUALITY = 50;
    private static final int DEFAULT_PAGE_CONCURRENCY = 4;
    private static final int MAX_PAGE_CONCURRENCY = 8;
    private static final int DEFAULT_ENCODER_SLOTS = 6;
    private static final int MAX_ENCODER_SLOTS = 8;

    private final RavenSettingsService settingsService;
    private final ScriptarrLogger logger;
    private final PageTranscoder transcoder;
    private final int pageConcurrency;
    private final int encoderSlots;
    private final ExecutorService pageExecutor;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private RemoteChapterProcessor remote;

    /**
     * Create the shared derived-page ingest service.
     *
     * @param settingsService Raven settings service
     * @param logger Raven logger and data-root owner
     * @param transcoder page transcoder implementation
     */
    public LibraryIngestService(RavenSettingsService settingsService, ScriptarrLogger logger, PageTranscoder transcoder) {
        this(settingsService, logger, transcoder, resolveConfiguredPageConcurrency(), resolveConfiguredEncoderSlots());
    }

    /**
     * Configure the coordinator's remote-only processing path while preserving local test construction.
     * @param settingsService naming settings
     * @param logger canonical data-root owner
     * @param transcoder legacy local encoder for compatibility reads and isolated tests
     * @param remote fenced WebP chapter processor
     */
    @Autowired
    public LibraryIngestService(RavenSettingsService settingsService, ScriptarrLogger logger, PageTranscoder transcoder, RemoteChapterProcessor remote) {
        this(settingsService, logger, transcoder); this.remote = remote;
    }

    /**
     * Create the shared derived-page ingest service with an explicit page
     * worker count for tests and controlled runtime construction.
     *
     * @param settingsService Raven settings service
     * @param logger Raven logger and data-root owner
     * @param transcoder page transcoder implementation
     * @param pageConcurrency maximum per-chapter page transcodes
     */
    LibraryIngestService(RavenSettingsService settingsService, ScriptarrLogger logger, PageTranscoder transcoder, int pageConcurrency) {
        this(settingsService, logger, transcoder, pageConcurrency, resolveConfiguredEncoderSlots());
    }

    private LibraryIngestService(
        RavenSettingsService settingsService,
        ScriptarrLogger logger,
        PageTranscoder transcoder,
        int pageConcurrency,
        int encoderSlots
    ) {
        this.settingsService = settingsService;
        this.logger = logger;
        this.transcoder = transcoder;
        this.pageConcurrency = Math.max(1, Math.min(MAX_PAGE_CONCURRENCY, pageConcurrency));
        this.encoderSlots = Math.max(1, Math.min(MAX_ENCODER_SLOTS, encoderSlots));
        this.pageExecutor = Executors.newFixedThreadPool(this.encoderSlots, new PageWorkerThreadFactory());
    }

    /**
     * Convert a single canonical CBZ chapter into AVIF pages and atomically
     * publish them under the ingested storage root.
     *
     * @param title library title owning the chapter
     * @param chapter chapter with a canonical CBZ archive path
     * @return successful ingest result
     */
    public LibraryIngestResult ingestChapter(LibraryTitle title, LibraryChapter chapter) {
        return ingestChapter(title, chapter, () -> false);
    }

    /**
     * Convert a single canonical CBZ chapter into AVIF pages with cooperative
     * cancellation between extraction, transcode, and publish checkpoints.
     *
     * @param title library title owning the chapter
     * @param chapter chapter with a canonical CBZ archive path
     * @param cancelled cancellation predicate
     * @return successful ingest result
     */
    public LibraryIngestResult ingestChapter(LibraryTitle title, LibraryChapter chapter, BooleanSupplier cancelled) {
        return ingestChapter(title, chapter, cancelled, progress -> { });
    }

    /**
     * Convert a chapter while reporting actual page completion and encoder waits.
     *
     * @param title owning title
     * @param chapter source chapter
     * @param cancelled cancellation predicate
     * @param progress actual ingest progress callback
     * @return ready reader-page result
     */
    public LibraryIngestResult ingestChapter(LibraryTitle title, LibraryChapter chapter, BooleanSupplier cancelled,
        Consumer<IngestProgress> progress) {
        if (remote != null && remote.required()) return ingestRemoteChapter(title, chapter, cancelled, progress);
        assertHardwareReady();
        throwIfCancelled(cancelled);
        Path archivePath = resolveArchivePath(chapter);
        Path dataRoot = resolveDataRoot();
        Path finalRoot = dataRoot
            .resolve(INGESTED_FOLDER_NAME)
            .resolve(safeSegment(title.libraryTypeSlug(), "manga"))
            .resolve(safeSegment(title.id(), "title"))
            .resolve(safeSegment(chapter.id(), "chapter"));
        Path stageRoot = dataRoot
            .resolve(INGEST_STAGING_FOLDER_NAME)
            .resolve(safeSegment(title.id(), "title"))
            .resolve(safeSegment(chapter.id(), "chapter") + "-" + System.nanoTime());

        try {
            Files.createDirectories(stageRoot);
            List<PageManifestEntry> pages = transcodeArchivePages(title, archivePath, stageRoot, cancelled == null ? () -> false : cancelled, progress == null ? value -> { } : progress);
            if (pages.isEmpty()) {
                throw new LibraryIngestException("empty_archive", "CBZ archive did not contain readable image pages.");
            }
            throwIfCancelled(cancelled);
            String revision = buildRevision(archivePath, pages.size());
            String ingestedAt = Instant.now().toString();
            Path manifestPath = stageRoot.resolve("manifest.json");
            writeManifest(manifestPath, title, chapter, archivePath, revision, ingestedAt, pages);
            throwIfCancelled(cancelled);
            publishStage(stageRoot, finalRoot);
            return new LibraryIngestResult(
                "ready",
                revision,
                pages.size(),
                ingestedAt,
                finalRoot.resolve("manifest.json").toString(),
                pages.stream().map(PageManifestEntry::slug).toList()
            );
        } catch (LibraryIngestException error) {
            deleteTreeQuietly(stageRoot);
            throw error;
        } catch (Exception error) {
            deleteTreeQuietly(stageRoot);
            throw new LibraryIngestException("ingest_failed", sanitizeError(error.getMessage()));
        }
    }

    /**
     * Stop the shared AVIF page worker pool on Spring shutdown.
     */
    @PreDestroy
    public void shutdown() {
        pageExecutor.shutdownNow();
    }

    /**
     * Read one ingested reader page.
     *
     * @param chapter chapter with a ready manifest path
     * @param pageIndex zero-based page index
     * @return page bytes or {@code null} when missing
     * @throws IOException when page bytes cannot be read
     */
    public byte[] readIngestedPage(LibraryChapter chapter, int pageIndex) throws IOException {
        Path pagePath = ingestedPagePath(chapter, pageIndex);
        if (pagePath == null || !Files.exists(pagePath) || Files.size(pagePath) <= 0L) {
            return null;
        }
        return Files.readAllBytes(pagePath);
    }

    /**
     * Resolve Raven ingest hardware status without making overall health fail.
     *
     * @return hardware status payload
     */
    public Map<String, Object> hardwareStatus() {
        if (remote != null && remote.required()) return Map.of("profile", "remote-webp", "required", false, "state", "ready",
            "encoder", "worker/ffmpeg-libwebp", "format", "webp", "mediaType", "image/webp", "pageConcurrency", 1, "encoderSlots", 1,
            "message", "Conversion waits for an assigned remote worker; Plex never encodes locally.");
        PageTranscoder.Readiness encoder = transcoder.readiness();
        boolean required = transcoder.requiresNvidiaRuntime();
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("profile", transcoder.runtimeProfile());
        status.put("required", required);
        status.put("state", encoder.ready() ? "ready" : required ? "hardware_missing" : encoder.code());
        status.put("encoder", transcoder.encoderName());
        status.put("format", transcoder.format());
        status.put("mediaType", transcoder.mediaType());
        status.put("pageConcurrency", pageConcurrency);
        status.put("encoderSlots", encoderSlots);
        status.put("message", encoder.message());
        return Map.copyOf(status);
    }

    /**
     * Return the media type served for ingested reader pages.
     *
     * @return reader page media type
     */
    public String readerPageMediaType() {
        if (remote != null && remote.required()) return "image/webp";
        return transcoder.mediaType();
    }

    /**
     * Return the current revision prefix used by reader-page ingest output.
     *
     * @return ingest revision prefix
     */
    public String readerPageRevisionPrefix() {
        if (remote != null && remote.required()) return "webp-";
        return transcoder.format() + "-";
    }

    /**
     * Wait for validated WebP output, then publish one immutable revision without replacing older ready files.
     * @param title owning title
     * @param chapter source chapter
     * @param cancelled owner cancellation
     * @param progress logical-page progress
     * @return fenced result awaiting atomic catalog checkpoint
     */
    private LibraryIngestResult ingestRemoteChapter(LibraryTitle title, LibraryChapter chapter, BooleanSupplier cancelled, Consumer<IngestProgress> progress) {
        Path stage = null;
        try {
            throwIfCancelled(cancelled); Path archive = resolveArchivePath(chapter);
            RemoteChapterProcessor.Result result = remote.convert(title, chapter, archive, settingsService.getNamingSettings(), cancelled, progress);
            var bundle = result.bundle(); int count = bundle.path("pageCount").asInt();
            int version = bundle.path("profile").path("segmentationVersion").asInt();
            String revision = DerivedPageManifest.revision(archive, count, "webp", bundle.path("encoder").asText(), 85, version);
            Path chapterRoot = resolveDataRoot().resolve(INGESTED_FOLDER_NAME).resolve(safeSegment(title.libraryTypeSlug(), "manga"))
                .resolve(safeSegment(title.id(), "title")).resolve(safeSegment(chapter.id(), "chapter"));
            Path destination = chapterRoot.resolve(revision), manifest = destination.resolve("manifest.json");
            String ingestedAt;
            if (Files.isSymbolicLink(destination) || Files.isSymbolicLink(manifest)) throw new IOException("Immutable reader publication must not follow a link.");
            if (Files.isRegularFile(manifest)) {
                var saved = objectMapper.readTree(manifest.toFile());
                if (!result.jobId().equals(saved.path("conversionJobId").asText()) || !revision.equals(saved.path("revision").asText())
                    || !saved.path("pages").equals(bundle.path("pages")) || !saved.path("profile").equals(bundle.path("profile"))) throw new IOException("Immutable output revision has different content or profile.");
                ingestedAt = saved.path("ingestedAt").asText();
                try (var files = Files.list(result.directory())) {
                    for (Path file : files.filter(p -> p.getFileName().toString().endsWith(".webp")).toList()) {
                        Path target = destination.resolve(file.getFileName());
                        if (!Files.isRegularFile(target) || !WebpChapterEncoder.sha256(target).equals(WebpChapterEncoder.sha256(file))) {
                            if (Files.isSymbolicLink(target)) throw new IOException("Immutable output target must not be a link.");
                            Path repair = Files.createTempFile(destination, "repair-", ".tmp");
                            try { Files.copy(file, repair, StandardCopyOption.REPLACE_EXISTING); Files.move(repair, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
                            finally { Files.deleteIfExists(repair); }
                        }
                    }
                }
            } else {
                stage = resolveDataRoot().resolve(INGEST_STAGING_FOLDER_NAME).resolve(safeSegment(title.id(), "title"))
                    .resolve(safeSegment(chapter.id(), "chapter") + "-" + result.epoch() + "-" + System.nanoTime());
                Files.createDirectories(stage);
                try (var files = Files.list(result.directory())) { for (Path file : files.filter(p -> p.getFileName().toString().endsWith(".webp")).toList()) Files.copy(file, stage.resolve(file.getFileName())); }
                ingestedAt = publicationTimestamp(result, chapter, archive, revision, manifest, count); Map<String, Object> metadata = objectMapper.convertValue(bundle, new com.fasterxml.jackson.core.type.TypeReference<>() { });
                metadata.putAll(Map.of("titleId", title.id(), "chapterId", chapter.id(), "libraryTypeSlug", title.libraryTypeSlug(), "sourceArchivePath", archive.toString(),
                    "quality", 85, "method", 4, "segmentationVersion", version, "revision", revision, "ingestedAt", ingestedAt));
                metadata.put("conversionJobId", result.jobId()); metadata.put("conversionEpoch", result.epoch()); metadata.put("artifactSha256", result.artifactSha256());
                metadata.put("derivedFileCount", bundle.path("pages").findValues("segments").stream().mapToInt(com.fasterxml.jackson.databind.JsonNode::size).sum());
                objectMapper.writerWithDefaultPrettyPrinter().writeValue(stage.resolve("manifest.json").toFile(), metadata);
                throwIfCancelled(cancelled); Files.createDirectories(chapterRoot);
                if (Files.exists(destination, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                    ImmutableManifestRecovery.restore(stage, destination, resolveDataRoot().resolve(INGESTED_FOLDER_NAME), cancelled);
                } else {
                    try { Files.move(stage, destination, StandardCopyOption.ATOMIC_MOVE); }
                    catch (java.nio.file.AtomicMoveNotSupportedException unsupported) { Files.move(stage, destination); }
                    stage = null;
                }
            }
            return new LibraryIngestResult("ready", revision, count, ingestedAt, manifest.toString(), List.of(), result.jobId(), result.epoch(), result.artifactSha256());
        } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new LibraryIngestException("ingest_cancelled", "Reader processing was cancelled."); }
        catch (Exception failure) { throw new LibraryIngestException("remote_ingest_failed", "Remote reader processing could not be committed: " + sanitizeError(failure.getMessage())); }
        finally { deleteTreeQuietly(stage); }
    }

    /** @param result accepted immutable output and optional original completed receipt @param chapter owning checkpoint @param archive validated canonical source @param revision derived content identity @param manifest exact destination @param count logical pages @return original completed timestamp or a new unpublished timestamp @throws IOException when completed identity differs */
    private String publicationTimestamp(RemoteChapterProcessor.Result result, LibraryChapter chapter, Path archive, String revision, Path manifest, int count) throws IOException {
        var original = result.completedChapter();
        if (original == null) return Instant.now().toString();
        int segments = 0; for (var page : result.bundle().path("pages")) segments += page.path("segments").size();
        if (!chapter.id().equals(original.path("id").asText()) || !"ready".equals(original.path("ingestStatus").asText())
            || !revision.equals(original.path("ingestRevision").asText()) || !original.path("available").asBoolean()
            || original.path("pageCount").asInt() != count || original.path("sourcePageCount").asInt() != count || original.path("ingestedPageCount").asInt() != count
            || original.path("expectedSegmentCount").asInt() != segments || original.path("ingestedSegmentCount").asInt() != segments || !original.path("segmentsReady").asBoolean()
            || !archive.toAbsolutePath().normalize().equals(Path.of(original.path("archivePath").asText()).toAbsolutePath().normalize())
            || !manifest.toAbsolutePath().normalize().equals(Path.of(original.path("ingestManifestPath").asText()).toAbsolutePath().normalize())) throw new IOException("Original completion does not match the immutable reader revision.");
        String saved = original.path("ingestedAt").asText();
        try { Instant.parse(saved); }
        catch (java.time.format.DateTimeParseException invalid) { throw new IOException("Original completion timestamp is unavailable."); }
        return saved;
    }

    /**
     * Checkpoint remote output and its job atomically under the current conversion epoch.
     * @param titleId owning title
     * @param chapter final chapter state
     * @param result accepted worker result
     * @return fenced catalog acknowledgement
     */
    public LibraryChapter commitRemoteChapter(String titleId, LibraryChapter chapter, LibraryIngestResult result) {
        try {
            if (remote == null || result.conversionJobId().isBlank()) throw new IOException("Remote conversion receipt is unavailable.");
            return remote.complete(new RemoteChapterProcessor.Result(result.conversionJobId(), result.conversionEpoch(), result.artifactSha256(), null, null), chapter);
        } catch (Exception failure) { throw new IllegalStateException("Could not commit the fenced reader chapter.", failure); }
    }

    /** @param chapter saved chapter @param pageIndex logical index @param segment segment selector @param thumbnail full-page thumbnail selector @return saved page bytes @throws IOException when unavailable */
    public byte[] readIngestedPage(LibraryChapter chapter, int pageIndex, Integer segment, boolean thumbnail) throws IOException {
        return Files.readAllBytes(DerivedPageManifest.page(chapter, pageIndex, segment, thumbnail));
    }

    /** @param chapter saved chapter @return the saved format's MIME, independently of the new output backend */
    public String readerPageMediaType(LibraryChapter chapter) { return chapter != null && chapter.ingestRevision() != null && chapter.ingestRevision().startsWith("webp-") ? "image/webp" : "image/avif"; }

    /** @return actual active or queued page work, including cancelled work still winding down */
    public long activePageWork() { return pageExecutor instanceof java.util.concurrent.ThreadPoolExecutor pool ? pool.getActiveCount() + pool.getQueue().size() : 0; }

    /** @return whether publication is protected by the remote conversion broker */
    public boolean remoteRequired() { return remote != null && remote.required(); }

    private List<PageManifestEntry> transcodeArchivePages(
        LibraryTitle title,
        Path archivePath,
        Path stageRoot,
        BooleanSupplier cancelled,
        Consumer<IngestProgress> progress
    )
        throws IOException, InterruptedException {
        RavenNamingSettings namingSettings = settingsService.getNamingSettings();
        Path sourceRoot = stageRoot.resolve(".source");
        List<Future<PageManifestEntry>> futures = new ArrayList<>();
        try (ZipFile zipFile = new ZipFile(archivePath.toFile())) {
            List<? extends ZipEntry> entries = zipFile.stream()
                .filter((entry) -> !entry.isDirectory())
                .filter((entry) -> isImageEntry(entry.getName()))
                .sorted(Comparator
                    .comparingInt((ZipEntry entry) -> LibraryNaming.extractPageOrder(
                        entry.getName(),
                        namingSettings,
                        title == null ? "manga" : title.libraryTypeSlug()
                    ))
                    .thenComparing(ZipEntry::getName))
                .toList();
            Files.createDirectories(sourceRoot);
            List<PageManifestEntry> pages = new ArrayList<>();
            int collected = 0;
            progress.accept(new IngestProgress("waiting-for-encoder", 0, entries.size(), 0, 1, false));
            for (int index = 0; index < entries.size(); index++) {
                throwIfCancelled(cancelled);
                ZipEntry entry = entries.get(index);
                String slug = String.format(Locale.ROOT, "p%06d%s", index + 1, transcoder.fileExtension());
                Path outputPath = stageRoot.resolve(slug);
                String mediaType = mediaTypeForArchiveEntry(entry.getName());
                Path sourcePath = sourceRoot.resolve(String.format(Locale.ROOT, "source-p%06d%s", index + 1, sourceExtensionForArchiveEntry(entry.getName())));
                try (InputStream stream = zipFile.getInputStream(entry)) {
                    Files.copy(stream, sourcePath, StandardCopyOption.REPLACE_EXISTING);
                }
                progress.accept(new IngestProgress("waiting-for-encoder", collected, entries.size(), 0, 1, false));
                futures.add(submitPageTranscode(new PageTranscodeInput(index, slug, mediaType, sourcePath, outputPath), cancelled));
                while (futures.size() - collected >= pageConcurrency) {
                    pages.add(readPageFuture(futures.get(collected), cancelled));
                    collected += 1;
                    progress.accept(new IngestProgress("ingesting", collected, entries.size(), 0, 1, true));
                }
            }
            while (collected < futures.size()) {
                pages.add(readPageFuture(futures.get(collected), cancelled));
                collected += 1;
                progress.accept(new IngestProgress("ingesting", collected, entries.size(), 0, 1, true));
            }
            pages.sort(Comparator.comparingInt(PageManifestEntry::index));
            return pages;
        } catch (InterruptedException error) {
            cancelAll(futures);
            Thread.currentThread().interrupt();
            throw error;
        } catch (IOException | LibraryIngestException error) {
            cancelAll(futures);
            throw error;
        } finally {
            deleteTreeQuietly(sourceRoot);
        }
    }

    private Future<PageManifestEntry> submitPageTranscode(PageTranscodeInput input, BooleanSupplier cancelled) {
        Callable<PageManifestEntry> task = () -> {
            try {
                throwIfCancelled(cancelled);
                return transcodeOnePage(input, cancelled);
            } finally {
                Files.deleteIfExists(input.sourcePath());
            }
        };
        return pageExecutor.submit(task);
    }

    private PageManifestEntry readPageFuture(Future<PageManifestEntry> future, BooleanSupplier cancelled) throws IOException, InterruptedException {
        try {
            while (true) {
                throwIfCancelled(cancelled);
                try {
                    return future.get(200, TimeUnit.MILLISECONDS);
                } catch (TimeoutException pending) {
                    // Recheck admin cancellation while a bounded encoder is running.
                }
            }
        } catch (InterruptedException error) {
            future.cancel(true);
            Thread.currentThread().interrupt();
            throw error;
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof IOException ioError) {
                throw ioError;
            }
            if (cause instanceof InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw interrupted;
            }
            if (cause instanceof LibraryIngestException ingestError) {
                throw ingestError;
            }
            throw new IOException(firstNonBlank(cause == null ? "" : cause.getMessage(), "AVIF page conversion failed."), cause);
        }
    }

    private PageManifestEntry transcodeOnePage(PageTranscodeInput input, BooleanSupplier cancelled) throws IOException, InterruptedException {
        throwIfCancelled(cancelled);
        transcoder.transcodeFile(input.sourcePath(), input.mediaType(), input.outputPath(), AVIF_QUALITY);
        throwIfCancelled(cancelled);
        return new PageManifestEntry(input.index(), input.slug(), Files.size(input.outputPath()));
    }

    private void cancelAll(List<Future<PageManifestEntry>> futures) {
        futures.forEach((future) -> future.cancel(true));
    }

    /**
     * Determine whether a ready chapter still matches its source archive and
     * saved AVIF settings, including after the active backend changes.
     *
     * @param chapter chapter to inspect
     * @return true when the existing derived pages match the current archive
     */
    public boolean canReuseReadyChapter(LibraryChapter chapter) {
        return DerivedPageManifest.reusable(chapter);
    }

    /**
     * Keep the original verifier for compatibility comparisons while saved-format reads use the shared validator.
     * @param chapter saved chapter
     * @return whether the legacy current-backend contract matches
     */
    private boolean legacyCanReuseReadyChapter(LibraryChapter chapter) {
        if (chapter == null
            || !"ready".equals(Optional.ofNullable(chapter.ingestStatus()).orElse("").toLowerCase(Locale.ROOT))
            || chapter.ingestRevision() == null
            || chapter.ingestRevision().isBlank()
            || chapter.ingestManifestPath() == null
            || chapter.ingestManifestPath().isBlank()
            || chapter.ingestedPageCount() <= 0) {
            return false;
        }
        try {
            Path archivePath = resolveArchivePath(chapter);
            int pageCount = countArchivePages(archivePath);
            if (pageCount <= 0 || pageCount != chapter.ingestedPageCount()) {
                return false;
            }
            Path manifestPath = Path.of(chapter.ingestManifestPath());
            if (!Files.exists(manifestPath) || Files.size(manifestPath) <= 0L) {
                return false;
            }
            var manifest = objectMapper.readTree(manifestPath.toFile());
            String storedEncoder = manifest.path("encoder").asText("");
            if (!transcoder.format().equals(manifest.path("format").asText())
                || !transcoder.mediaType().equals(manifest.path("mediaType").asText())
                || storedEncoder.isBlank()
                || manifest.path("quality").asInt() != AVIF_QUALITY
                || !chapter.ingestRevision().equals(manifest.path("revision").asText())
                || !buildRevision(archivePath, pageCount, storedEncoder).equals(chapter.ingestRevision())) {
                return false;
            }
            Path chapterRoot = manifestPath.getParent();
            if (chapterRoot == null) {
                return false;
            }
            for (int index = 0; index < pageCount; index++) {
                Path pagePath = chapterRoot.resolve(String.format(Locale.ROOT, "p%06d%s", index + 1, transcoder.fileExtension()));
                if (!Files.exists(pagePath) || Files.size(pagePath) <= 0L) {
                    return false;
                }
            }
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void writeManifest(
        Path manifestPath,
        LibraryTitle title,
        LibraryChapter chapter,
        Path archivePath,
        String revision,
        String ingestedAt,
        List<PageManifestEntry> pages
    ) throws IOException {
        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("schemaVersion", 1);
        manifest.put("titleId", title.id());
        manifest.put("chapterId", chapter.id());
        manifest.put("libraryTypeSlug", title.libraryTypeSlug());
        manifest.put("sourceArchivePath", archivePath.toString());
        manifest.put("encoder", transcoder.encoderName());
        manifest.put("format", transcoder.format());
        manifest.put("mediaType", transcoder.mediaType());
        manifest.put("quality", AVIF_QUALITY);
        manifest.put("revision", revision);
        manifest.put("ingestedAt", ingestedAt);
        manifest.put("pageCount", pages.size());
        manifest.put("pages", pages.stream().map((page) -> Map.of(
            "index", page.index(),
            "slug", page.slug(),
            "mediaType", transcoder.mediaType(),
            "sizeBytes", page.sizeBytes()
        )).toList());
        objectMapper.writerWithDefaultPrettyPrinter().writeValue(manifestPath.toFile(), manifest);
    }

    private void publishStage(Path stageRoot, Path finalRoot) throws IOException {
        Files.createDirectories(finalRoot.getParent());
        if (Files.exists(finalRoot)) {
            deleteTree(finalRoot);
        }
        try {
            Files.move(stageRoot, finalRoot, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException atomicMoveFailed) {
            Files.move(stageRoot, finalRoot, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private Path ingestedPagePath(LibraryChapter chapter, int pageIndex) {
        try { return DerivedPageManifest.page(chapter, pageIndex, null, false); }
        catch (IOException unavailable) { return null; }
    }

    /**
     * Resolve the original one-file layout for historical diagnostics.
     * @param chapter saved chapter
     * @param pageIndex logical page
     * @return legacy derived filename
     */
    private Path legacyIngestedPagePath(LibraryChapter chapter, int pageIndex) {
        if (chapter == null || chapter.ingestManifestPath() == null || chapter.ingestManifestPath().isBlank()) {
            return null;
        }
        if (pageIndex < 0 || pageIndex >= Math.max(0, chapter.ingestedPageCount())) {
            return null;
        }
        Path manifestPath = Path.of(chapter.ingestManifestPath());
        Path chapterRoot = manifestPath.getParent();
        if (chapterRoot == null) {
            return null;
        }
        return chapterRoot.resolve(String.format(Locale.ROOT, "p%06d%s", pageIndex + 1, transcoder.fileExtension()));
    }

    private Path resolveArchivePath(LibraryChapter chapter) {
        if (chapter == null || chapter.archivePath() == null || chapter.archivePath().isBlank()) {
            throw new LibraryIngestException("archive_missing", "Chapter does not have a canonical CBZ archive.");
        }
        Path archivePath = Path.of(chapter.archivePath()).toAbsolutePath().normalize();
        if (!Files.exists(archivePath)) {
            throw new LibraryIngestException("archive_missing", "Canonical CBZ archive is missing.");
        }
        return archivePath;
    }

    private Path resolveDataRoot() {
        Path root = logger.getDownloadsRoot();
        return root == null ? Path.of("/downloads") : root.toAbsolutePath().normalize();
    }

    private void assertHardwareReady() {
        Map<String, Object> status = hardwareStatus();
        if (!"ready".equals(status.get("state"))) {
            String code = firstNonBlank(String.valueOf(status.get("state")), "encoder_unavailable");
            String message = firstNonBlank(String.valueOf(status.get("message")), "Raven AVIF encoder is not available.");
            throw new LibraryIngestException(code, message);
        }
    }

    private void throwIfCancelled(BooleanSupplier cancelled) {
        if (cancelled != null && cancelled.getAsBoolean()) {
            throw new LibraryIngestException("ingest_cancelled", "AVIF ingest cancelled by admin.");
        }
    }

    private String buildRevision(Path archivePath, int pageCount) throws Exception {
        return buildRevision(archivePath, pageCount, transcoder.encoderName());
    }

    private String buildRevision(Path archivePath, int pageCount, String encoderName) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        digest.update(archivePath.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        digest.update(Long.toString(Files.size(archivePath)).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        digest.update(Long.toString(Files.getLastModifiedTime(archivePath).toMillis()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        digest.update(Integer.toString(pageCount).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        digest.update(transcoder.format().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        digest.update(encoderName.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        digest.update(Integer.toString(AVIF_QUALITY).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return transcoder.format() + "-" + HexFormat.of().formatHex(digest.digest()).substring(0, 16);
    }

    private boolean isImageEntry(String name) { return ArchiveImageEntries.isImage(name); }

    private String mediaTypeForArchiveEntry(String name) {
        String normalized = Optional.ofNullable(name).orElse("").toLowerCase(Locale.ROOT);
        if (normalized.endsWith(".png")) {
            return "image/png";
        }
        if (normalized.endsWith(".webp")) {
            return "image/webp";
        }
        if (normalized.endsWith(".avif")) {
            return "image/avif";
        }
        if (normalized.endsWith(".gif")) {
            return "image/gif";
        }
        return "image/jpeg";
    }

    private String sourceExtensionForArchiveEntry(String name) {
        String normalized = Optional.ofNullable(name).orElse("").toLowerCase(Locale.ROOT);
        if (normalized.endsWith(".png")) {
            return ".png";
        }
        if (normalized.endsWith(".webp")) {
            return ".webp";
        }
        if (normalized.endsWith(".avif")) {
            return ".avif";
        }
        if (normalized.endsWith(".gif")) {
            return ".gif";
        }
        if (normalized.endsWith(".jpeg")) {
            return ".jpeg";
        }
        return ".jpg";
    }

    private int countArchivePages(Path archivePath) throws IOException { return ArchiveImageEntries.count(archivePath); }

    private String safeSegment(String value, String fallback) {
        String segment = LibraryNaming.slugifySegment(firstNonBlank(value, fallback));
        return segment.isBlank() ? fallback : segment;
    }

    private String sanitizeError(String value) {
        String normalized = Optional.ofNullable(value).orElse("Raven ingest failed.").replaceAll("[\\r\\n]+", " ").trim();
        return normalized.length() > 240 ? normalized.substring(0, 240) : normalized;
    }

    private String firstNonBlank(String primary, String fallback) {
        return primary != null && !primary.isBlank() ? primary : Optional.ofNullable(fallback).orElse("");
    }

    private static int resolveConfiguredPageConcurrency() {
        String raw = Optional.ofNullable(System.getenv("SCRIPTARR_RAVEN_AVIF_PAGE_CONCURRENCY"))
            .filter((value) -> !value.isBlank())
            .orElseGet(() -> Optional.ofNullable(System.getenv("SCRIPTARR_RAVEN_INGEST_PAGE_CONCURRENCY")).orElse(""));
        try {
            return raw == null || raw.isBlank() ? DEFAULT_PAGE_CONCURRENCY : Integer.parseInt(raw.trim());
        } catch (NumberFormatException ignored) {
            return DEFAULT_PAGE_CONCURRENCY;
        }
    }

    private static int resolveConfiguredEncoderSlots() {
        String raw = Optional.ofNullable(System.getenv("SCRIPTARR_RAVEN_AVIF_ENCODER_SLOTS"))
            .filter((value) -> !value.isBlank())
            .orElseGet(() -> Optional.ofNullable(System.getenv("SCRIPTARR_RAVEN_INGEST_ENCODER_SLOTS")).orElse(""));
        try {
            return raw == null || raw.isBlank()
                ? DEFAULT_ENCODER_SLOTS
                : Math.max(1, Math.min(MAX_ENCODER_SLOTS, Integer.parseInt(raw.trim())));
        } catch (NumberFormatException ignored) {
            return DEFAULT_ENCODER_SLOTS;
        }
    }

    private record PageTranscodeInput(int index, String slug, String mediaType, Path sourcePath, Path outputPath) {
    }

    private static final class PageWorkerThreadFactory implements java.util.concurrent.ThreadFactory {
        private final AtomicInteger counter = new AtomicInteger(1);

        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "raven-avif-page-" + counter.getAndIncrement());
            thread.setDaemon(true);
            return thread;
        }
    }

    private void deleteTreeQuietly(Path root) {
        try {
            deleteTree(root);
        } catch (IOException ignored) {
        }
    }

    private void deleteTree(Path root) throws IOException {
        if (root == null || !Files.exists(root)) {
            return;
        }
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.deleteIfExists(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path dir, IOException exc) throws IOException {
                Files.deleteIfExists(dir);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private record PageManifestEntry(
        int index,
        String slug,
        long sizeBytes
    ) {
    }
}
