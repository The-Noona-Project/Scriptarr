package com.scriptarr.raven.library;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.downloader.TitleDetails;
import com.scriptarr.raven.settings.RavenVaultClient;
import com.scriptarr.raven.support.ScriptarrLogger;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Vault-backed Raven library projection and reader implementation.
 */
@Service
public final class LibraryService {
    private static final TypeReference<List<LibraryTitle>> TITLE_LIST_TYPE = new TypeReference<>() {
    };
    private static final TypeReference<List<LibraryChapter>> CHAPTER_LIST_TYPE = new TypeReference<>() {
    };

    private final RavenVaultClient vaultClient;
    private final ScriptarrLogger logger;
    private final ObjectMapper objectMapper = new ObjectMapper();

    /**
     * Create the shared Raven library service.
     *
     * @param vaultClient Vault client for durable catalog state
     * @param logger shared Raven logger
     */
    public LibraryService(RavenVaultClient vaultClient, ScriptarrLogger logger) {
        this.vaultClient = vaultClient;
        this.logger = logger;
    }

    /**
     * Scan the downloads root during startup so previously imported or
     * downloaded archives repopulate Raven's durable catalog.
     */
    @PostConstruct
    public void initializeCatalog() {
        try {
            rescanDownloadedFiles();
        } catch (Exception error) {
            logger.warn("LIBRARY", "Initial Raven library scan failed.", error.getMessage());
        }
    }

    /**
     * List every title currently exposed by Raven.
     *
     * @return immutable title list
     */
    public List<LibraryTitle> listTitles() {
        try {
            JsonNode payload = vaultClient.listLibraryTitles();
            if (payload == null || !payload.isArray()) {
                return List.of();
            }
            return objectMapper.convertValue(payload, TITLE_LIST_TYPE);
        } catch (Exception error) {
            logger.warn("LIBRARY", "Failed to list Raven titles.", error.getMessage());
            return List.of();
        }
    }

    /**
     * Find a single title by its stable Scriptarr id.
     *
     * @param id title id to resolve
     * @return matching title or {@code null} when it is unknown
     */
    public LibraryTitle findTitle(String id) {
        if (id == null || id.isBlank()) {
            return null;
        }

        try {
            JsonNode payload = vaultClient.getLibraryTitle(id);
            if (payload == null || payload.path("error").isTextual()) {
                return null;
            }
            return objectMapper.treeToValue(payload, LibraryTitle.class);
        } catch (Exception error) {
            logger.warn("LIBRARY", "Failed to load Raven title.", error.getMessage());
            return null;
        }
    }

    /**
     * Upsert a title summary into Raven's durable catalog.
     *
     * @param title title payload to store
     * @return updated title payload
     */
    public synchronized LibraryTitle upsertTitle(LibraryTitle title) {
        try {
            JsonNode payload = vaultClient.putLibraryTitle(title.id(), objectMapper.convertValue(title, new TypeReference<>() {
            }));
            return objectMapper.treeToValue(payload, LibraryTitle.class);
        } catch (Exception error) {
            logger.warn("LIBRARY", "Failed to persist Raven title.", error.getMessage());
            return title;
        }
    }

    /**
     * Replace a title's stored chapter list.
     *
     * @param titleId stable title id
     * @param chapters chapter payloads to persist
     * @return persisted chapters
     */
    public synchronized List<LibraryChapter> replaceChapters(String titleId, List<LibraryChapter> chapters) {
        try {
          JsonNode payload = vaultClient.putLibraryChapters(titleId, Map.of(
              "chapters", chapters
          ));
          if (payload == null || !payload.isArray()) {
              return chapters;
          }
          return objectMapper.convertValue(payload, CHAPTER_LIST_TYPE);
        } catch (Exception error) {
            logger.warn("LIBRARY", "Failed to persist Raven chapters.", error.getMessage());
            return chapters;
        }
    }

