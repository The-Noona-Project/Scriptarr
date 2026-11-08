package com.scriptarr.raven.library;

import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * AVIF transcoder that selects a tested NVIDIA or software FFmpeg backend.
 */
@Component
public final class FfmpegAvifTranscoder implements PageTranscoder {
    private static final int TRANSCODE_TIMEOUT_SECONDS = 120;
    private static final Duration PROCESS_STOP_TIMEOUT = Duration.ofSeconds(5);
    private static final byte[] SELF_TEST_PPM = (
        "P6\n2 2\n255\n"
    ).getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    private final String policy;
    private final int cpuThreads;
    private final FfmpegExecutor executor;
    private volatile Readiness cachedReadiness;
    private volatile String selectedEncoder;

    /**
     * Create the production transcoder from Raven's environment.
     */
    public FfmpegAvifTranscoder() {
        this(System.getenv(), FfmpegAvifTranscoder::runProcess);
    }

    /**
     * Create a production process runner with explicit environment settings.
     *
     * @param env environment settings
     */
    FfmpegAvifTranscoder(Map<String, String> env) {
        this(env, FfmpegAvifTranscoder::runProcess);
    }

    /**
     * Create a transcoder with explicit configuration and process execution.
     *
     * @param env environment settings
     * @param executor bounded FFmpeg process executor
     */
    FfmpegAvifTranscoder(Map<String, String> env, FfmpegExecutor executor) {
        String configuredPolicy = Optional.ofNullable(env.get("SCRIPTARR_RAVEN_AVIF_ENCODER")).orElse("").trim().toLowerCase(Locale.ROOT);
        policy = configuredPolicy.isBlank() ? "auto" : configuredPolicy;
        if (!List.of("auto", "nvenc", "cpu").contains(policy)) {
            throw new IllegalArgumentException("SCRIPTARR_RAVEN_AVIF_ENCODER must be auto, nvenc, or cpu.");
        }
        cpuThreads = configuredCpuThreads(env.get("SCRIPTARR_RAVEN_AVIF_THREADS"));
        this.executor = executor;
    }

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
        readiness();
        return selectedEncoder == null ? "ffmpeg/unavailable" : "ffmpeg/" + selectedEncoder;
    }

    @Override
    public String runtimeProfile() {
        readiness();
        return requiresNvidiaRuntime() ? "nvidia-avif" : "libaom-av1".equals(selectedEncoder) ? "cpu-avif" : "avif";
    }

    @Override
    public boolean requiresNvidiaRuntime() {
        readiness();
        return "nvenc".equals(policy) || "av1_nvenc".equals(selectedEncoder);
    }

    @Override
    public Readiness readiness() {
        Readiness existing = cachedReadiness;
        if (existing != null) {
            return existing;
        }
        synchronized (this) {
            if (cachedReadiness == null) {
                Readiness probed = selectBackend();
                if (Thread.currentThread().isInterrupted()) {
                    return new Readiness(false, "encoder_unavailable", "AVIF encoder probing was interrupted; readiness will retry.");
                }
                cachedReadiness = probed;
            }
            return cachedReadiness;
        }
    }

    @Override
    public void transcode(byte[] inputBytes, String sourceMediaType, Path outputPath, int quality) throws IOException, InterruptedException {
        if (inputBytes == null || inputBytes.length == 0) {
            throw new IOException("Source page is empty.");
        }
        Files.createDirectories(outputPath.getParent());
        Path sourcePath = outputPath.getParent().resolve(UUID.randomUUID() + sourceExtension(sourceMediaType));
        try {
            Files.write(sourcePath, inputBytes);
            transcodeFile(sourcePath, sourceMediaType, outputPath, quality);
        } finally {
            Files.deleteIfExists(sourcePath);
        }
    }

    @Override
    public void transcodeFile(Path inputPath, String sourceMediaType, Path outputPath, int quality)
        throws IOException, InterruptedException {
        Readiness ready = readiness();
        if (!ready.ready()) {
            throw new IOException(ready.message().isBlank() ? ready.code() : ready.message());
        }
        if (inputPath == null || !Files.exists(inputPath) || Files.size(inputPath) <= 0L) {
            throw new IOException("Source page is empty.");
        }
        Files.createDirectories(outputPath.getParent());
        boolean complete = false;
        try {
            runFfmpeg(inputPath, outputPath, quality, selectedEncoder);
            validateAvifOutput(outputPath);
            complete = true;
        } finally {
            if (!complete) {
                Files.deleteIfExists(outputPath);
            }
        }
    }

    private Readiness selectBackend() {
        if (!"cpu".equals(policy) && selfTest("av1_nvenc")) {
            selectedEncoder = "av1_nvenc";
            return Readiness.ok();
        }
        if ("nvenc".equals(policy)) {
            return new Readiness(false, "encoder_unavailable", "NVIDIA AV1 encoding is unavailable. Check the GPU and driver or select auto or cpu encoding.");
        }
        if (!Thread.currentThread().isInterrupted() && selfTest("libaom-av1")) {
            selectedEncoder = "libaom-av1";
            return Readiness.ok();
        }
        return new Readiness(false, "encoder_unavailable", "AVIF encoding is unavailable. Install FFmpeg with libaom-av1 and the AVIF muxer, or provide a usable NVIDIA AV1 encoder.");
    }

    private boolean selfTest(String encoder) {
        Path tempDir = null;
        try {
            tempDir = Files.createTempDirectory("raven-avif-selftest-");
            Path source = tempDir.resolve("selftest.ppm");
            Path output = tempDir.resolve("selftest.avif");
            Files.write(source, appendSelfTestPixels());
            runFfmpeg(source, output, 50, encoder);
            validateAvifOutput(output);
            return true;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        } catch (IOException error) {
            return false;
        } finally {
            deleteTreeQuietly(tempDir);
        }
    }

    private void runFfmpeg(Path sourcePath, Path outputPath, int quality, String encoder) throws IOException, InterruptedException {
        int boundedQuality = Math.max(1, Math.min(100, quality));
        List<String> command = new ArrayList<>(List.of(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-filter_threads", "1", "-i", sourcePath.toString(), "-frames:v", "1",
            "-vf", "pad=max(256\\,ceil(iw/2)*2):max(256\\,ceil(ih/2)*2):0:0:color=white,format=yuv420p",
            "-c:v", encoder
        ));
        if ("libaom-av1".equals(encoder)) {
            int crf = Math.max(0, Math.min(63, 63 - Math.round(boundedQuality * 0.63f)));
            command.addAll(List.of("-crf", Integer.toString(crf), "-cpu-used", "8", "-still-picture", "1", "-row-mt", "1", "-threads", Integer.toString(cpuThreads)));
        } else {
            int cq = Math.max(1, Math.min(51, 63 - Math.round(boundedQuality * 0.45f)));
            command.addAll(List.of("-cq", Integer.toString(cq)));
        }
        command.addAll(List.of("-b:v", "0", "-f", "avif", outputPath.toString()));
        executor.run(List.copyOf(command));
    }

    private static void runProcess(List<String> command) throws IOException, InterruptedException {
        Process process = new ProcessBuilder(command)
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .start();
        try {
            if (!process.waitFor(TRANSCODE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                throw new IOException("FFmpeg timed out while converting a reader page to AVIF.");
            }
            if (process.exitValue() != 0) {
                throw new IOException("FFmpeg failed to create an AVIF page with the selected encoder.");
            }
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
                process.waitFor(PROCESS_STOP_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
            }
        }
    }

    private static int configuredCpuThreads(String raw) {
        try {
            return Math.max(1, Math.min(16, Integer.parseInt(raw == null ? "2" : raw.trim())));
        } catch (NumberFormatException ignored) {
            return 2;
        }
    }

    private void validateAvifOutput(Path outputPath) throws IOException {
        if (!Files.exists(outputPath) || Files.size(outputPath) < 16L) {
            throw new IOException("FFmpeg failed to create a valid AVIF page.");
        }
        byte[] header = new byte[(int) Math.min(64L, Files.size(outputPath))];
        try (InputStream stream = Files.newInputStream(outputPath)) {
            int read = stream.readNBytes(header, 0, header.length);
            if (read < 16) {
                throw new IOException("FFmpeg created an incomplete AVIF page.");
            }
        }
        String sample = new String(header, java.nio.charset.StandardCharsets.ISO_8859_1).toLowerCase(Locale.ROOT);
        if (!sample.contains("ftyp") || !sample.contains("avif")) {
            throw new IOException("FFmpeg created a page that is not an AVIF file.");
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

    /**
     * Runs one bounded FFmpeg conversion command.
     */
    @FunctionalInterface
    interface FfmpegExecutor {
        /**
         * Execute the encoder command or throw on failure.
         *
         * @param command FFmpeg executable and arguments
         * @throws IOException when FFmpeg fails
         * @throws InterruptedException when conversion is interrupted
         */
        void run(List<String> command) throws IOException, InterruptedException;
    }
}
