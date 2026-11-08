package com.scriptarr.raven.library;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Tests backend capability selection, stable output, and failure cleanup.
 */
class FfmpegAvifTranscoderTest {
    /** Verify an explicitly blank encoder setting uses the documented automatic default. */
    @Test
    void blankEncoderPolicyUsesAuto() {
        FfmpegAvifTranscoder transcoder = new FfmpegAvifTranscoder(Map.of("SCRIPTARR_RAVEN_AVIF_ENCODER", "  "), command -> writeAvif(command));
        assertTrue(transcoder.readiness().ready());
        assertEquals("ffmpeg/av1_nvenc", transcoder.encoderName());
    }

    /** Verify cancelling the initial capability check does not poison subsequent healthy checks. */
    @Test
    void interruptedFirstProbeIsNotPermanentlyCached() {
        AtomicInteger attempts = new AtomicInteger();
        FfmpegAvifTranscoder transcoder = new FfmpegAvifTranscoder(Map.of(), command -> {
            if (attempts.incrementAndGet() == 1) throw new InterruptedException("Cancelled probe.");
            writeAvif(command);
        });
        try {
            assertFalse(transcoder.readiness().ready());
            assertTrue(Thread.currentThread().isInterrupted());
        } finally { Thread.interrupted(); }
        assertTrue(transcoder.readiness().ready());
        assertEquals(2, attempts.get());
    }
    /**
     * Verify an unsupported NVIDIA AV1 encoder selects and retains CPU mode.
     *
     * @param tempDir temporary fixture root
     * @throws Exception when fixture IO fails
     */
    @Test
    void autoFallsBackToCpuAndKeepsSelectedBackend(@TempDir Path tempDir) throws Exception {
        List<String> attempts = new ArrayList<>();
        FfmpegAvifTranscoder transcoder = new FfmpegAvifTranscoder(Map.of(), command -> {
            String encoder = encoder(command);
            attempts.add(encoder);
            if ("av1_nvenc".equals(encoder)) {
                throw new IOException("This GPU cannot encode AV1.");
            }
            assertEquals("2", command.get(command.indexOf("-threads") + 1));
            writeAvif(command);
        });
        assertTrue(transcoder.readiness().ready());
        assertEquals("ffmpeg/libaom-av1", transcoder.encoderName());
        assertEquals("cpu-avif", transcoder.runtimeProfile());
        assertFalse(transcoder.requiresNvidiaRuntime());
        transcoder.transcode(new byte[] {1}, "image/png", tempDir.resolve("page.avif"), 50);
        assertEquals(List.of("av1_nvenc", "libaom-av1", "libaom-av1"), attempts);
    }

    /**
     * Verify automatic mode retains usable NVIDIA encoding.
     */
    @Test
    void autoPrefersNvencWhenRealProbeSucceeds() {
        List<String> attempts = new ArrayList<>();
        FfmpegAvifTranscoder transcoder = new FfmpegAvifTranscoder(Map.of(), command -> {
            attempts.add(encoder(command));
            writeAvif(command);
        });
        assertTrue(transcoder.readiness().ready());
        assertEquals("ffmpeg/av1_nvenc", transcoder.encoderName());
        assertEquals("nvidia-avif", transcoder.runtimeProfile());
        assertTrue(transcoder.requiresNvidiaRuntime());
        assertEquals(List.of("av1_nvenc"), attempts);
    }

    /**
     * Verify strict NVIDIA policy cannot silently fall back to software.
     */
    @Test
    void strictNvencNeverFallsBack() {
        List<String> attempts = new ArrayList<>();
        FfmpegAvifTranscoder transcoder = new FfmpegAvifTranscoder(Map.of("SCRIPTARR_RAVEN_AVIF_ENCODER", "nvenc"), command -> {
            attempts.add(encoder(command));
            throw new IOException("No NVIDIA driver.");
        });
        assertFalse(transcoder.readiness().ready());
        assertEquals("encoder_unavailable", transcoder.readiness().code());
        assertTrue(transcoder.readiness().message().contains("auto or cpu"));
        assertTrue(transcoder.requiresNvidiaRuntime());
        assertEquals(List.of("av1_nvenc"), attempts);
    }

    /**
     * Verify CPU policy has no GPU dependency and clamps encoder threads.
     */
    @Test
    void cpuModeNeverProbesNvidiaAndBoundsThreads() {
        List<String> attempts = new ArrayList<>();
        FfmpegAvifTranscoder transcoder = new FfmpegAvifTranscoder(Map.of(
            "SCRIPTARR_RAVEN_AVIF_ENCODER", "cpu", "SCRIPTARR_RAVEN_AVIF_THREADS", "999"
        ), command -> {
            attempts.add(encoder(command));
            assertEquals("16", command.get(command.indexOf("-threads") + 1));
            writeAvif(command);
        });
        assertTrue(transcoder.readiness().ready());
        assertFalse(transcoder.requiresNvidiaRuntime());
        assertEquals(List.of("libaom-av1"), attempts);
    }

