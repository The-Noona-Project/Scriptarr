package com.scriptarr.raven.library;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.scriptarr.raven.downloader.TitleDetails;
import com.scriptarr.raven.settings.RavenBrokerClient;
import com.scriptarr.raven.settings.RavenNamingSettings;
import com.scriptarr.raven.settings.RavenSettingsService;
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
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Sage-brokered Raven library projection and reader implementation.
 */
@Service
public final class LibraryService {
    private static final String DOWNLOADING_FOLDER_NAME = "downloading";
    private static final String DOWNLOADED_FOLDER_NAME = "downloaded";
    private static final String RESCAN_JOB_ID = "raven-library-rescan";
    private static final String RESCAN_TASK_ID = RESCAN_JOB_ID + "_scan";
    private static final TypeReference<List<LibraryTitle>> TITLE_LIST_TYPE = new TypeReference<>() {
    };
    private static final TypeReference<List<LibraryChapter>> CHAPTER_LIST_TYPE = new TypeReference<>() {
    };

    private final RavenBrokerClient brokerClient;
    private final RavenSettingsService settingsService;
    private final ScriptarrLogger logger;
    private final ObjectMapper objectMapper = new ObjectMapper();

    /**
     * Create the shared Raven library service.
     *
     * @param brokerClient Sage-backed broker client for durable catalog state
     * @param settingsService Sage-backed Raven settings service
     * @param logger shared Raven logger
     */
    public LibraryService(RavenBrokerClient brokerClient, RavenSettingsService settingsService, ScriptarrLogger logger) {
        this.brokerClient = brokerClient;
        this.settingsService = settingsService;
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
            JsonNode payload = brokerClient.listLibraryTitles();
            if (payload == null || !payload.isArray()) {
                return List.of();
            }
            return dedupeTitles(objectMapper.convertValue(payload, TITLE_LIST_TYPE));
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
            JsonNode payload = brokerClient.getLibraryTitle(id);
            if (payload == null || payload.isMissingNode() || payload.path("error").isTextual()) {
                return null;
            }
            LibraryTitle resolved = objectMapper.treeToValue(payload, LibraryTitle.class);
            String identityKey = titleIdentityKey(resolved);
            if (identityKey.isBlank()) {
                return resolved;
            }
            return listTitles().stream()
                .filter((candidate) -> identityKey.equals(titleIdentityKey(candidate)))
                .findFirst()
                .orElse(resolved);
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
            JsonNode payload = brokerClient.putLibraryTitle(title.id(), objectMapper.convertValue(title, new TypeReference<>() {
            }));
            return objectMapper.treeToValue(payload, LibraryTitle.class);
        } catch (Exception error) {
            logger.warn("LIBRARY", "Failed to persist Raven title.", error.getMessage());
            throw new IllegalStateException("Failed to persist Raven title.", error);
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
            JsonNode payload = brokerClient.putLibraryChapters(titleId, Map.of("chapters", chapters));
            if (payload == null || !payload.isArray()) {
                return chapters;
            }
            return objectMapper.convertValue(payload, CHAPTER_LIST_TYPE);
        } catch (Exception error) {
            logger.warn("LIBRARY", "Failed to persist Raven chapters.", error.getMessage());
            throw new IllegalStateException("Failed to persist Raven chapters.", error);
        }
    }

    /**
     * Persist the outcome of a completed Raven download so the reader catalog
     * reflects the promoted files under Raven's managed downloads root.
     *
     * @param titleName human-readable title name
     * @param requestedType requested type from the queue payload
     * @param sourceUrl upstream source URL
     * @param coverUrl optional upstream cover URL
     * @param details scraped title details
     * @param chapters chapter payloads discovered in the promoted folder
     * @param workingRoot temporary in-progress title folder
     * @param downloadRoot final promoted title folder
     * @return persisted title payload
     */
    public synchronized LibraryTitle recordDownloadedTitle(
        String titleName,
        String requestedType,
        String sourceUrl,
        String coverUrl,
        TitleDetails details,
        List<LibraryChapter> chapters,
        Path workingRoot,
        Path downloadRoot
    ) {
        String typeLabel = resolveTypeLabel(requestedType, details);
        String typeSlug = LibraryNaming.normalizeTypeSlug(typeLabel);
        LibraryTitle existing = findMatchingTitle(titleName, sourceUrl, typeSlug, downloadRoot);
        String titleId = existing != null && existing.id() != null && !existing.id().isBlank()
            ? existing.id()
            : UUID.randomUUID().toString();

        List<LibraryChapter> normalizedChapters = enrichAndNormalizeChapters(titleId, existing, chapters);
        LibraryTitle nextTitle = new LibraryTitle(
            titleId,
            firstNonBlank(titleName, existing != null ? existing.title() : "Untitled"),
            LibraryNaming.normalizeMediaType(typeLabel),
            typeLabel,
            typeSlug,
            resolveStatus(existing, details),
            resolveLatestChapter(normalizedChapters),
            existing != null ? existing.coverAccent() : resolveCoverAccent(titleId),
            firstNonBlank(existing != null ? existing.summary() : "", details != null ? details.summary() : ""),
            firstNonBlank(existing != null ? existing.releaseLabel() : "", details != null ? details.released() : ""),
            normalizedChapters.size(),
            normalizedChapters.size(),
            firstNonBlank(existing != null ? existing.author() : "", ""),
            existing != null ? existing.tags() : List.of(),
            mergeAliases(existing != null ? existing.aliases() : List.of(), details != null ? details.associatedNames() : List.of()),
            existing != null ? existing.metadataProvider() : "",
            existing != null ? existing.metadataMatchedAt() : null,
            details != null && details.relatedSeries() != null && !details.relatedSeries().isEmpty()
                ? details.relatedSeries()
                : (existing != null ? existing.relations() : List.of()),
            firstNonBlank(existing != null ? existing.sourceUrl() : "", sourceUrl),
            firstNonBlank(existing != null ? existing.coverUrl() : "", coverUrl),
            workingRoot != null ? workingRoot.toString() : (existing != null ? existing.workingRoot() : ""),
            downloadRoot != null ? downloadRoot.toString() : (existing != null ? existing.downloadRoot() : ""),
            List.copyOf(normalizedChapters)
        );

        LibraryTitle persisted = upsertTitle(nextTitle);
        List<LibraryChapter> persistedChapters = replaceChapters(titleId, normalizedChapters);
        return persisted == null
            ? nextTitle
            : new LibraryTitle(
            persisted.id(),
            persisted.title(),
            persisted.mediaType(),
            persisted.libraryTypeLabel(),
            persisted.libraryTypeSlug(),
            persisted.status(),
            persisted.latestChapter(),
            persisted.coverAccent(),
            persisted.summary(),
            persisted.releaseLabel(),
            persisted.chapterCount(),
            persisted.chaptersDownloaded(),
            persisted.author(),
            persisted.tags(),
            persisted.aliases(),
            persisted.metadataProvider(),
            persisted.metadataMatchedAt(),
            persisted.relations(),
            persisted.sourceUrl(),
            persisted.coverUrl(),
            persisted.workingRoot(),
            persisted.downloadRoot(),
            List.copyOf(persistedChapters)
        );
    }

    /**
     * Persist one downloaded chapter and merge it into an existing title.
     *
     * @param titleName human-readable title name
     * @param requestedType requested type from the queue payload
     * @param sourceUrl upstream source URL
     * @param coverUrl optional upstream cover URL
     * @param details scraped title details
     * @param chapter downloaded chapter payload
     * @param archivePath archive path on disk
     */
    public synchronized void recordDownloadedChapter(
        String titleName,
        String requestedType,
        String sourceUrl,
        String coverUrl,
        TitleDetails details,
        LibraryChapter chapter,
        Path archivePath
    ) {
        Path finalRoot = archivePath != null && archivePath.getParent() != null ? archivePath.getParent() : null;
        Path workingRoot = finalRoot;
        List<LibraryChapter> chapters = new ArrayList<>();
        LibraryTitle existing = findMatchingTitle(titleName, sourceUrl, LibraryNaming.normalizeTypeSlug(resolveTypeLabel(requestedType, details)), finalRoot);
        if (existing != null) {
            chapters.addAll(existing.chapters());
        }
        chapters.removeIf((entry) -> Objects.equals(entry.id(), chapter.id()));
        chapters.add(chapter);
        recordDownloadedTitle(titleName, requestedType, sourceUrl, coverUrl, details, chapters, workingRoot, finalRoot);
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
            existing.libraryTypeLabel(),
            existing.libraryTypeSlug(),
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
            existing.workingRoot(),
            existing.downloadRoot(),
            Optional.ofNullable(existing.chapters()).orElse(List.of())
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

        List<LibraryChapter> chapters = Optional.ofNullable(title.chapters()).orElse(List.of()).stream()
            .filter(LibraryChapter::available)
            .sorted(Comparator.comparing((LibraryChapter entry) -> chapterSortKey(entry.chapterNumber())).reversed())
            .toList();
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
        Instant startedAt = Instant.now();
        persistRescanJob("running", "Scanning Raven downloads for imported titles.", startedAt, null, Map.of());
        Path downloadsRoot = logger.getDownloadsRoot();
        if (downloadsRoot == null || !Files.exists(downloadsRoot)) {
            persistRescanJob("completed", "Raven downloads root is empty.", startedAt, Instant.now(), Map.of("titles", 0));
            return;
        }

        try {
            scanManagedDownloadedRoot(downloadsRoot.resolve(DOWNLOADED_FOLDER_NAME));
            scanLegacyDownloadedRoot(downloadsRoot);
            persistRescanJob("completed", "Raven library rescan completed.", startedAt, Instant.now(), Map.of(
                "titles", listTitles().size()
            ));
        } catch (IOException error) {
            logger.warn("LIBRARY", "Raven import scan failed.", error.getMessage());
            persistRescanJob("failed", error.getMessage(), startedAt, Instant.now(), Map.of("error", error.getMessage()));
        }
    }

    /**
     * Convert a human title into a stable slug.
     * This is kept for backward compatibility, but Raven now uses opaque UUIDs
     * for new title records.
     *
     * @param titleName human-readable title
     * @return slugified title id
     */
    public String slugifyTitleId(String titleName) {
        return LibraryNaming.slugifySegment(titleName);
    }

    private void scanManagedDownloadedRoot(Path downloadedRoot) throws IOException {
        if (!Files.exists(downloadedRoot) || !Files.isDirectory(downloadedRoot)) {
            return;
        }

        try (var typeFolders = Files.list(downloadedRoot).filter(Files::isDirectory).sorted()) {
            for (Path typeFolder : typeFolders.toList()) {
                String typeSlug = typeFolder.getFileName().toString();
                try (var titleFolders = Files.list(typeFolder).filter(Files::isDirectory).sorted()) {
                    for (Path titleFolder : titleFolders.toList()) {
                        scanTitleFolder(titleFolder, typeSlug, resolveWorkingRoot(downloadedRoot.getParent(), typeSlug, titleFolder.getFileName().toString()));
                    }
                }
            }
        }
    }

    private void scanLegacyDownloadedRoot(Path downloadsRoot) throws IOException {
        try (var typeFolders = Files.list(downloadsRoot).filter(Files::isDirectory).sorted()) {
            for (Path typeFolder : typeFolders.toList()) {
                String folderName = typeFolder.getFileName().toString();
                if (DOWNLOADING_FOLDER_NAME.equalsIgnoreCase(folderName) || DOWNLOADED_FOLDER_NAME.equalsIgnoreCase(folderName) || "logs".equalsIgnoreCase(folderName)) {
                    continue;
                }

                try (var titleFolders = Files.list(typeFolder).filter(Files::isDirectory).sorted()) {
                    for (Path titleFolder : titleFolders.toList()) {
                        scanTitleFolder(titleFolder, folderName, null);
                    }
                }
            }
        }
    }

    private void scanTitleFolder(Path folder, String rawType, Path workingRoot) {
        try {
            List<Path> archives = listArchiveFiles(folder);
            if (archives.isEmpty()) {
                return;
            }

            String titleName = LibraryNaming.titleFromFolder(folder.getFileName().toString());
            String typeLabel = LibraryNaming.normalizeTypeLabel(rawType);
            String typeSlug = LibraryNaming.normalizeTypeSlug(typeLabel);
            RavenNamingSettings namingSettings = settingsService.getNamingSettings();
            List<LibraryChapter> chapters = new ArrayList<>();
            LibraryTitle existing = findMatchingTitle(titleName, "", typeSlug, folder);
            String titleId = existing != null && existing.id() != null && !existing.id().isBlank()
                ? existing.id()
                : UUID.randomUUID().toString();

            for (Path archive : archives) {
                String chapterNumber = LibraryNaming.extractChapterNumber(archive.getFileName().toString(), namingSettings);
                chapters.add(new LibraryChapter(
                    chapterId(titleId, chapterNumber),
                    "Chapter " + chapterNumber,
                    chapterNumber,
                    countArchivePages(archive),
                    resolveArchiveTimestamp(archive),
                    true,
                    archive.toString(),
                    null
                ));
            }
            chapters = normalizeChapters(titleId, chapters);

            LibraryTitle title = new LibraryTitle(
                titleId,
                titleName,
                LibraryNaming.normalizeMediaType(typeLabel),
                typeLabel,
                typeSlug,
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
                workingRoot != null ? workingRoot.toString() : (existing != null ? existing.workingRoot() : ""),
                folder.toString(),
                List.copyOf(chapters)
            );
            upsertTitle(title);
            replaceChapters(titleId, chapters);
        } catch (Exception error) {
            logger.warn("LIBRARY", "Raven import scan could not index a title folder.", error.getMessage());
        }
    }

    private List<Path> listArchiveFiles(Path folder) throws IOException {
        try (var archives = Files.list(folder)) {
            return archives
                .filter(Files::isRegularFile)
                .filter((path) -> path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".cbz"))
                .sorted()
                .toList();
        }
    }

    private String resolveArchiveTimestamp(Path archive) {
        if (archive == null) {
            return null;
        }

        try {
            return Files.getLastModifiedTime(archive).toInstant().toString();
        } catch (IOException ignored) {
            return null;
        }
    }

    private Path resolveWorkingRoot(Path downloadsRoot, String typeSlug, String titleFolder) {
        if (downloadsRoot == null) {
            return null;
        }
        return downloadsRoot.resolve(DOWNLOADING_FOLDER_NAME).resolve(typeSlug).resolve(titleFolder);
    }

    private List<LibraryTitle> dedupeTitles(List<LibraryTitle> titles) {
        Map<String, LibraryTitle> deduped = new LinkedHashMap<>();
        for (LibraryTitle candidate : Optional.ofNullable(titles).orElse(List.of())) {
            if (candidate == null) {
                continue;
            }
            String identityKey = titleIdentityKey(candidate);
            if (identityKey.isBlank()) {
                deduped.put("id:" + Optional.ofNullable(candidate.id()).orElse(UUID.randomUUID().toString()), candidate);
                continue;
            }
            LibraryTitle existing = deduped.get(identityKey);
            deduped.put(identityKey, existing == null ? candidate : mergeDuplicateTitles(existing, candidate));
        }
        return List.copyOf(deduped.values());
    }

    private String titleIdentityKey(LibraryTitle title) {
        if (title == null) {
            return "";
        }

        String normalizedRoot = Optional.ofNullable(title.downloadRoot()).orElse("").trim();
        if (!normalizedRoot.isBlank()) {
            return "root:" + normalizedRoot;
        }

        String normalizedSource = Optional.ofNullable(title.sourceUrl()).orElse("").trim();
        String normalizedType = Optional.ofNullable(title.libraryTypeSlug()).orElse("").trim();
        if (!normalizedSource.isBlank() && !normalizedType.isBlank()) {
            return "source:" + normalizedType + ":" + normalizedSource;
        }

        String normalizedTitle = LibraryNaming.slugifySegment(title.title());
        if (!normalizedTitle.isBlank() && !normalizedType.isBlank()) {
            return "title:" + normalizedType + ":" + normalizedTitle;
        }

        return "";
    }

    private LibraryTitle mergeDuplicateTitles(LibraryTitle left, LibraryTitle right) {
        LibraryTitle preferred = titleRichnessScore(right) > titleRichnessScore(left) ? right : left;
        LibraryTitle secondary = preferred == left ? right : left;
        List<LibraryChapter> mergedChapters = mergeChapterLists(
            preferred.id(),
            Optional.ofNullable(preferred.chapters()).orElse(List.of()),
            Optional.ofNullable(secondary.chapters()).orElse(List.of())
        );

        return new LibraryTitle(
            preferred.id(),
            firstNonBlank(preferred.title(), secondary.title()),
            firstNonBlank(preferred.mediaType(), secondary.mediaType()),
            firstNonBlank(preferred.libraryTypeLabel(), secondary.libraryTypeLabel()),
            firstNonBlank(preferred.libraryTypeSlug(), secondary.libraryTypeSlug()),
            firstNonBlank(preferred.status(), secondary.status()),
            resolveLatestChapter(mergedChapters),
            firstNonBlank(preferred.coverAccent(), secondary.coverAccent()),
            preferLongerText(preferred.summary(), secondary.summary()),
            preferLongerText(preferred.releaseLabel(), secondary.releaseLabel()),
            maxInt(preferred.chapterCount(), secondary.chapterCount(), mergedChapters.size()),
            maxInt(preferred.chaptersDownloaded(), secondary.chaptersDownloaded(), mergedChapters.size()),
            preferLongerText(preferred.author(), secondary.author()),
            mergeStringLists(preferred.tags(), secondary.tags()),
            mergeAliases(preferred.aliases(), secondary.aliases()),
            firstNonBlank(preferred.metadataProvider(), secondary.metadataProvider()),
            firstNonBlank(preferred.metadataMatchedAt(), secondary.metadataMatchedAt()),
            chooseRelationList(preferred.relations(), secondary.relations()),
            firstNonBlank(preferred.sourceUrl(), secondary.sourceUrl()),
            firstNonBlank(preferred.coverUrl(), secondary.coverUrl()),
            firstNonBlank(preferred.workingRoot(), secondary.workingRoot()),
            firstNonBlank(preferred.downloadRoot(), secondary.downloadRoot()),
            List.copyOf(mergedChapters)
        );
    }

    private int titleRichnessScore(LibraryTitle title) {
        if (title == null) {
            return 0;
        }

        int score = 0;
        if (title.coverUrl() != null && !title.coverUrl().isBlank()) {
            score += 8;
        }
        if (title.sourceUrl() != null && !title.sourceUrl().isBlank()) {
            score += 6;
        }
        if (title.summary() != null && !title.summary().isBlank()) {
            score += 4;
        }
        if (title.releaseLabel() != null && !title.releaseLabel().isBlank()) {
            score += 2;
        }
        if (title.author() != null && !title.author().isBlank()) {
            score += 2;
        }
        if (title.metadataProvider() != null && !title.metadataProvider().isBlank()) {
            score += 2;
        }
        score += Math.min(4, Optional.ofNullable(title.chapters()).orElse(List.of()).size());
        return score;
    }

    private List<LibraryChapter> mergeChapterLists(String titleId, List<LibraryChapter> primary, List<LibraryChapter> secondary) {
        Map<String, LibraryChapter> chaptersByNumber = new LinkedHashMap<>();
        for (LibraryChapter chapter : Optional.ofNullable(secondary).orElse(List.of())) {
            String chapterNumber = normalizeStoredChapterNumber(chapter == null ? "" : chapter.chapterNumber());
            if (!chapterNumber.isBlank()) {
                chaptersByNumber.put(chapterNumber, chapter);
            }
        }
        for (LibraryChapter chapter : Optional.ofNullable(primary).orElse(List.of())) {
            String chapterNumber = normalizeStoredChapterNumber(chapter == null ? "" : chapter.chapterNumber());
            if (chapterNumber.isBlank()) {
                continue;
            }
            LibraryChapter existing = chaptersByNumber.get(chapterNumber);
            chaptersByNumber.put(
                chapterNumber,
                existing == null ? chapter : mergeDuplicateChapter(titleId, existing, chapter)
            );
        }
        return normalizeChapters(titleId, new ArrayList<>(chaptersByNumber.values()));
    }

    private LibraryChapter mergeDuplicateChapter(String titleId, LibraryChapter left, LibraryChapter right) {
        LibraryChapter preferred = chapterRichnessScore(right) > chapterRichnessScore(left) ? right : left;
        LibraryChapter secondary = preferred == left ? right : left;
        String normalizedChapterNumber = firstNonBlank(preferred.chapterNumber(), secondary.chapterNumber());
        return new LibraryChapter(
            firstNonBlank(preferred.id(), firstNonBlank(secondary.id(), chapterId(titleId, normalizedChapterNumber))),
            firstNonBlank(preferred.label(), secondary.label()),
            normalizedChapterNumber,
            maxInt(preferred.pageCount(), secondary.pageCount()),
            firstNonBlank(preferred.releaseDate(), secondary.releaseDate()),
            preferred.available() || secondary.available(),
            firstNonBlank(preferred.archivePath(), secondary.archivePath()),
            firstNonBlank(preferred.sourceUrl(), secondary.sourceUrl())
        );
    }

    private int chapterRichnessScore(LibraryChapter chapter) {
        if (chapter == null) {
            return 0;
        }

        int score = 0;
        if (chapter.archivePath() != null && !chapter.archivePath().isBlank()) {
            score += 5;
        }
        if (chapter.sourceUrl() != null && !chapter.sourceUrl().isBlank()) {
            score += 4;
        }
        if (chapter.releaseDate() != null && !chapter.releaseDate().isBlank()) {
            score += 1;
        }
        score += Math.max(0, chapter.pageCount());
        return score;
    }

    private List<String> mergeStringLists(List<String> primaryValues, List<String> secondaryValues) {
        List<String> merged = new ArrayList<>(Optional.ofNullable(primaryValues).orElse(List.of()));
        for (String value : Optional.ofNullable(secondaryValues).orElse(List.of())) {
            if (value != null && !value.isBlank() && !merged.contains(value)) {
                merged.add(value);
            }
        }
        return List.copyOf(merged);
    }

    private List<Map<String, String>> chooseRelationList(List<Map<String, String>> primaryRelations, List<Map<String, String>> secondaryRelations) {
        if (primaryRelations != null && !primaryRelations.isEmpty()) {
            return primaryRelations;
        }
        return Optional.ofNullable(secondaryRelations).orElse(List.of());
    }

    private int maxInt(int first, int second) {
        return Math.max(first, second);
    }

    private int maxInt(int first, int second, int third) {
        return Math.max(Math.max(first, second), third);
    }

    private LibraryTitle findMatchingTitle(String titleName, String sourceUrl, String typeSlug, Path downloadRoot) {
        String requestedSource = Optional.ofNullable(sourceUrl).orElse("").trim();
        String requestedType = Optional.ofNullable(typeSlug).orElse("").trim();
        String requestedTitleSlug = LibraryNaming.slugifySegment(titleName);
        String requestedDownloadRoot = downloadRoot == null ? "" : downloadRoot.toString();

        for (LibraryTitle candidate : listTitles()) {
            if (candidate == null) {
                continue;
            }
            if (!requestedDownloadRoot.isBlank() && requestedDownloadRoot.equals(candidate.downloadRoot())) {
                return candidate;
            }
            if (!requestedSource.isBlank()
                && requestedSource.equals(candidate.sourceUrl())
                && Objects.equals(Optional.ofNullable(candidate.libraryTypeSlug()).orElse(""), requestedType)) {
                return candidate;
            }
            if (LibraryNaming.slugifySegment(candidate.title()).equals(requestedTitleSlug)
                && Objects.equals(Optional.ofNullable(candidate.libraryTypeSlug()).orElse(""), requestedType)) {
                return candidate;
            }
        }
        return null;
    }

    private List<LibraryChapter> normalizeChapters(String titleId, List<LibraryChapter> chapters) {
        Map<String, LibraryChapter> chapterByNumber = new LinkedHashMap<>();
        for (LibraryChapter chapter : Optional.ofNullable(chapters).orElse(List.of())) {
            if (chapter == null) {
                continue;
            }
            String chapterNumber = normalizeStoredChapterNumber(chapter.chapterNumber());
            if (chapterNumber.isBlank()) {
                continue;
            }
            chapterByNumber.put(chapterNumber, new LibraryChapter(
                firstNonBlank(chapter.id(), chapterId(titleId, chapterNumber)),
                firstNonBlank(chapter.label(), "Chapter " + chapterNumber),
                chapterNumber,
                Math.max(1, chapter.pageCount()),
                chapter.releaseDate(),
                chapter.available(),
                chapter.archivePath(),
                chapter.sourceUrl()
            ));
        }

        return chapterByNumber.values().stream()
            .sorted(Comparator.comparing((LibraryChapter entry) -> chapterSortKey(entry.chapterNumber())).reversed())
            .toList();
    }

    private List<LibraryChapter> enrichAndNormalizeChapters(String titleId, LibraryTitle existing, List<LibraryChapter> chapters) {
        Map<String, LibraryChapter> existingByChapter = new LinkedHashMap<>();
        if (existing != null) {
            for (LibraryChapter chapter : Optional.ofNullable(existing.chapters()).orElse(List.of())) {
                if (chapter == null || chapter.chapterNumber() == null || chapter.chapterNumber().isBlank()) {
                    continue;
                }
                existingByChapter.put(normalizeStoredChapterNumber(chapter.chapterNumber()), chapter);
            }
        }

        List<LibraryChapter> merged = new ArrayList<>();
        for (LibraryChapter chapter : Optional.ofNullable(chapters).orElse(List.of())) {
            if (chapter == null) {
                continue;
            }
            String chapterNumber = normalizeStoredChapterNumber(chapter.chapterNumber());
            LibraryChapter persisted = existingByChapter.get(chapterNumber);
            merged.add(new LibraryChapter(
                firstNonBlank(chapter.id(), persisted != null ? persisted.id() : ""),
                firstNonBlank(chapter.label(), persisted != null ? persisted.label() : "Chapter " + chapterNumber),
                chapterNumber,
                chapter.pageCount() > 0 ? chapter.pageCount() : (persisted != null ? persisted.pageCount() : 1),
                firstNonBlank(chapter.releaseDate(), persisted != null ? persisted.releaseDate() : ""),
                chapter.available() || (persisted != null && persisted.available()),
                firstNonBlank(chapter.archivePath(), persisted != null ? persisted.archivePath() : ""),
                firstNonBlank(chapter.sourceUrl(), persisted != null ? persisted.sourceUrl() : "")
            ));
        }
        return normalizeChapters(titleId, merged);
    }

    private String resolveTypeLabel(String requestedType, TitleDetails details) {
        if (details != null && details.type() != null && !details.type().isBlank()) {
            return LibraryNaming.normalizeTypeLabel(details.type());
        }
        return LibraryNaming.normalizeTypeLabel(requestedType);
    }

    private String resolveStatus(LibraryTitle existing, TitleDetails details) {
        if (details != null && details.status() != null && !details.status().isBlank()) {
            return details.status().trim().toLowerCase(Locale.ROOT);
        }
        return existing != null && existing.status() != null && !existing.status().isBlank() ? existing.status() : "active";
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
            List<? extends ZipEntry> entries = sortArchiveEntries(zipFile);
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
            List<? extends ZipEntry> entries = sortArchiveEntries(zipFile);
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
            .max(Comparator.comparing(this::chapterSortKey))
            .orElse("");
    }

    private String chapterSortKey(String value) {
        try {
            return String.format(Locale.ROOT, "%012.3f", Double.parseDouble(Optional.ofNullable(value).orElse("0")));
        } catch (NumberFormatException ignored) {
            return Optional.ofNullable(value).orElse("").trim();
        }
    }

    private String normalizeStoredChapterNumber(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        try {
            return new java.math.BigDecimal(value.trim()).stripTrailingZeros().toPlainString();
        } catch (NumberFormatException ignored) {
            return value.trim();
        }
    }

    private String chapterId(String titleId, String chapterNumber) {
        return titleId + "-c" + Optional.ofNullable(chapterNumber).orElse("0").replace('.', '-');
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

    private String preferLongerText(String primary, String fallback) {
        String left = Optional.ofNullable(primary).orElse("").trim();
        String right = Optional.ofNullable(fallback).orElse("").trim();
        if (left.isBlank()) {
            return right;
        }
        if (right.isBlank()) {
            return left;
        }
        return right.length() > left.length() ? right : left;
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

    private void persistRescanJob(String status, String message, Instant startedAt, Instant finishedAt, Map<String, Object> result) {
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("jobId", RESCAN_JOB_ID);
            payload.put("kind", "library-rescan");
            payload.put("ownerService", "scriptarr-raven");
            payload.put("status", status);
            payload.put("label", "Raven library rescan");
            payload.put("requestedBy", "scriptarr-raven");
            payload.put("payload", Map.of("scope", "downloads-root"));
            payload.put("result", result);
            payload.put("createdAt", startedAt.toString());
            payload.put("startedAt", startedAt.toString());
            payload.put("finishedAt", finishedAt == null ? null : finishedAt.toString());
            payload.put("updatedAt", (finishedAt == null ? Instant.now() : finishedAt).toString());
            brokerClient.putJob(RESCAN_JOB_ID, payload);

            Map<String, Object> taskPayload = new LinkedHashMap<>();
            taskPayload.put("taskId", RESCAN_TASK_ID);
            taskPayload.put("jobId", RESCAN_JOB_ID);
            taskPayload.put("taskKey", "scan-downloads");
            taskPayload.put("label", "Scan downloaded titles");
            taskPayload.put("status", status);
            taskPayload.put("message", message);
            taskPayload.put("percent", "running".equals(status) ? 20 : 100);
            taskPayload.put("sortOrder", 0);
            taskPayload.put("payload", Map.of("scope", "downloads-root"));
            taskPayload.put("result", result);
            taskPayload.put("createdAt", startedAt.toString());
            taskPayload.put("startedAt", startedAt.toString());
            taskPayload.put("finishedAt", finishedAt == null ? null : finishedAt.toString());
            taskPayload.put("updatedAt", (finishedAt == null ? Instant.now() : finishedAt).toString());
            brokerClient.putJobTask(RESCAN_JOB_ID, RESCAN_TASK_ID, taskPayload);
        } catch (Exception error) {
            logger.warn("LIBRARY", "Failed to persist the Raven rescan job.", error.getMessage());
        }
    }

    private List<? extends ZipEntry> sortArchiveEntries(ZipFile zipFile) {
        RavenNamingSettings namingSettings = settingsService.getNamingSettings();
        return zipFile.stream()
            .filter((entry) -> !entry.isDirectory())
            .sorted(
                Comparator
                    .comparingInt((ZipEntry entry) -> LibraryNaming.extractPageOrder(entry.getName(), namingSettings))
                    .thenComparing(ZipEntry::getName)
            )
            .toList();
    }
}
