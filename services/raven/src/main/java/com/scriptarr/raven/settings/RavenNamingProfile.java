package com.scriptarr.raven.settings;

/**
 * Per-type Raven naming profile used for chapter archives and page files.
 *
 * @param chapterTemplate chapter archive naming template
 * @param pageTemplate page image naming template
 * @param pagePad page number padding width
 * @param chapterPad chapter number padding width
 * @param volumePad volume number padding width
 */
public record RavenNamingProfile(
    String chapterTemplate,
    String pageTemplate,
    int pagePad,
    int chapterPad,
    int volumePad
) {
    /**
     * Build the default naming profile.
     *
     * @return default profile
     */
    public static RavenNamingProfile defaults() {
        return new RavenNamingProfile(
            RavenNamingSettings.DEFAULT_CHAPTER_TEMPLATE,
            RavenNamingSettings.DEFAULT_PAGE_TEMPLATE,
            RavenNamingSettings.DEFAULT_PAGE_PAD,
            RavenNamingSettings.DEFAULT_CHAPTER_PAD,
            RavenNamingSettings.DEFAULT_VOLUME_PAD
        );
    }

    /**
     * Normalize the template fields and padding widths.
     *
     * @return normalized naming profile
     */
    public RavenNamingProfile normalized() {
        return new RavenNamingProfile(
            RavenNamingSettings.normalizeTemplate(chapterTemplate, RavenNamingSettings.DEFAULT_CHAPTER_TEMPLATE, "{chapter}", "{chapter_padded}"),
            RavenNamingSettings.normalizeTemplate(pageTemplate, RavenNamingSettings.DEFAULT_PAGE_TEMPLATE, "{page}", "{page_padded}"),
            Math.max(1, pagePad),
            Math.max(1, chapterPad),
            Math.max(1, volumePad)
        );
    }
}
