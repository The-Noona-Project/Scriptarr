package com.scriptarr.raven.library;

import java.io.IOException;
import java.nio.file.Path;

/**
 * Converts source image bytes into reader-ready WebP files.
 */
public interface WebpTranscoder {
    /**
     * Convert one decoded source page into a WebP file.
     *
     * @param inputBytes source page bytes from the CBZ entry
     * @param sourceMediaType source image media type
     * @param outputPath target WebP path
     * @param quality lossy WebP quality from 1 to 100
     * @throws IOException when conversion fails
     * @throws InterruptedException when conversion is interrupted
     */
    void transcode(byte[] inputBytes, String sourceMediaType, Path outputPath, int quality) throws IOException, InterruptedException;
}
