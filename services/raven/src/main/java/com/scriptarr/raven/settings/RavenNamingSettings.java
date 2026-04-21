package com.scriptarr.raven.settings;

import com.scriptarr.raven.library.LibraryNaming;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Raven chapter and page naming settings loaded through Sage.
 *
 * @param chapterTemplate default chapter archive naming template
 * @param pageTemplate default page image naming template
 * @param pagePad default page number padding width
 * @param chapterPad default chapter number padding width
 * @param volumePad default volume number padding width
 * @param profiles per-type naming profiles keyed by normalized type slug
 */
public record RavenNamingSettings(
    String chapterTemplate,
    String pageTemplate,
    int pagePad,
    int chapterPad,
    int volumePad,
    Map<String, RavenNamingProfile> profiles
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
     * Known Moon and Raven library types that should always have a naming
     * profile available.
     */
    public static final java.util.List<String> KNOWN_TYPE_SLUGS = java.util.List.of(
        "manga",
        "manhwa",
        "manhua",
        "webtoon",
        "comic",
        "oel"
    );

    /**
     * Backward-compatible constructor for call sites that only need the
     * original global settings.
     *
     * @param chapterTemplate default chapter archive naming template
     * @param pageTemplate default page image naming template
     * @param pagePad default page number padding width
     * @param chapterPad default chapter number padding width
     * @param volumePad default volume number padding width
     */
    public RavenNamingSettings(
        String chapterTemplate,
        String pageTemplate,
        int pagePad,
        int chapterPad,
        int volumePad
    ) {
        this(chapterTemplate, pageTemplate, pagePad, chapterPad, volumePad, Map.of());
    }

    /**
     * Build the default Raven naming settings.
     *
     * @return default naming settings
     */
    public static RavenNamingSettings defaults() {
        RavenNamingProfile defaults = RavenNamingProfile.defaults();
        return new RavenNamingSettings(
            DEFAULT_CHAPTER_TEMPLATE,
            DEFAULT_PAGE_TEMPLATE,
            DEFAULT_PAGE_PAD,
            DEFAULT_CHAPTER_PAD,
            DEFAULT_VOLUME_PAD,
            defaultProfiles(defaults)
        );
    }

    /**
     * Normalize the template fields and padding widths.
     *
     * @return normalized naming settings
     */
    public RavenNamingSettings normalized() {
        RavenNamingProfile normalizedDefaults = new RavenNamingProfile(
            normalizeTemplate(chapterTemplate, DEFAULT_CHAPTER_TEMPLATE, "{chapter}", "{chapter_padded}"),
            normalizeTemplate(pageTemplate, DEFAULT_PAGE_TEMPLATE, "{page}", "{page_padded}"),
            Math.max(1, pagePad),
            Math.max(1, chapterPad),
            Math.max(1, volumePad)
        ).normalized();

        Map<String, RavenNamingProfile> normalizedProfiles = new LinkedHashMap<>();
        defaultProfiles(normalizedDefaults).forEach(normalizedProfiles::put);
        for (Map.Entry<String, RavenNamingProfile> entry : profilesOrEmpty().entrySet()) {
            String typeSlug = normalizeTypeSlug(entry.getKey());
            if (typeSlug.isBlank()) {
                continue;
            }
            normalizedProfiles.put(typeSlug, mergeProfile(normalizedDefaults, entry.getValue()));
        }

        return new RavenNamingSettings(
            normalizedDefaults.chapterTemplate(),
            normalizedDefaults.pageTemplate(),
            normalizedDefaults.pagePad(),
            normalizedDefaults.chapterPad(),
            normalizedDefaults.volumePad(),
            Map.copyOf(normalizedProfiles)
        );
    }

    /**
     * Resolve the effective naming profile for a title type.
     *
     * @param rawType raw upstream type text
     * @return normalized per-type profile
     */
    public RavenNamingProfile profileForType(String rawType) {
        RavenNamingProfile fallbackProfile = new RavenNamingProfile(
            chapterTemplate,
            pageTemplate,
            pagePad,
            chapterPad,
            volumePad
        ).normalized();
        return profilesOrEmpty().getOrDefault(
            normalizeTypeSlug(rawType),
            fallbackProfile
        );
    }

    /**
     * Return the known per-type profiles, falling back to an empty map when the
     * underlying payload omitted the profile object entirely.
     *
     * @return immutable map of per-type profiles
     */
    public Map<String, RavenNamingProfile> profilesOrEmpty() {
        return profiles == null ? Map.of() : profiles;
    }

    private static Map<String, RavenNamingProfile> defaultProfiles(RavenNamingProfile defaults) {
        Map<String, RavenNamingProfile> profiles = new LinkedHashMap<>();
        for (String typeSlug : KNOWN_TYPE_SLUGS) {
            profiles.put(typeSlug, defaults.normalized());
        }
        return Map.copyOf(profiles);
    }

    private static RavenNamingProfile mergeProfile(RavenNamingProfile defaults, RavenNamingProfile requested) {
        RavenNamingProfile safeRequested = requested == null ? defaults : requested;
        return new RavenNamingProfile(
            safeRequested.chapterTemplate() == null || safeRequested.chapterTemplate().isBlank()
                ? defaults.chapterTemplate()
                : safeRequested.chapterTemplate(),
            safeRequested.pageTemplate() == null || safeRequested.pageTemplate().isBlank()
                ? defaults.pageTemplate()
                : safeRequested.pageTemplate(),
            safeRequested.pagePad() <= 0 ? defaults.pagePad() : safeRequested.pagePad(),
            safeRequested.chapterPad() <= 0 ? defaults.chapterPad() : safeRequested.chapterPad(),
            safeRequested.volumePad() <= 0 ? defaults.volumePad() : safeRequested.volumePad()
        ).normalized();
    }

    private static String normalizeTypeSlug(String rawType) {
        if (rawType == null || rawType.isBlank()) {
            return "";
        }
        String normalized = LibraryNaming.slugifySegment(rawType.trim().toLowerCase(Locale.ROOT));
        return normalized == null ? "" : normalized;
    }

    static String normalizeTemplate(String template, String fallback, String rawToken, String paddedToken) {
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
