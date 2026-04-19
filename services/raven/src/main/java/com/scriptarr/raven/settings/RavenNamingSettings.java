package com.scriptarr.raven.settings;

/**
 * Raven chapter and page naming settings loaded through Sage.
 *
 * @param chapterTemplate chapter archive naming template
 * @param pageTemplate page image naming template
 * @param pagePad page number padding width
 * @param chapterPad chapter number padding width
 * @param volumePad volume number padding width
 */
public record RavenNamingSettings(
    String chapterTemplate,
    String pageTemplate,
    int pagePad,
    int chapterPad,
    int volumePad
) {
    /**
     * The built-in Scriptarr chapter archive template.
     */
    public static final String DEFAULT_CHAPTER_TEMPLATE = "{title} c{chapter_padded} (v{volume_padded}) [Scriptarr].cbz";

    /**
     * The built-in Scriptarr page naming template.
     */
    public static final String DEFAULT_PAGE_TEMPLATE = "{page_padded}{ext}";

    /**
     * Default page-number padding.
     */
    public static final int DEFAULT_PAGE_PAD = 3;

    /**
     * Default chapter-number padding.
     */
    public static final int DEFAULT_CHAPTER_PAD = 3;

    /**
     * Default volume-number padding.
     */
    public static final int DEFAULT_VOLUME_PAD = 2;

    /**
     * Build the default Raven naming settings.
     *
     * @return default naming settings
     */
    public static RavenNamingSettings defaults() {
        return new RavenNamingSettings(
            DEFAULT_CHAPTER_TEMPLATE,
            DEFAULT_PAGE_TEMPLATE,
            DEFAULT_PAGE_PAD,
            DEFAULT_CHAPTER_PAD,
            DEFAULT_VOLUME_PAD
        );
    }

    /**
     * Normalize the template fields and padding widths.
     *
     * @return normalized naming settings
     */
    public RavenNamingSettings normalized() {
        return new RavenNamingSettings(
            normalizeTemplate(chapterTemplate, DEFAULT_CHAPTER_TEMPLATE, "{chapter}", "{chapter_padded}"),
            normalizeTemplate(pageTemplate, DEFAULT_PAGE_TEMPLATE, "{page}", "{page_padded}"),
            Math.max(1, pagePad),
            Math.max(1, chapterPad),
            Math.max(1, volumePad)
        );
    }

    private static String normalizeTemplate(String template, String fallback, String rawToken, String paddedToken) {
        String normalized = template == null ? "" : template.trim();
        if (normalized.isBlank()) {
            return fallback;
        }
        if (!normalized.contains(rawToken) && !normalized.contains(paddedToken)) {
            return fallback;
        }
        return normalized;
    }
}