    /**
     * Persist the outcome of a downloaded chapter so Raven's library becomes
     * reader-usable without requiring a separate import pass.
     *
     * @param titleName human-readable title name
     * @param mediaType media type for the title
     * @param sourceUrl upstream source URL
     * @param coverUrl optional upstream cover URL
     * @param details scraped title details
     * @param chapter downloaded chapter payload
     * @param archivePath archive path on disk
     */
    public synchronized void recordDownloadedChapter(
        String titleName,
        String mediaType,
        String sourceUrl,
        String coverUrl,
        TitleDetails details,
        LibraryChapter chapter,
        Path archivePath
    ) {
        String titleId = slugifyTitleId(titleName);
        LibraryTitle existing = findTitle(titleId);
        List<LibraryChapter> nextChapters = new ArrayList<>(existing != null ? existing.chapters() : List.of());
        nextChapters.removeIf((entry) -> Objects.equals(entry.id(), chapter.id()));
        nextChapters.add(new LibraryChapter(
            chapter.id(),
            chapter.label(),
            chapter.chapterNumber(),
            chapter.pageCount(),
            chapter.releaseDate(),
            true,
            archivePath != null ? archivePath.toString() : chapter.archivePath(),
            chapter.sourceUrl()
        ));
        nextChapters.sort(Comparator.comparing((LibraryChapter entry) -> normalizeChapterNumber(entry.chapterNumber())).reversed());

        LibraryTitle nextTitle = new LibraryTitle(
            titleId,
            titleName,
            normalizeMediaType(mediaType),
            existing != null ? existing.status() : "active",
            resolveLatestChapter(nextChapters),
            existing != null ? existing.coverAccent() : resolveCoverAccent(titleId),
            firstNonBlank(existing != null ? existing.summary() : "", details != null ? details.summary() : ""),
            firstNonBlank(existing != null ? existing.releaseLabel() : "", details != null ? details.released() : ""),
            Math.max(nextChapters.size(), existing != null ? existing.chapterCount() : 0),
            nextChapters.size(),
            firstNonBlank(existing != null ? existing.author() : "", ""),
            existing != null ? existing.tags() : List.of(),
            mergeAliases(existing != null ? existing.aliases() : List.of(), details != null ? details.associatedNames() : List.of()),
            existing != null ? existing.metadataProvider() : "",
            existing != null ? existing.metadataMatchedAt() : null,
            details != null ? details.relatedSeries() : (existing != null ? existing.relations() : List.of()),
            firstNonBlank(existing != null ? existing.sourceUrl() : "", sourceUrl),
            firstNonBlank(existing != null ? existing.coverUrl() : "", coverUrl),
            archivePath != null && archivePath.getParent() != null ? archivePath.getParent().toString() : "",
            List.copyOf(nextChapters)
        );

        upsertTitle(nextTitle);
        replaceChapters(titleId, nextChapters);
    }

    /**
     * Apply selected metadata details to a stored Raven title.
     *
     * @param titleId stable title id
     * @param provider metadata provider id
     * @param matchedAt match timestamp
     * @param details metadata detail payload
     * @return updated Raven title
     */
    public synchronized LibraryTitle applyMetadata(String titleId, String provider, String matchedAt, Map<String, Object> details) {
        LibraryTitle existing = findTitle(titleId);
        if (existing == null) {
            return null;
        }

        LibraryTitle updated = new LibraryTitle(
            existing.id(),
            firstNonBlank(stringValue(details.get("title")), existing.title()),
            existing.mediaType(),
            existing.status(),
            existing.latestChapter(),
            existing.coverAccent(),
            firstNonBlank(stringValue(details.get("summary")), existing.summary()),
            firstNonBlank(stringValue(details.get("releaseLabel")), existing.releaseLabel()),
            existing.chapterCount(),
            existing.chaptersDownloaded(),
            firstNonBlank(stringValue(details.get("author")), existing.author()),
            existing.tags(),
            mergeAliases(existing.aliases(), objectMapper.convertValue(details.getOrDefault("aliases", List.of()), new TypeReference<List<String>>() {
            })),
            provider,
            matchedAt,
            objectMapper.convertValue(details.getOrDefault("relations", existing.relations()), new TypeReference<List<Map<String, String>>>() {
            }),
            existing.sourceUrl(),
            existing.coverUrl(),
            existing.downloadRoot(),
            existing.chapters()
        );
        upsertTitle(updated);
        return updated;
    }

    /**
     * Build the reader manifest for a title's available chapters.
     *
     * @param titleId title id to resolve
     * @return reader manifest or {@code null} when the title is unknown
     */
    public ReaderManifest readerManifest(String titleId) {
        LibraryTitle title = findTitle(titleId);
        if (title == null) {
            return null;
        }

        List<LibraryChapter> chapters = title.chapters().stream().filter(LibraryChapter::available).toList();
        return new ReaderManifest(title, chapters);
    }

