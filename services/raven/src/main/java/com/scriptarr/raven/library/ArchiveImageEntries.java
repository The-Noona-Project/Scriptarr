package com.scriptarr.raven.library;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

/** Shared source-image selection and integrity checks for canonical CBZ archives. */
public final class ArchiveImageEntries {
    private static final Set<String> EXTENSIONS = Set.of("jpg", "jpeg", "png", "gif", "webp", "avif");

    /** Prevent construction of this stateless archive helper. */
    private ArchiveImageEntries() {
    }

    /**
     * Identify a file name supported by the reader-page ingest pipeline.
     *
     * @param name archive entry name, or null
     * @return true for a supported image extension, independent of case
     */
    public static boolean isImage(String name) {
        if (name == null) {
            return false;
        }
        int dot = name.lastIndexOf('.');
        return dot >= 0 && EXTENSIONS.contains(name.substring(dot + 1).toLowerCase(Locale.ROOT));
    }

    /**
     * Count supported, non-directory image entries without decoding their data.
     *
     * @param archive canonical CBZ archive
     * @return supported image-entry count, including zero for metadata-only archives
     * @throws IOException when the archive directory cannot be read
     */
    public static int count(Path archive) throws IOException {
        try (ZipFile zip = new ZipFile(archive.toFile())) {
            long count = zip.stream().filter(entry -> !entry.isDirectory() && isImage(entry.getName())).count();
            if (count > Integer.MAX_VALUE) {
                throw new IOException("CBZ image count exceeds the supported range.");
            }
            return (int) count;
        }
    }

    /**
     * Verify the ZIP directory and stream every entry to validate its CRC and size.
     * Metadata entries do not count as pages, and supported images must be nonempty.
     * This checks archive integrity rather than decoding image contents.
     *
     * @param archive canonical CBZ archive
     * @return positive supported image count, or -1 for invalid or image-free archives
     */
    public static int verifiedCount(Path archive) {
        try {
            if (!Files.isRegularFile(archive) || Files.size(archive) == 0L) {
                return -1;
            }
            // ZipInputStream alone accepts a ZIP whose central directory was truncated.
            int expectedCount = count(archive);
            if (expectedCount <= 0) {
                return -1;
            }
            int count = 0;
            try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(archive))) {
                ZipEntry entry;
                while ((entry = zip.getNextEntry()) != null) {
                    boolean image = !entry.isDirectory() && isImage(entry.getName());
                    long bytes = zip.transferTo(OutputStream.nullOutputStream());
                    zip.closeEntry();
                    if (image) {
                        if (bytes == 0L) {
                            return -1;
                        }
                        count += 1;
                    }
                }
            }
            return count == expectedCount ? count : -1;
        } catch (IOException | RuntimeException error) {
            return -1;
        }
    }
}
