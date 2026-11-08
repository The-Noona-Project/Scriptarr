package com.scriptarr.raven.library;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Map;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Prove catalog, ingest and completion share one supported archive-image definition. */
class ArchiveImageEntriesTest {
    /**
     * Ignore ComicInfo and directory entries while counting one readable PNG entry.
     *
     * @param root temporary fixture root
     * @throws IOException when fixture IO fails
     */
    @Test
    void ignoresMetadataAndDirectories(@TempDir Path root) throws IOException {
        Path archive = writeArchive(root.resolve("metadata.cbz"), Map.of(
            "ComicInfo.xml", "<ComicInfo/>".getBytes(StandardCharsets.UTF_8),
            "pages/", new byte[0],
            "pages/001.PNG", new byte[]{1, 2, 3}
        ));
        assertEquals(1, ArchiveImageEntries.count(archive));
        assertEquals(1, ArchiveImageEntries.verifiedCount(archive));
    }

    /**
     * Keep every existing ingest format case-insensitive and consistently exclude BMP.
     *
     * @param root temporary fixture root
     * @throws IOException when fixture IO fails
     */
    @Test
    void supportsExistingIngestFormatsOnly(@TempDir Path root) throws IOException {
        for (String extension : new String[]{"JPG", "JPEG", "PNG", "GIF", "WEBP", "AVIF"}) {
            assertTrue(ArchiveImageEntries.isImage("nested/001." + extension));
        }
        assertFalse(ArchiveImageEntries.isImage("001.BMP"));
        assertFalse(ArchiveImageEntries.isImage("ComicInfo.xml"));
        assertFalse(ArchiveImageEntries.isImage(null));
        Path archive = writeArchive(root.resolve("formats.cbz"), Map.of(
            "1.JPG", new byte[]{1}, "2.JPEG", new byte[]{2}, "3.PNG", new byte[]{3},
            "4.GIF", new byte[]{4}, "5.WEBP", new byte[]{5}, "6.AVIF", new byte[]{6},
            "7.BMP", new byte[]{7}
        ));
        assertEquals(6, ArchiveImageEntries.count(archive));
        assertEquals(6, ArchiveImageEntries.verifiedCount(archive));
    }

    /**
     * Reject an empty supported image even when the ZIP directory lists it.
     *
     * @param root temporary fixture root
     * @throws IOException when fixture IO fails
     */
    @Test
    void rejectsEmptyImage(@TempDir Path root) throws IOException {
        Path archive = writeArchive(root.resolve("empty-image.cbz"), Map.of("001.png", new byte[0]));
        assertEquals(1, ArchiveImageEntries.count(archive));
        assertEquals(-1, ArchiveImageEntries.verifiedCount(archive));
    }

    /**
     * Read image data fully so a stored ZIP entry with a corrupt CRC cannot pass.
     *
     * @param root temporary fixture root
     * @throws IOException when fixture IO fails
     */
    @Test
    void rejectsCorruptImagePayload(@TempDir Path root) throws IOException {
        Path archive = root.resolve("corrupt-image.cbz");
        byte[] payload = "unique-image-payload-for-crc".getBytes(StandardCharsets.UTF_8);
        CRC32 crc = new CRC32();
        crc.update(payload);
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archive))) {
            ZipEntry entry = new ZipEntry("001.png");
            entry.setMethod(ZipEntry.STORED);
            entry.setSize(payload.length);
            entry.setCompressedSize(payload.length);
            entry.setCrc(crc.getValue());
            zip.putNextEntry(entry);
            zip.write(payload);
            zip.closeEntry();
        }
        byte[] damaged = Files.readAllBytes(archive);
        // A stored local header occupies 30 bytes followed by its ASCII filename.
        damaged[30 + "001.png".length()] ^= 1;
        Files.write(archive, damaged);
        assertEquals(1, ArchiveImageEntries.count(archive));
        assertEquals(-1, ArchiveImageEntries.verifiedCount(archive));
    }

    /**
     * Reject a truncated central directory even when local image data is complete.
     *
     * @param root temporary fixture root
     * @throws IOException when fixture IO fails
     */
    @Test
    void rejectsTruncatedArchive(@TempDir Path root) throws IOException {
        Path archive = writeArchive(root.resolve("truncated.cbz"), Map.of("001.png", new byte[]{1, 2, 3}));
        byte[] bytes = Files.readAllBytes(archive);
        Files.write(archive, Arrays.copyOf(bytes, bytes.length - 12));
        assertEquals(-1, ArchiveImageEntries.verifiedCount(archive));
        Path invalid = root.resolve("invalid.cbz");
        Files.writeString(invalid, "not a ZIP archive");
        assertEquals(-1, ArchiveImageEntries.verifiedCount(invalid));
        assertEquals(-1, ArchiveImageEntries.verifiedCount(root.resolve("absent.cbz")));
    }

    /**
     * Metadata-only archives have zero supported pages and cannot establish completion.
     *
     * @param root temporary fixture root
     * @throws IOException when fixture IO fails
     */
    @Test
    void rejectsMetadataOnlyArchives(@TempDir Path root) throws IOException {
        Path archive = writeArchive(root.resolve("metadata-only.cbz"), Map.of(
            "ComicInfo.xml", "<ComicInfo/>".getBytes(StandardCharsets.UTF_8),
            "cover.bmp", new byte[]{1, 2, 3}
        ));
        assertEquals(0, ArchiveImageEntries.count(archive));
        assertEquals(-1, ArchiveImageEntries.verifiedCount(archive));
    }

    /**
     * Write small deterministic ZIP entry contents without requiring image decoding.
     *
     * @param archive destination fixture archive
     * @param entries names and contents to store
     * @return written archive path
     * @throws IOException when fixture IO fails
     */
    private static Path writeArchive(Path archive, Map<String, byte[]> entries) throws IOException {
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(archive))) {
            for (Map.Entry<String, byte[]> value : entries.entrySet()) {
                zip.putNextEntry(new ZipEntry(value.getKey()));
                zip.write(value.getValue());
                zip.closeEntry();
            }
        }
        return archive;
    }
}
