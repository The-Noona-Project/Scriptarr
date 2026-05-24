package com.scriptarr.raven.library;

import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * AVIF transcoder backed by FFmpeg and NVIDIA AV1 NVENC.
 */
@Component
public final class FfmpegAvifTranscoder implements PageTranscoder {
    private static final int TRANSCODE_TIMEOUT_SECONDS = 120;
    private static final Duration PROCESS_STOP_TIMEOUT = Duration.ofSeconds(5);
    private static final byte[] SELF_TEST_PPM = (
        "P6\n2 2\n255\n"
    ).getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    private volatile Readiness cachedReadiness;

    @Override
    public String format() {
        return "avif";
    }

    @Override
    public String fileExtension() {
        return ".avif";
    }

    @Override
    public String mediaType() {
        return "image/avif";
    }

    @Override
    public String encoderName() {
        return "ffmpeg/av1_nvenc";
    }

    @Override
    public Readiness readiness() {
        Readiness existing = cachedReadiness;
        if (existing != null) {
            return existing;
        }
        synchronized (this) {
            if (cachedReadiness == null) {
                cachedReadiness = runSelfTest();
            }
            return cachedReadiness;
        }
    }

    @Override
    public void transcode(byte[] inputBytes, String sourceMediaType, Path outputPath, int quality) throws IOException, InterruptedException {
        Readiness ready = readiness();
        if (!ready.ready()) {
            throw new IOException(ready.message().isBlank() ? ready.code() : ready.message());
        }
        if (inputBytes == null || inputBytes.length == 0) {
            throw new IOException("Source page is empty.");
        }
        Files.createDirectories(outputPath.getParent());
        Path sourcePath = outputPath.getParent().resolve(UUID.randomUUID() + sourceExtension(sourceMediaType));
        try {
            Files.write(sourcePath, inputBytes);
            runFfmpeg(sourcePath, outputPath, quality);
            validateAvifOutput(outputPath);
        } finally {
            Files.deleteIfExists(sourcePath);
        }
    }

    private Readiness runSelfTest() {
        Path tempDir = null;
        try {
            tempDir = Files.createTempDirectory("raven-avif-selftest-");
            Path source = tempDir.resolve("selftest.ppm");
            Path output = tempDir.resolve("selftest.avif");
            Files.write(source, appendSelfTestPixels());
            runFfmpeg(source, output, 50);
            validateAvifOutput(output);
            return Readiness.ok();
        } catch (Exception error) {
            return new Readiness(false, "encoder_unavailable", sanitizeError(error.getMessage()));
        } finally {
            deleteTreeQuietly(tempDir);
        }
    }

    private void runFfmpeg(Path sourcePath, Path outputPath, int quality) throws IOException, InterruptedException {
        int cq = Math.max(1, Math.min(51, 63 - Math.round(Math.max(1, Math.min(100, quality)) * 0.45f)));
        Process process = new ProcessBuilder(
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            sourcePath.toString(),
            "-frames:v",
            "1",
            "-vf",
            "pad=max(256\\,ceil(iw/2)*2):max(256\\,ceil(ih/2)*2):0:0:color=white,format=yuv420p",
            "-c:v",
            "av1_nvenc",
            "-cq",
            Integer.toString(cq),
            "-b:v",
            "0",
            "-f",
            "avif",
            outputPath.toString()
        )
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .start();
        if (!process.waitFor(TRANSCODE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            destroyAndWait(process);
            throw new IOException("ffmpeg timed out while converting a reader page to AVIF.");
        }
        if (process.exitValue() != 0) {
            throw new IOException("ffmpeg av1_nvenc failed to create an AVIF page.");
        }
    }

    private void destroyAndWait(Process process) throws InterruptedException {
        if (process == null || !process.isAlive()) {
            return;
        }
        process.destroyForcibly();
        process.waitFor(PROCESS_STOP_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
    }

    private void validateAvifOutput(Path outputPath) throws IOException {
        if (!Files.exists(outputPath) || Files.size(outputPath) < 16L) {
            throw new IOException("ffmpeg failed to create a valid AVIF page.");
        }
        byte[] header = new byte[(int) Math.min(64L, Files.size(outputPath))];
        try (InputStream stream = Files.newInputStream(outputPath)) {
            int read = stream.readNBytes(header, 0, header.length);
            if (read < 16) {
                throw new IOException("ffmpeg created an incomplete AVIF page.");
            }
        }
        String sample = new String(header, java.nio.charset.StandardCharsets.ISO_8859_1).toLowerCase(Locale.ROOT);
        if (!sample.contains("ftyp") || !sample.contains("avif")) {
            throw new IOException("ffmpeg created a page that is not an AVIF file.");
        }
    }

    private String sourceExtension(String mediaType) {
        String normalized = Optional.ofNullable(mediaType).orElse("").toLowerCase(Locale.ROOT);
        if (normalized.contains("png")) {
            return ".png";
        }
        if (normalized.contains("gif")) {
            return ".gif";
        }
        if (normalized.contains("webp")) {
            return ".webp";
        }
        if (normalized.contains("avif")) {
            return ".avif";
        }
        if (normalized.contains("ppm")) {
            return ".ppm";
        }
        return ".jpg";
    }

    private byte[] appendSelfTestPixels() {
        byte[] pixels = new byte[] {
            (byte) 255, 0, 0,
            0, (byte) 255, 0,
            0, 0, (byte) 255,
            (byte) 255, (byte) 255, (byte) 255
        };
        byte[] output = new byte[SELF_TEST_PPM.length + pixels.length];
        System.arraycopy(SELF_TEST_PPM, 0, output, 0, SELF_TEST_PPM.length);
        System.arraycopy(pixels, 0, output, SELF_TEST_PPM.length, pixels.length);
        return output;
    }

    private String sanitizeError(String value) {
        String normalized = Optional.ofNullable(value).orElse("AVIF encoder is unavailable.").replaceAll("[\\r\\n]+", " ").trim();
        return normalized.length() > 240 ? normalized.substring(0, 240) : normalized;
    }

    private void deleteTreeQuietly(Path root) {
        if (root == null || !Files.exists(root)) {
            return;
        }
        try (var paths = Files.walk(root)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach((path) -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                }
            });
        } catch (IOException ignored) {
        }
    }
}
