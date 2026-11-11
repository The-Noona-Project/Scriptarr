package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Source-bound quality evidence travels with retained CBZs; staged pages belong to one ordered page list. */
public final class ArchiveDownloadEvidence {
    private static final String ENTRY = "scriptarr-download-quality.json";
    private static final ObjectMapper JSON = new ObjectMapper();

    private ArchiveDownloadEvidence() { }

    /** @param pages ordered exact source URLs @return isolated staging identity for this page list */
    public static String pageListId(List<String> pages) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(JSON.writeValueAsString(pages).getBytes(StandardCharsets.UTF_8)));
        } catch (IOException | NoSuchAlgorithmException error) {
            throw new IllegalStateException("Could not identify the source page list.", error);
        }
    }

    /**
     * Write quality atomically with the archive containing its generated placeholders.
     * @param zip open chapter archive
     * @param source exact chapter URL
     * @param pages expected logical source pages
     * @param missing generated placeholder positions
     * @param notes source-quality diagnostics
     * @param status chapter quality state
     * @throws IOException when evidence cannot be saved
     */
    public static void write(ZipOutputStream zip, String source, int pages, List<Integer> missing, List<String> notes, String status) throws IOException {
        if (missing.isEmpty()) return;
        byte[] bytes = JSON.writeValueAsBytes(Map.of("version", 1, "source", source, "pages", pages,
            "missing", missing, "notes", notes, "status", status));
        if (bytes.length > 65536) throw new IOException("Archive quality evidence exceeds its limit.");
        zip.putNextEntry(new ZipEntry(ENTRY));
        zip.write(bytes);
        zip.closeEntry();
    }

    /**
     * Restore validated quality; legacy archives without evidence retain their existing catalog policy.
     * @param archive retained chapter archive
     * @param source expected exact chapter URL, or null during an unbound catalog scan
     * @param pages verified archive image count
     * @return quality evidence, or null if no embedded evidence exists
     * @throws IOException when existing evidence is malformed or belongs to another chapter
     */
    public static Quality read(Path archive, String source, int pages) throws IOException {
        try (ZipFile zip = new ZipFile(archive.toFile())) {
            ZipEntry entry = zip.getEntry(ENTRY);
            if (entry == null) return null;
            byte[] bytes;
            try (var input = zip.getInputStream(entry)) { bytes = input.readNBytes(65537); }
            if (bytes.length > 65536) throw new IOException("Retained archive quality evidence exceeds its limit.");
            var row = JSON.readTree(bytes);
            if (row == null || !row.isObject() || !row.path("version").isIntegralNumber() || row.path("version").asLong() != 1
                || !row.path("source").isTextual() || row.path("source").asText().isBlank()
                || (source != null && !source.equals(row.path("source").asText()))
                || !row.path("pages").isIntegralNumber() || !row.path("pages").canConvertToInt() || row.path("pages").asInt() != pages
                || !row.path("missing").isArray() || !row.path("notes").isArray()
                || !Set.of("possible_missing_page", "partial", "missing_content", "bad_source").contains(row.path("status").asText())) {
                throw new IOException("Retained archive quality evidence could not be verified.");
            }
            Set<Integer> missing = new LinkedHashSet<>();
            for (var value : row.path("missing")) {
                if (!value.isIntegralNumber() || !value.canConvertToInt() || value.asInt() < 1 || value.asInt() > pages || !missing.add(value.asInt())) {
                    throw new IOException("Retained archive missing-page positions could not be verified.");
                }
            }
            if (missing.isEmpty()) throw new IOException("Retained archive quality evidence has no missing pages.");
            List<String> notes = new ArrayList<>();
            for (var value : row.path("notes")) {
                if (!value.isTextual()) throw new IOException("Retained archive quality notes could not be verified.");
                notes.add(value.asText());
            }
            return new Quality(pages, List.copyOf(missing), List.copyOf(notes), row.path("status").asText());
        }
    }

    /**
     * Keep verified reader checkpoints while restoring archive quality from a scanned chapter.
     * @param target existing ready chapter
     * @param evidence chapter carrying validated archive quality
     * @return existing reader identity and checkpoints with restored source quality
     */
    public static LibraryChapter withQualityFrom(LibraryChapter target, LibraryChapter evidence) {
        return new LibraryChapter(target.id(), target.label(), target.chapterNumber(), target.pageCount(), target.releaseDate(),
            target.available(), target.archivePath(), target.sourceUrl(), evidence.qualityStatus(), evidence.expectedPageCount(),
            evidence.missingPageCount(), evidence.missingPages(), evidence.qualityNotes(), target.ingestStatus(), target.ingestRevision(),
            target.ingestedPageCount(), target.ingestedAt(), target.ingestError(), target.ingestManifestPath(), target.updatedAt())
            .preserveSegmentCheckpointFrom(target);
    }

    /** Validated source-quality facts carried by an archive rather than a transient task execution. */
    public record Quality(int pages, List<Integer> missing, List<String> notes, String status) { }
}
