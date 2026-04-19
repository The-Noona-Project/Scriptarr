package com.scriptarr.raven.library;

/**
 * Binary reader page payload paired with its media type.
 */
public record RenderedPage(
    byte[] bytes,
    String mediaType
) {
}
