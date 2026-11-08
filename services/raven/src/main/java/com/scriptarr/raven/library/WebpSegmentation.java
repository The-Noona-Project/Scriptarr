package com.scriptarr.raven.library;

import java.util.ArrayList;
import java.util.List;

/** Exact full-resolution tiling for WebP's dimension limit, preserving logical pages. */
public final class WebpSegmentation {
    /** Maximum encoded width and height supported by WebP. */
    public static final int MAX_DIMENSION = 16383;
    /** Bound each physical raster independently of WebP's side-length limit and native decoder integer guards. */
    public static final long MAX_TILE_PIXELS = 64L * 1024 * 1024;

    /** Prevent construction of this stateless geometry helper. */
    private WebpSegmentation() { }

    /**
     * Cover a logical source page without overlap, omission, resizing or cropping away content.
     * @param width original page width
     * @param height original page height
     * @return row-major rectangles, each encodable as one WebP
     */
    public static List<Rectangle> split(int width, int height) {
        return split(width, height, 2);
    }

    /** @param width logical source width @param height logical source height @param version saved segmentation profile @return exact versioned coverage without altering old manifests */
    public static List<Rectangle> split(int width, int height, int version) {
        if (version != 1 && version != 2) throw new IllegalArgumentException("Unsupported saved segmentation version.");
        if (width <= 0 || height <= 0 || (long) width * height > 300_000_000L) {
            throw new IllegalArgumentException("Source image dimensions exceed the bounded worker image budget.");
        }
        List<Rectangle> result = new ArrayList<>();
        int tileWidth = Math.min(MAX_DIMENSION, width), tileHeight = version == 1 ? MAX_DIMENSION : Math.min(MAX_DIMENSION, (int) (MAX_TILE_PIXELS / tileWidth));
        if (((long) width + tileWidth - 1) / tileWidth * (((long) height + tileHeight - 1) / tileHeight) > 1024) throw new IllegalArgumentException("Logical page exceeds the bounded 1024-segment reader budget.");
        for (int y = 0; y < height; y += tileHeight) {
            for (int x = 0; x < width; x += tileWidth) {
                result.add(new Rectangle(result.size(), x, y, Math.min(tileWidth, width - x), Math.min(tileHeight, height - y)));
            }
        }
        return List.copyOf(result);
    }

    /** One segment's exact source rectangle in logical pixel coordinates. */
    public record Rectangle(int index, int x, int y, int width, int height) { }
}