    /**
     * Build the chapter payload used by Moon's native reader.
     *
     * @param titleId title id to resolve
     * @param chapterId chapter id to resolve
     * @return chapter payload or {@code null} when the title or chapter is unknown
     */
    public ReaderChapterPayload readerChapter(String titleId, String chapterId) {
        ReaderManifest manifest = readerManifest(titleId);
        if (manifest == null) {
            return null;
        }

        LibraryChapter chapter = manifest.chapters().stream().filter((entry) -> entry.id().equals(chapterId)).findFirst().orElse(null);
        if (chapter == null) {
            return null;
        }

        int chapterIndex = manifest.chapters().indexOf(chapter);
        int pageCount = resolvePageCount(chapter);
        List<ReaderPage> pages = java.util.stream.IntStream.range(0, pageCount)
            .mapToObj((index) -> new ReaderPage(index, "Page " + (index + 1), resolvePageMediaType(chapter, index)))
            .toList();

        String previousChapterId = chapterIndex > 0 ? manifest.chapters().get(chapterIndex - 1).id() : null;
        String nextChapterId = chapterIndex + 1 < manifest.chapters().size() ? manifest.chapters().get(chapterIndex + 1).id() : null;

        return new ReaderChapterPayload(manifest.title(), chapter, pages, previousChapterId, nextChapterId);
    }

    /**
     * Render a real archive-backed page when available, or Raven's SVG fallback
     * when the chapter has no imported art yet.
     *
     * @param titleId title id to resolve
     * @param chapterId chapter id to resolve
     * @param pageIndex zero-based page index to render
     * @return binary page payload or {@code null} when the page is unavailable
     */
    public RenderedPage renderReaderPage(String titleId, String chapterId, int pageIndex) {
        ReaderChapterPayload payload = readerChapter(titleId, chapterId);
        if (payload == null || pageIndex < 0 || pageIndex >= payload.pages().size()) {
            return null;
        }

        LibraryChapter chapter = payload.chapter();
        if (chapter.archivePath() != null && !chapter.archivePath().isBlank()) {
            try {
                byte[] bytes = readArchivePage(Path.of(chapter.archivePath()), pageIndex);
                if (bytes != null) {
                    return new RenderedPage(bytes, payload.pages().get(pageIndex).mediaType());
                }
            } catch (Exception error) {
                logger.warn("LIBRARY", "Failed to read archive-backed page.", error.getMessage());
            }
        }

        String svg = """
            <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1700" viewBox="0 0 1200 1700">
              <defs>
                <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
                  <stop offset="0%%" stop-color="%s"/>
                  <stop offset="100%%" stop-color="#11161c"/>
                </linearGradient>
              </defs>
              <rect width="1200" height="1700" fill="url(#bg)"/>
              <rect x="74" y="74" width="1052" height="1552" rx="34" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.18)"/>
              <text x="120" y="210" fill="rgba(255,255,255,0.72)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="34" letter-spacing="6">SCRIPTARR READER</text>
              <text x="120" y="340" fill="#ffffff" font-family="Space Grotesk, Arial, sans-serif" font-size="96" font-weight="700">%s</text>
              <text x="120" y="430" fill="rgba(255,255,255,0.86)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="44">%s</text>
              <text x="120" y="510" fill="rgba(255,255,255,0.64)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="32">Page %d of %d</text>
              <text x="120" y="650" fill="rgba(255,255,255,0.92)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="56" font-weight="700">Moon native reader fallback</text>
              <text x="120" y="740" fill="rgba(255,255,255,0.72)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="34">Raven could not find imported page art for this chapter yet, so it is rendering the reader fallback page.</text>
              <circle cx="960" cy="430" r="150" fill="rgba(255,255,255,0.08)" />
              <circle cx="960" cy="430" r="94" fill="rgba(255,255,255,0.18)" />
              <text x="960" y="450" text-anchor="middle" fill="#ffffff" font-family="Space Grotesk, Arial, sans-serif" font-size="88" font-weight="700">%d</text>
              <text x="120" y="1460" fill="rgba(255,255,255,0.46)" font-family="IBM Plex Sans, Arial, sans-serif" font-size="28">Generated at %s</text>
            </svg>
            """.formatted(
            payload.title().coverAccent(),
            escapeSvg(payload.title().title()),
            escapeSvg(payload.chapter().label()),
            pageIndex + 1,
            payload.pages().size(),
            pageIndex + 1,
            Instant.now().toString()
        );

        return new RenderedPage(svg.getBytes(StandardCharsets.UTF_8), "image/svg+xml");
    }

