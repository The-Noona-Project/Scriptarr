package com.scriptarr.raven.library;

/**
 * Reader page descriptor for Moon's native comic reader.
 */
public record ReaderPage(
    int index,
    String label,
    String mediaType
) {
}
