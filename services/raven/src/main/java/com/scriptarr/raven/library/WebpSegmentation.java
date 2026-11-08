package com.scriptarr.raven.library;

import java.util.ArrayList;
import java.util.List;

/** Exact full-resolution tiling for WebP's dimension limit, preserving logical pages. */
public final class WebpSegmentation {
    /** Maximum encoded width and height supported by WebP. */
    public static final int MAX_DIMENSION = 16383;

    /** Prevent construction of this stateless geometry helper. */
    private WebpSegmentation() { }

    /**
     * Cover a logical source page without overlap, omission, resizing or cropping away content.
     * @param width original page width
     * @param height original page height
     * @return row-major rectangles, each encodable as one WebP
     */
    public static List<Rectangle> split(int width, int height) {
        if (width <= 0 || height <= 0 || (long) width * height > 300_000_000L) {
            throw new IllegalArgumentException("Source image dimensions exceed the bounded worker image budget.");
        }
        List<Rectangle> result = new ArrayList<>();
        if (((long) width + MAX_DIMENSION - 1) / MAX_DIMENSION * (((long) height + MAX_DIMENSION - 1) / MAX_DIMENSION) > 1024) throw new IllegalArgumentException("Logical page exceeds the bounded 1024-segment reader budget.");
        for (int y = 0; y < height; y += MAX_DIMENSION) {
            for (int x = 0; x < width; x += MAX_DIMENSION) {
                result.add(new Rectangle(result.size(), x, y, Math.min(MAX_DIMENSION, width - x), Math.min(MAX_DIMENSION, height - y)));
            }
        }
        return List.copyOf(result);
    }

    /** One segment's exact source rectangle in logical pixel coordinates. */
    public record Rectangle(int index, int x, int y, int width, int height) { }
}
