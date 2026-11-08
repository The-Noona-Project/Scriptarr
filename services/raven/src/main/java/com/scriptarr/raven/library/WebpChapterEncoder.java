package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.IntConsumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Worker-only WebP conversion; no catalog, provider, VPN or canonical-storage access. */
public final class WebpChapterEncoder {
    private final ObjectMapper json = new ObjectMapper();

    /** @param directory worker-private probe directory @return whether real WebP encode and decode succeed */
    public boolean selfTest(Path directory) {
        try {
            Files.createDirectories(directory); Path input = directory.resolve("probe.ppm"), output = directory.resolve("probe.webp");
            byte[] header = "P6\n2 2\n255\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII), bytes = new byte[header.length + 12];
            System.arraycopy(header, 0, bytes, 0, header.length); java.util.Arrays.fill(bytes, header.length, bytes.length, (byte) 127); Files.write(input, bytes);
            int[] dimensions = VipsImageSource.dimensions(input); if (dimensions[0] != 2 || dimensions[1] != 2) return false;
            Path region = directory.resolve("probe-region.png"); VipsImageSource.region(input, region, new WebpSegmentation.Rectangle(0, 0, 0, 2, 2));
            VipsImageSource.thumbnail(input, directory.resolve("probe-thumbnail.png"));
            convert(region, output, "format=rgb24"); return Files.size(output) > 12;
        } catch (Exception failure) { if (failure instanceof InterruptedException) Thread.currentThread().interrupt(); return false; }
        finally { try { if (Files.exists(directory)) try (var paths = Files.walk(directory)) { for (Path file : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(file); } } catch (IOException ignored) { /* Probe scratch is never canonical content. */ } }
    }

    /**
     * Convert an immutable input archive into a bounded chapter artifact.
     * @param archive worker-local downloaded CBZ
     * @param spec immutable broker job specification
     * @param scratch private empty output directory
     * @param completed callback for genuinely completed logical pages
     * @return artifact ZIP containing the page metadata and WebP files
     * @throws IOException when source or converted output is invalid
     * @throws InterruptedException when the lease or process is cancelled
     */
    public Path encode(Path archive, JsonNode spec, Path scratch, IntConsumer completed) throws IOException, InterruptedException {
        return encodeWithProgress(archive, spec, scratch, state -> completed.accept(state.completedLogicalPages()));
    }

    /** @param archive input CBZ @param spec immutable job @param scratch private output @param progress actual logical/physical completion @return encoded result ZIP @throws IOException when conversion fails @throws InterruptedException on cancellation */
    public Path encodeWithProgress(Path archive, JsonNode spec, Path scratch, java.util.function.Consumer<Progress> progress) throws IOException, InterruptedException {
        JsonNode profile = spec.path("profile");
        Map<String, Object> legacy = new LinkedHashMap<>(RemoteChapterProcessor.PROFILE); legacy.put("segmentationVersion", 1);
        if (!profile.equals(json.valueToTree(RemoteChapterProcessor.PROFILE)) && !profile.equals(json.valueToTree(legacy))) throw new IOException("Unsupported immutable WebP profile.");
        if (!sha256(archive).equals(spec.path("input").path("sourceFingerprint").path("sha256").asText())) throw new IOException("Input archive fingerprint differs.");
        Files.createDirectories(scratch);
        List<Map<String, Object>> pages = new ArrayList<>();
        int completedSegments = 0, totalSegments = 0;
        try (ZipFile zip = new ZipFile(archive.toFile())) {
            JsonNode entries = spec.path("input").path("entries");
            if (!entries.isArray() || entries.isEmpty() || entries.size() != spec.path("input").path("sourcePageCount").asInt()) throw new IOException("Frozen source page order is required.");
            for (int index = 0; index < entries.size(); index++) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException("Worker job cancelled.");
                String name = entries.get(index).asText(); ZipEntry entry = zip.getEntry(name);
                if (entry == null || entry.isDirectory() || !ArchiveImageEntries.isImage(name) || entry.getSize() <= 0 || entry.getSize() > 268_435_456L) throw new IOException("Invalid bounded source page.");
                Path source = scratch.resolve("source-" + index + extension(name));
                try (InputStream in = zip.getInputStream(entry)) { copyBounded(in, source, entry.getSize(), 268_435_456L); }
                try {
                    int[] dimensions = dimensions(source);
                    List<Map<String, Object>> segments = new ArrayList<>();
                    List<WebpSegmentation.Rectangle> tiles = WebpSegmentation.split(dimensions[0], dimensions[1], profile.path("segmentationVersion").asInt()); totalSegments += tiles.size();
                    for (WebpSegmentation.Rectangle tile : tiles) {
                        String slug = String.format(Locale.ROOT, "p%06d-s%04d.webp", index + 1, tile.index());
                        Path target = scratch.resolve(slug);
                        Path raster = scratch.resolve("region-" + index + "-" + tile.index() + ".png");
                        try { VipsImageSource.region(source, raster, tile); convert(raster, target, "format=rgba"); }
                        finally { Files.deleteIfExists(raster); }
                        Map<String, Object> segment = new LinkedHashMap<>(file(target));
                        segment.putAll(Map.of("index", tile.index(), "x", tile.x(), "y", tile.y(), "width", tile.width(), "height", tile.height()));
                        segments.add(segment);
                        completedSegments++; progress.accept(new Progress(index, entries.size(), completedSegments, totalSegments));
                    }
                    Map<String, Object> page = new LinkedHashMap<>();
                    page.putAll(Map.of("index", index, "width", dimensions[0], "height", dimensions[1], "mediaType", "image/webp", "segments", segments));
                    if (segments.size() == 1) page.put("slug", segments.getFirst().get("slug"));
                    if (index == 0) {
                        Path thumb = scratch.resolve("p000001-thumbnail.webp");
                        Path raster = scratch.resolve("thumbnail-source.png");
                        try { VipsImageSource.thumbnail(source, raster); convert(raster, thumb, "format=rgba"); }
                        finally { Files.deleteIfExists(raster); }
                        int[] size = dimensions(thumb); Map<String, Object> thumbnail = new LinkedHashMap<>(file(thumb));
                        thumbnail.putAll(Map.of("width", size[0], "height", size[1])); page.put("thumbnail", thumbnail);
                    }
                    pages.add(page); progress.accept(new Progress(index + 1, entries.size(), completedSegments, totalSegments));
                } finally { Files.deleteIfExists(source); }
            }
        }
        Map<String, Object> bundle = Map.of("schemaVersion", 2, "format", "webp", "mediaType", "image/webp", "encoder", "ffmpeg/libwebp",
            "profile", json.convertValue(profile, Map.class), "pageCount", pages.size(), "pages", pages);
        Path metadata = scratch.resolve("bundle.json"); json.writeValue(metadata.toFile(), bundle);
        Path artifact = scratch.resolve("artifact.zip");
        try (ZipOutputStream out = new ZipOutputStream(Files.newOutputStream(artifact))) {
            List<Path> files;
            try (var stream = Files.list(scratch)) { files = stream.filter(p -> p.equals(metadata) || p.getFileName().toString().endsWith(".webp")).sorted().toList(); }
            for (Path file : files) { out.putNextEntry(new ZipEntry(file.getFileName().toString())); Files.copy(file, out); out.closeEntry(); }
        }
        return artifact;
    }

