package com.scriptarr.raven.library;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Converts source image bytes into reader-ready derived page files.
 */
public interface PageTranscoder {
    /**
     * Return the lower-case derived image format key.
     *
     * @return format key
     */
    String format();

    /**
     * Return the output file extension including the leading dot.
     *
     * @return output extension
     */
    String fileExtension();

    /**
     * Return the HTTP media type for generated reader pages.
     *
     * @return media type
     */
    String mediaType();

    /**
     * Return the encoder label stored in manifests and hardware status.
     *
     * @return encoder label
     */
    String encoderName();

    /**
     * Check whether the transcoder can generate reader pages in this runtime.
     *
     * @return readiness result
     */
    Readiness readiness();

    /**
     * Return the selected runtime profile for ingest diagnostics.
     *
     * @return runtime profile key
     */
    default String runtimeProfile() {
        return format();
    }

    /**
     * Report whether the selected backend requires NVIDIA runtime access.
     *
     * @return whether NVIDIA runtime is required
     */
    default boolean requiresNvidiaRuntime() {
        return false;
    }

    /**
     * Convert one source page into a derived reader page.
     *
     * @param inputBytes source image bytes
     * @param sourceMediaType source image media type
     * @param outputPath target output path
     * @param quality lossy quality hint from 1 to 100
     * @throws IOException when conversion fails
     * @throws InterruptedException when interrupted while waiting for the encoder
     */
    void transcode(byte[] inputBytes, String sourceMediaType, Path outputPath, int quality) throws IOException, InterruptedException;

    /**
     * Convert one source page file into a derived reader page.
     *
     * <p>The default implementation preserves the byte-oriented contract for
     * lightweight tests and simple transcoders. Production transcoders should
     * override this method when they can stream directly from a source file.</p>
     *
     * @param inputPath source image path
     * @param sourceMediaType source image media type
     * @param outputPath target output path
     * @param quality lossy quality hint from 1 to 100
     * @throws IOException when conversion fails
     * @throws InterruptedException when interrupted while waiting for the encoder
     */
    default void transcodeFile(Path inputPath, String sourceMediaType, Path outputPath, int quality)
        throws IOException, InterruptedException {
        transcode(Files.readAllBytes(inputPath), sourceMediaType, outputPath, quality);
    }

    /**
     * Runtime readiness result for a derived page transcoder.
     *
     * @param ready whether the encoder can be used
     * @param code stable failure code or ready
     * @param message short diagnostic message
     */
    record Readiness(boolean ready, String code, String message) {
        /**
         * Build a successful readiness result.
         *
         * @return ready result
         */
        public static Readiness ok() {
            return new Readiness(true, "ready", "");
        }
    }
}