    /**
     * Rescan the downloads root and backfill any discovered CBZ files into
     * Raven's durable title and chapter catalog.
     */
    public synchronized void rescanDownloadedFiles() {
        Path downloadsRoot = logger.getDownloadsRoot();
        if (downloadsRoot == null || !Files.exists(downloadsRoot)) {
            return;
        }

        try {
            Files.walk(downloadsRoot, 2)
                .filter(Files::isDirectory)
                .filter((path) -> !path.equals(downloadsRoot))
                .filter((path) -> path.getFileName() != null)
                .forEach(this::scanTitleFolder);
        } catch (IOException error) {
            logger.warn("LIBRARY", "Raven import scan failed.", error.getMessage());
        }
    }

    private void scanTitleFolder(Path folder) {
        try {
            List<Path> archives = Files.list(folder)
                .filter(Files::isRegularFile)
                .filter((path) -> path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".cbz"))
                .sorted()
                .toList();
            if (archives.isEmpty()) {
                return;
            }

            Path parent = folder.getParent();
            String mediaType = parent != null && !parent.equals(logger.getDownloadsRoot())
                ? normalizeMediaType(parent.getFileName().toString())
                : "manga";
            String titleName = folder.getFileName().toString().replace('_', ' ').trim();
            String titleId = slugifyTitleId(titleName);
            List<LibraryChapter> chapters = new ArrayList<>();

            for (Path archive : archives) {
                String chapterNumber = extractChapterNumber(archive.getFileName().toString());
                chapters.add(new LibraryChapter(
                    chapterId(titleId, chapterNumber),
                    "Chapter " + chapterNumber,
                    chapterNumber,
                    countArchivePages(archive),
                    null,
                    true,
                    archive.toString(),
                    null
                ));
            }

            LibraryTitle existing = findTitle(titleId);
            LibraryTitle title = new LibraryTitle(
                titleId,
                titleName,
                mediaType,
                existing != null ? existing.status() : "active",
                resolveLatestChapter(chapters),
                existing != null ? existing.coverAccent() : resolveCoverAccent(titleId),
                existing != null ? existing.summary() : "",
                existing != null ? existing.releaseLabel() : "",
                chapters.size(),
                chapters.size(),
                existing != null ? existing.author() : "",
                existing != null ? existing.tags() : List.of(),
                existing != null ? existing.aliases() : List.of(),
                existing != null ? existing.metadataProvider() : "",
                existing != null ? existing.metadataMatchedAt() : null,
                existing != null ? existing.relations() : List.of(),
                existing != null ? existing.sourceUrl() : "",
                existing != null ? existing.coverUrl() : "",
                folder.toString(),
                chapters
            );
            upsertTitle(title);
            replaceChapters(titleId, chapters);
        } catch (Exception error) {
            logger.warn("LIBRARY", "Raven import scan could not index a title folder.", error.getMessage());
        }
    }

    private int resolvePageCount(LibraryChapter chapter) {
        if (chapter.archivePath() != null && !chapter.archivePath().isBlank()) {
            try {
                return countArchivePages(Path.of(chapter.archivePath()));
            } catch (Exception ignored) {
            }
        }
        return Math.max(1, chapter.pageCount());
    }

    private int countArchivePages(Path archivePath) {
        try (ZipFile zipFile = new ZipFile(archivePath.toFile())) {
            return (int) zipFile.stream()
                .filter((entry) -> !entry.isDirectory())
                .count();
        } catch (Exception error) {
            return 1;
        }
    }

    private byte[] readArchivePage(Path archivePath, int pageIndex) throws IOException {
        try (ZipFile zipFile = new ZipFile(archivePath.toFile())) {
            List<? extends ZipEntry> entries = zipFile.stream()
                .filter((entry) -> !entry.isDirectory())
                .sorted(Comparator.comparing(ZipEntry::getName))
                .toList();
            if (pageIndex < 0 || pageIndex >= entries.size()) {
                return null;
            }
            try (InputStream stream = zipFile.getInputStream(entries.get(pageIndex))) {
                return stream.readAllBytes();
            }
        }
    }

    private String resolvePageMediaType(LibraryChapter chapter, int pageIndex) {
        if (chapter.archivePath() == null || chapter.archivePath().isBlank()) {
            return "image/svg+xml";
        }

        try (ZipFile zipFile = new ZipFile(Path.of(chapter.archivePath()).toFile())) {
            List<? extends ZipEntry> entries = zipFile.stream()
                .filter((entry) -> !entry.isDirectory())
                .sorted(Comparator.comparing(ZipEntry::getName))
                .toList();
            if (pageIndex < 0 || pageIndex >= entries.size()) {
                return "image/jpeg";
            }
            String name = entries.get(pageIndex).getName().toLowerCase(Locale.ROOT);
            if (name.endsWith(".png")) {
                return "image/png";
            }
            if (name.endsWith(".webp")) {
                return "image/webp";
            }
            if (name.endsWith(".gif")) {
                return "image/gif";
            }
        } catch (Exception ignored) {
        }

        return "image/jpeg";
    }

    private String resolveLatestChapter(List<LibraryChapter> chapters) {
        return chapters.stream()
            .map(LibraryChapter::chapterNumber)
            .filter(Objects::nonNull)
            .max(Comparator.comparing(this::normalizeChapterNumber))
            .orElse("");
    }

    private String normalizeChapterNumber(String value) {
        try {
            return String.format(Locale.ROOT, "%012.3f", Double.parseDouble(Optional.ofNullable(value).orElse("0")));
        } catch (NumberFormatException ignored) {
            return Optional.ofNullable(value).orElse("");
        }
    }

    private String extractChapterNumber(String fileName) {
        String normalized = fileName.replaceFirst("(?i)\\.cbz$", "");
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("(?i)(?:chapter|c)\\s*([0-9]+(?:\\.[0-9]+)?)").matcher(normalized);
        if (matcher.find()) {
            return matcher.group(1);
        }
        matcher = java.util.regex.Pattern.compile("([0-9]+(?:\\.[0-9]+)?)").matcher(normalized);
        return matcher.find() ? matcher.group(1) : String.valueOf(Math.abs(fileName.hashCode()));
    }

    /**
     * Convert a human title into Raven's stable id format.
     *
     * @param titleName human-readable title
     * @return slugified title id
     */
    public String slugifyTitleId(String titleName) {
        return Optional.ofNullable(titleName)
            .orElse("scriptarr-title")
            .trim()
            .toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9]+", "-")
            .replaceAll("^-+", "")
            .replaceAll("-+$", "");
    }

    private String chapterId(String titleId, String chapterNumber) {
        return titleId + "-c" + Optional.ofNullable(chapterNumber).orElse("0").replace('.', '-');
    }

    private String normalizeMediaType(String value) {
        String normalized = Optional.ofNullable(value).orElse("manga").trim().toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case "manhwa", "manhua", "comic", "webtoon" -> normalized;
            default -> "manga";
        };
    }

    private List<String> mergeAliases(List<String> existingAliases, List<String> incomingAliases) {
        List<String> merged = new ArrayList<>(Optional.ofNullable(existingAliases).orElse(List.of()));
        for (String alias : Optional.ofNullable(incomingAliases).orElse(List.of())) {
            if (alias != null && !alias.isBlank() && !merged.contains(alias)) {
                merged.add(alias);
            }
        }
        return List.copyOf(merged);
    }

    private String resolveCoverAccent(String titleId) {
        int hash = Math.abs(Optional.ofNullable(titleId).orElse("scriptarr").hashCode());
        String[] accents = {"#4f8f88", "#de5d29", "#4a78d4", "#8d6bf0", "#f08a5b"};
        return accents[hash % accents.length];
    }

    private String stringValue(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    private String firstNonBlank(String primary, String fallback) {
        return primary != null && !primary.isBlank() ? primary : Optional.ofNullable(fallback).orElse("");
    }

    private String escapeSvg(String value) {
        return value
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;");
    }
}
