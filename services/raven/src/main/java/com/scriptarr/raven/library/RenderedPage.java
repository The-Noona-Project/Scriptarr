package com.scriptarr.raven.library;

/**
 * Binary reader page payload paired with its media type.
 */
public record RenderedPage(
    byte[] bytes,
    String mediaType,
    int segmentIndex,
    boolean thumbnail
) {
    /** @param bytes encoded page @param mediaType saved MIME */
    public RenderedPage(byte[] bytes, String mediaType) { this(bytes, mediaType, 0, false); }
}
