package com.scriptarr.raven.library;

/**
 * Reader page descriptor for Moon's native comic reader.
 */
public record ReaderPage(
    int index,
    String label,
    String mediaType,
    int width,
    int height,
    java.util.List<java.util.Map<String, Object>> segments,
    java.util.Map<String, Object> thumbnail
) {
    /** @param index logical index @param label page label @param mediaType saved content type */
    public ReaderPage(int index, String label, String mediaType) { this(index, label, mediaType, 0, 0, java.util.List.of(), java.util.Map.of()); }
}
