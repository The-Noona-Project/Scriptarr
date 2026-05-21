package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.settings.RavenNamingSettings;
import com.scriptarr.raven.settings.RavenSettingsService;
import com.scriptarr.raven.support.ScriptarrLogger;
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
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Converts canonical CBZ chapters into reader-ready WebP page folders.
 */
@Service
public final class LibraryIngestService {
    static final String INGESTED_FOLDER_NAME = "ingested";
    static final String INGEST_STAGING_FOLDER_NAME = ".ingest-staging";
    private static final int WEBP_QUALITY = 92;
    private static final int NVIDIA_PROBE_TIMEOUT_SECONDS = 3;

    private final RavenSettingsService settingsService;
    private final ScriptarrLogger logger;
    private final WebpTranscoder transcoder;
    private final ObjectMapper objectMapper = new ObjectMapper();

    /**
     * Create the shared WebP ingest service.
     *
     * @param settingsService Raven settings service
     * @param logger Raven logger and data-root owner
     * @param transcoder WebP transcoder implementation
     */
    public LibraryIngestService(RavenSettingsService settingsService, ScriptarrLogger logger, WebpTranscoder transcoder) {
        this.settingsService = settingsService;
        this.logger = logger;
        this.transcoder = transcoder;
    }

    /**
     * Convert a single canonical CBZ chapter into WebP pages and atomically
     * publish them under the ingested storage root.
     *
     * @param title library title owning the chapter
     * @param chapter chapter with a canonical CBZ archive path
     * @return successful ingest result
     */
    public LibraryIngestResult ingestChapter(LibraryTitle title, LibraryChapter chapter) {
        assertHardwareReady();
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
            List<PageManifestEntry> pages = transcodeArchivePages(title, archivePath, stageRoot);
            if (pages.isEmpty()) {
                throw new LibraryIngestException("empty_archive", "CBZ archive did not contain readable image pages.");
            }
            String revision = buildRevision(archivePath, pages.size());
            String ingestedAt = Instant.now().toString();
            Path manifestPath = stageRoot.resolve("manifest.json");
            writeManifest(manifestPath, title, chapter, archivePath, revision, ingestedAt, pages);
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
     * Read one ingested WebP page.
     *
     * @param chapter chapter with a ready manifest path
     * @param pageIndex zero-based page index
     * @return WebP page bytes or {@code null} when missing
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
        boolean required = requiresNvidiaRuntime();
        boolean present = !required || hasNvidiaRuntime();
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("profile", required ? "nvidia" : "cpu-webp");
        status.put("required", required);
        status.put("state", present ? "ready" : "hardware_missing");
        status.put("encoder", "cwebp/libwebp");
        return Map.copyOf(status);
    }

    private List<PageManifestEntry> transcodeArchivePages(LibraryTitle title, Path archivePath, Path stageRoot)
        throws IOException, InterruptedException {
        RavenNamingSettings namingSettings = settingsService.getNamingSettings();
        List<PageManifestEntry> pages = new ArrayList<>();
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
            for (int index = 0; index < entries.size(); index++) {
                ZipEntry entry = entries.get(index);
                String slug = String.format(Locale.ROOT, "p%06d.webp", index + 1);
                Path outputPath = stageRoot.resolve(slug);
                try (InputStream stream = zipFile.getInputStream(entry)) {
                    transcoder.transcode(stream.readAllBytes(), mediaTypeForArchiveEntry(entry.getName()), outputPath, WEBP_QUALITY);
                }
                pages.add(new PageManifestEntry(index, slug, Files.size(outputPath)));
            }
        }
        return pages;
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
        manifest.put("encoder", "cwebp/libwebp");
        manifest.put("quality", WEBP_QUALITY);
        manifest.put("revision", revision);
        manifest.put("ingestedAt", ingestedAt);
        manifest.put("pageCount", pages.size());
        manifest.put("pages", pages.stream().map((page) -> Map.of(
            "index", page.index(),
            "slug", page.slug(),
            "mediaType", "image/webp",
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
        return chapterRoot.resolve(String.format(Locale.ROOT, "p%06d.webp", pageIndex + 1));
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
        if ("hardware_missing".equals(status.get("state"))) {
            throw new LibraryIngestException("hardware_missing", "NVIDIA runtime access is not available for Raven ingest.");
        }
    }

    private boolean requiresNvidiaRuntime() {
        String require = Optional.ofNullable(System.getenv("SCRIPTARR_RAVEN_INGEST_REQUIRE_NVIDIA")).orElse("");
        if (List.of("1", "true", "yes", "on").contains(require.trim().toLowerCase(Locale.ROOT))) {
            return true;
        }
        String profile = firstNonBlank(
            System.getenv("SCRIPTARR_RAVEN_INGEST_GPU_PROFILE"),
            System.getenv("SCRIPTARR_GPU_HINT")
        );
        return "nvidia".equals(profile.trim().toLowerCase(Locale.ROOT));
    }

    private boolean hasNvidiaRuntime() {
        if (Files.exists(Path.of("/dev/nvidiactl")) || Files.exists(Path.of("/proc/driver/nvidia/version"))) {
            return true;
        }
        try {
            Process process = new ProcessBuilder("nvidia-smi", "-L")
                .redirectErrorStream(true)
                .start();
            if (!process.waitFor(NVIDIA_PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                return false;
            }
            return process.exitValue() == 0;
        } catch (Exception ignored) {
            return false;
        }
    }

    private String buildRevision(Path archivePath, int pageCount) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        digest.update(archivePath.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        digest.update(Long.toString(Files.size(archivePath)).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        digest.update(Long.toString(Files.getLastModifiedTime(archivePath).toMillis()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        digest.update(Integer.toString(pageCount).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        digest.update(Integer.toString(WEBP_QUALITY).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return HexFormat.of().formatHex(digest.digest()).substring(0, 16);
    }

    private boolean isImageEntry(String name) {
        String normalized = Optional.ofNullable(name).orElse("").toLowerCase(Locale.ROOT);
        return normalized.endsWith(".jpg")
            || normalized.endsWith(".jpeg")
            || normalized.endsWith(".png")
            || normalized.endsWith(".gif")
            || normalized.endsWith(".webp");
    }

    private String mediaTypeForArchiveEntry(String name) {
        String normalized = Optional.ofNullable(name).orElse("").toLowerCase(Locale.ROOT);
        if (normalized.endsWith(".png")) {
            return "image/png";
        }
        if (normalized.endsWith(".webp")) {
            return "image/webp";
        }
        if (normalized.endsWith(".gif")) {
            return "image/gif";
        }
        return "image/jpeg";
    }

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
