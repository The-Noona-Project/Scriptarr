package com.scriptarr.raven.library;

import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * WebP transcoder backed by the official libwebp {@code cwebp} binary.
 */
@Component
public final class CwebpTranscoder implements WebpTranscoder {
    private static final int TRANSCODE_TIMEOUT_SECONDS = 90;
    private static final Duration PROCESS_STOP_TIMEOUT = Duration.ofSeconds(5);

    @Override
    public void transcode(byte[] inputBytes, String sourceMediaType, Path outputPath, int quality) throws IOException, InterruptedException {
        if (inputBytes == null || inputBytes.length == 0) {
            throw new IOException("Source page is empty.");
        }
        Files.createDirectories(outputPath.getParent());
        Path sourcePath = outputPath.getParent().resolve(UUID.randomUUID() + sourceExtension(sourceMediaType));
        try {
            Files.write(sourcePath, inputBytes);
            Process process = new ProcessBuilder(
                "cwebp",
                "-quiet",
                "-q",
                String.valueOf(Math.max(1, Math.min(100, quality))),
                sourcePath.toString(),
                "-o",
                outputPath.toString()
            )
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .start();
            try {
                if (!process.waitFor(TRANSCODE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    destroyAndWait(process);
                    throw new IOException("cwebp timed out while converting a reader page.");
                }
            } catch (InterruptedException interrupted) {
                InterruptedException cleanupInterruption = null;
                try {
                    destroyAndWait(process);
                } catch (InterruptedException cleanupError) {
                    cleanupInterruption = cleanupError;
                }
                if (cleanupInterruption != null) {
                    interrupted.addSuppressed(cleanupInterruption);
                }
                Thread.currentThread().interrupt();
                throw interrupted;
            }
            if (process.exitValue() != 0) {
                throw new IOException("cwebp failed to create a WebP page.");
            }
            validateWebpOutput(outputPath);
        } finally {
            Files.deleteIfExists(sourcePath);
        }
    }

    private void destroyAndWait(Process process) throws InterruptedException {
        if (process == null || !process.isAlive()) {
            return;
        }
        process.destroyForcibly();
        process.waitFor(PROCESS_STOP_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
    }

    private void validateWebpOutput(Path outputPath) throws IOException {
        if (!Files.exists(outputPath) || Files.size(outputPath) < 12L) {
            throw new IOException("cwebp failed to create a valid WebP page.");
        }
        byte[] header = new byte[12];
        try (InputStream stream = Files.newInputStream(outputPath)) {
            int read = stream.readNBytes(header, 0, header.length);
            if (read != header.length) {
                throw new IOException("cwebp created an incomplete WebP page.");
            }
        }
        boolean riff = header[0] == 'R' && header[1] == 'I' && header[2] == 'F' && header[3] == 'F';
        boolean webp = header[8] == 'W' && header[9] == 'E' && header[10] == 'B' && header[11] == 'P';
        if (!riff || !webp) {
            throw new IOException("cwebp created a page that is not a WebP file.");
        }
    }

    private String sourceExtension(String mediaType) {
        String normalized = mediaType == null ? "" : mediaType.toLowerCase(Locale.ROOT);
        if (normalized.contains("png")) {
            return ".png";
        }
        if (normalized.contains("gif")) {
            return ".gif";
        }
        if (normalized.contains("webp")) {
            return ".webp";
        }
        return ".jpg";
    }
}
