package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Validate and read saved chapter formats independently of the currently configured output encoder. */
public final class DerivedPageManifest {
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Prevent construction of this manifest utility. */
    private DerivedPageManifest() { }

    /** @param revision saved revision @return whether its format is supported for reading */
    public static boolean supported(String revision) { return revision != null && revision.matches("(?:avif|webp)-[a-f0-9]{16}"); }

    /** @param chapter ready chapter @return explicit logical/physical completion counters for WebP @throws IOException when a saved manifest cannot be verified */
    public static Map<String, Object> catalogFields(LibraryChapter chapter) throws IOException {
        if (chapter == null || !chapter.ingestRevision().startsWith("webp-") || !"ready".equals(chapter.ingestStatus())) return Map.of();
        JsonNode manifest = read(chapter); int count = 0;
        for (JsonNode page : manifest.path("pages")) count += page.path("segments").size();
        if (count < chapter.ingestedPageCount() || !reusable(chapter)) throw new IOException("All logical WebP segments must be ready before catalog completion.");
        return Map.of("sourcePageCount", chapter.pageCount(), "expectedSegmentCount", count, "ingestedSegmentCount", count, "segmentsReady", true);
    }

    /**
     * Read a bounded saved manifest with its declared identity and supported format.
     * @param chapter catalog chapter
     * @return saved manifest
     * @throws IOException when the manifest is missing or invalid
     */
    public static JsonNode read(LibraryChapter chapter) throws IOException {
        if (chapter == null || chapter.ingestManifestPath() == null || !supported(chapter.ingestRevision())) throw new IOException("Reader manifest is unavailable.");
        Path file = Path.of(chapter.ingestManifestPath());
        if (Files.isSymbolicLink(file) || !Files.isRegularFile(file) || Files.size(file) > 8_388_608) throw new IOException("Reader manifest is unavailable.");
        JsonNode manifest = JSON.readTree(file.toFile()); String format = manifest.path("format").asText();
        if (!List.of("avif", "webp").contains(format) || !chapter.ingestRevision().equals(manifest.path("revision").asText())
            || !chapter.id().equals(manifest.path("chapterId").asText()) || !("image/" + format).equals(manifest.path("mediaType").asText())
            || manifest.path("pageCount").asInt() != chapter.ingestedPageCount()) throw new IOException("Reader manifest identity differs.");
        return manifest;
    }

    /**
     * Resolve one exact derived file; segmented pages require an explicit segment selector.
     * @param chapter saved chapter
     * @param pageIndex logical source page
     * @param segmentIndex optional segment index
     * @param thumbnail whether the complete first logical page thumbnail is requested
     * @return scoped regular page file
     * @throws IOException when any selector or file is invalid
     */
    public static Path page(LibraryChapter chapter, int pageIndex, Integer segmentIndex, boolean thumbnail) throws IOException {
        JsonNode manifest = read(chapter), pages = manifest.path("pages");
        if (pageIndex < 0 || pageIndex >= pages.size()) throw new IOException("Logical page is unavailable.");
        JsonNode page = pages.get(pageIndex); String slug;
        if (page.path("segments").isArray()) for (JsonNode part : page.path("segments")) {
            Path component = scopedFile(Path.of(chapter.ingestManifestPath()).getParent(), part.path("slug").asText());
            if (Files.size(component) != part.path("size").asLong()) throw new IOException("Logical page has an unavailable segment.");
        }
        if (thumbnail) {
            if (pageIndex != 0 || segmentIndex != null) throw new IOException("Invalid thumbnail selector.");
            slug = page.path("thumbnail").path("slug").asText();
            if (slug.isBlank() && "avif".equals(manifest.path("format").asText())) slug = page.path("slug").asText();
        } else if (page.path("segments").isArray()) {
            JsonNode segments = page.path("segments");
            int index = segmentIndex == null && segments.size() == 1 ? 0 : segmentIndex == null ? -1 : segmentIndex;
            if (index < 0 || index >= segments.size()) throw new IOException("An explicit logical-page segment is required.");
            slug = segments.get(index).path("slug").asText();
        } else {
            if (segmentIndex != null && segmentIndex != 0) throw new IOException("Invalid segment selector.");
            slug = page.path("slug").asText(String.format(Locale.ROOT, "p%06d.avif", pageIndex + 1));
        }
        return scopedFile(Path.of(chapter.ingestManifestPath()).getParent(), slug);
    }