    /**
     * Verify unavailable encoders return a useful status and invalid policy
     * cannot accidentally activate another encoder.
     */
    @Test
    void missingEncodersAndInvalidPolicyAreExplicit() {
        FfmpegAvifTranscoder transcoder = new FfmpegAvifTranscoder(Map.of(), command -> {
            throw new IOException("Missing encoder.");
        });
        assertFalse(transcoder.readiness().ready());
        assertTrue(transcoder.readiness().message().contains("libaom-av1"));
        assertEquals("ffmpeg/unavailable", transcoder.encoderName());
        assertThrows(IllegalArgumentException.class, () -> new FfmpegAvifTranscoder(
            Map.of("SCRIPTARR_RAVEN_AVIF_ENCODER", "unexpected"), command -> writeAvif(command)
        ));
    }

    /**
     * Verify a selected backend failing later cannot switch encoder halfway
     * through a chapter and partial conversion output is removed.
     *
     * @param tempDir temporary fixture root
     * @throws Exception when fixture IO fails
     */
    @Test
    void conversionFailureDoesNotSwitchBackendAndCleansFiles(@TempDir Path tempDir) throws Exception {
        AtomicInteger calls = new AtomicInteger();
        FfmpegAvifTranscoder transcoder = new FfmpegAvifTranscoder(Map.of(), command -> {
            assertEquals("av1_nvenc", encoder(command));
            writeAvif(command);
            if (calls.incrementAndGet() > 1) {
                throw new IOException("Encoder failed after selection.");
            }
        });
        assertTrue(transcoder.readiness().ready());
        assertThrows(IOException.class, () -> transcoder.transcode(new byte[] {1}, "image/jpeg", tempDir.resolve("page.avif"), 50));
        assertEquals("ffmpeg/av1_nvenc", transcoder.encoderName());
        try (var paths = Files.list(tempDir)) {
            assertEquals(0L, paths.count());
        }
    }

    /**
     * Verify interrupted conversion removes temporary source and output files.
     *
     * @param tempDir temporary fixture root
     * @throws Exception when fixture IO fails
     */
    @Test
    void interruptedConversionCleansFiles(@TempDir Path tempDir) throws Exception {
        AtomicInteger calls = new AtomicInteger();
        FfmpegAvifTranscoder transcoder = new FfmpegAvifTranscoder(Map.of("SCRIPTARR_RAVEN_AVIF_ENCODER", "cpu"), command -> {
            writeAvif(command);
            if (calls.incrementAndGet() > 1) {
                throw new InterruptedException("Cancelled.");
            }
        });
        assertTrue(transcoder.readiness().ready());
        assertThrows(InterruptedException.class, () -> transcoder.transcode(new byte[] {1}, "image/png", tempDir.resolve("page.avif"), 50));
        try (var paths = Files.list(tempDir)) {
            assertEquals(0L, paths.count());
        }
    }

    /**
     * Exercise the production CPU process runner when the test environment has
     * FFmpeg. The runtime image additionally runs this contract during build.
     *
     * @param tempDir temporary fixture root
     * @throws Exception when fixture IO or real conversion fails
     */
    @Test
    void realCpuEncoderHandlesOddJpegPngAndTallPages(@TempDir Path tempDir) throws Exception {
        assumeTrue(ffmpegAvailable());
        FfmpegAvifTranscoder transcoder = new FfmpegAvifTranscoder(Map.of("SCRIPTARR_RAVEN_AVIF_ENCODER", "cpu"));
        assertTrue(transcoder.readiness().ready(), transcoder.readiness().message());
        for (String fixture : List.of("jpg:257:513", "png:257:513", "png:257:2049")) {
            String[] parts = fixture.split(":");
            int width = Integer.parseInt(parts[1]);
            int height = Integer.parseInt(parts[2]);
            Path source = tempDir.resolve("source." + parts[0]);
            Path output = tempDir.resolve("page.avif");
            assertTrue(ImageIO.write(new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB), parts[0], source.toFile()));
            transcoder.transcodeFile(source, "image/" + parts[0], output, 50);
            Process decode = new ProcessBuilder("ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", output.toString(), "-frames:v", "1", "-f", "null", "-")
                .redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
            try {
                assertTrue(decode.waitFor(30, TimeUnit.SECONDS));
                assertEquals(0, decode.exitValue());
            } finally {
                decode.destroyForcibly();
            }
        }
    }

    private static String encoder(List<String> command) {
        return command.get(command.indexOf("-c:v") + 1);
    }

    private static void writeAvif(List<String> command) throws IOException {
        Files.write(Path.of(command.getLast()), "00000000ftypavif0000".getBytes(StandardCharsets.US_ASCII));
    }

    private static boolean ffmpegAvailable() {
        try {
            Process process = new ProcessBuilder("ffmpeg", "-version").redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectErrorStream(true).start();
            try {
                return process.waitFor(5, TimeUnit.SECONDS) && process.exitValue() == 0;
            } finally {
                process.destroyForcibly();
            }
        } catch (IOException | InterruptedException ignored) {
            return false;
        }
    }
}