    /**
     * Produce lossy quality85/method4 WebP, then decode it before reporting success.
     * @param source original worker-local image
     * @param target derived segment or whole-logical-page thumbnail
     * @param filter fixed geometry filter
     * @throws IOException when encode or decode fails
     * @throws InterruptedException when conversion is cancelled
     */
    private void convert(Path source, Path target, String filter) throws IOException, InterruptedException {
        MediaProcess.run(List.of("ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-filter_threads", "1", "-threads", "2", "-i", source.toString(),
            "-frames:v", "1", "-vf", filter, "-c:v", "libwebp", "-quality", "85", "-compression_level", "4", "-lossless", "0", "-threads", "2", "-f", "webp", target.toString()), false);
        MediaProcess.run(List.of("ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2", "-i", target.toString(), "-frames:v", "1", "-f", "null", "-"), false);
        if (Files.size(target) <= 12) throw new IOException("Converted WebP is empty.");
    }

    /**
     * Probe dimensions without loading decoded pixels into the Java heap.
     * @param source worker-local source image
     * @return exact width and height
     * @throws IOException when metadata is missing or malformed
     * @throws InterruptedException when probing is cancelled
     */
    private int[] dimensions(Path source) throws IOException, InterruptedException {
        return VipsImageSource.dimensions(source);
    }

    /** @param file worker output @return immutable file identity @throws IOException when output cannot be read */
    private static Map<String, Object> file(Path file) throws IOException { return Map.of("slug", file.getFileName().toString(), "size", Files.size(file), "sha256", sha256(file)); }

    /** @param file bounded local file @return SHA256 fingerprint @throws IOException when reading fails */
    public static String sha256(Path file) throws IOException {
        try { MessageDigest hash = MessageDigest.getInstance("SHA-256"); try (InputStream in = Files.newInputStream(file)) { byte[] buffer = new byte[65536]; int read; while ((read = in.read(buffer)) >= 0) hash.update(buffer, 0, read); } return HexFormat.of().formatHex(hash.digest()); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    /** @param name source ZIP entry @return safe codec hint extension */
    private static String extension(String name) { String suffix = name.substring(name.lastIndexOf('.')).toLowerCase(Locale.ROOT); return suffix.matches("\\.[a-z0-9]{2,5}") ? suffix : ".img"; }

    /** @param in untrusted decompressed bytes @param target private new file @param expected declared exact length @param maximum actual byte ceiling @throws IOException when length or budget differs */
    public static void copyBounded(InputStream in, Path target, long expected, long maximum) throws IOException {
        long bytes = 0; try (var out = Files.newOutputStream(target)) { byte[] buffer = new byte[65536]; int count; while ((count = in.read(buffer)) >= 0) { bytes += count; if (bytes > maximum || bytes > expected) throw new IOException("Archive entry exceeds its actual byte budget."); out.write(buffer, 0, count); } }
        if (bytes != expected) throw new IOException("Archive entry length differs from its declaration.");
    }

    /** Actual worker conversion counters; physical tiles never replace logical page positions. */
    public record Progress(int completedLogicalPages, int totalLogicalPages, int completedSegments, int totalSegments) { }
}