    /** @param root exact chapter revision directory @param slug immutable simple filename @return regular scoped file @throws IOException when the file escapes or is unavailable */
    public static Path scopedFile(Path root, String slug) throws IOException {
        if (root == null || !slug.matches("p[0-9]{6}(?:-s[0-9]{4}|-thumbnail)?\\.(?:webp|avif)")) throw new IOException("Invalid derived page identity.");
        Path file = root.resolve(slug);
        if (Files.isSymbolicLink(file) || !Files.isRegularFile(file) || Files.size(file) <= 0 || !file.toRealPath().getParent().equals(root.toRealPath())) throw new IOException("Derived page is unavailable.");
        return file;
    }

    /**
     * Verify all logical source pages and every exact segment of a saved chapter.
     * @param chapter catalog chapter
     * @return whether source archive and all derived pages still match
     */
    public static boolean reusable(LibraryChapter chapter) {
        if (chapter == null || !chapter.available() || !"ready".equals(chapter.ingestStatus())) return false;
        try {
            JsonNode manifest = read(chapter); Path archive = Path.of(chapter.archivePath()); int count = ArchiveImageEntries.count(archive);
            String format = manifest.path("format").asText(), encoder = manifest.path("encoder").asText(); int quality = "webp".equals(format) ? 85 : 50;
            int version = "webp".equals(format) ? manifest.path("segmentationVersion").asInt() : 1;
            if (count <= 0 || count != chapter.ingestedPageCount() || encoder.isBlank() || manifest.path("quality").asInt() != quality
                || !revision(archive, count, format, encoder, quality, version).equals(chapter.ingestRevision())) return false;
            JsonNode pages = manifest.path("pages"); if (!pages.isArray() || pages.size() != count) return false;
            for (int index = 0; index < count; index++) {
                JsonNode page = pages.get(index); if (page.path("index").asInt(-1) != index) return false;
                if ("avif".equals(format)) { page(chapter, index, null, false); continue; }
                if (manifest.path("method").asInt() != 4 || !List.of(1, 2).contains(version)) return false;
                List<WebpSegmentation.Rectangle> expected = WebpSegmentation.split(page.path("width").asInt(), page.path("height").asInt(), version);
                JsonNode segments = page.path("segments"); if (!segments.isArray() || segments.size() != expected.size()) return false;
                for (WebpSegmentation.Rectangle rectangle : expected) {
                    JsonNode segment = segments.get(rectangle.index());
                    if (segment.path("index").asInt(-1) != rectangle.index() || segment.path("x").asInt(-1) != rectangle.x()
                        || segment.path("y").asInt(-1) != rectangle.y() || segment.path("width").asInt() != rectangle.width()
                        || segment.path("height").asInt() != rectangle.height()) return false;
                    Path file = page(chapter, index, rectangle.index(), false);
                    if (Files.size(file) != segment.path("size").asLong() || !WebpChapterEncoder.sha256(file).equals(segment.path("sha256").asText())) return false;
                }
                if (index == 0) {
                    JsonNode thumbnail = page.path("thumbnail"); Path file = page(chapter, 0, null, true);
                    if (thumbnail.path("width").asInt() <= 0 || thumbnail.path("width").asInt() > 512 || thumbnail.path("height").asInt() <= 0 || thumbnail.path("height").asInt() > 768
                        || Files.size(file) != thumbnail.path("size").asLong() || !WebpChapterEncoder.sha256(file).equals(thumbnail.path("sha256").asText())) return false;
                }
            }
            return true;
        } catch (Exception unavailable) { return false; }
    }

    /**
     * Keep legacy AVIF revisions stable and give WebP its own explicit immutable profile identity.
     * @param archive canonical source archive
     * @param count logical source page count
     * @param format output format
     * @param encoder actual selected encoder
     * @param quality format-specific quality
     * @return stable revision
     * @throws Exception when source metadata cannot be read
     */
    public static String revision(Path archive, int count, String format, String encoder, int quality) throws Exception {
        return revision(archive, count, format, encoder, quality, 1);
    }

    /** @param archive canonical source @param count logical pages @param format saved output format @param encoder saved encoder @param quality quality policy @param version saved segmentation profile @return content/profile revision retaining legacy identities @throws Exception when hashing fails */
    public static String revision(Path archive, int count, String format, String encoder, int quality, int version) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        List<String> identity = "webp".equals(format)
            ? List.of(WebpChapterEncoder.sha256(archive), Integer.toString(count), format, encoder, Integer.toString(quality), "method4-segmentation" + version)
            : List.of(archive.toString(), Long.toString(Files.size(archive)), Long.toString(Files.getLastModifiedTime(archive).toMillis()), Integer.toString(count), format, encoder, Integer.toString(quality));
        for (String value : identity) hash.update(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return format + "-" + HexFormat.of().formatHex(hash.digest()).substring(0, 16);
    }
}
