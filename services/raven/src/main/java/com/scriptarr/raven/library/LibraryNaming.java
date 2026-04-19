package com.scriptarr.raven.library;

import com.scriptarr.raven.settings.RavenNamingSettings;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Shared naming and type-normalization helpers for Raven library storage.
 */
public final class LibraryNaming {
    private static final Pattern TOKEN_PATTERN = Pattern.compile("\\{([a-z_]+)}");
    private static final Pattern CHAPTER_PATTERN = Pattern.compile("(?i)(?:chapter|c|_c)\\s*([0-9]+(?:\\.[0-9]+)?)");
    private static final Pattern ANY_NUMBER_PATTERN = Pattern.compile("([0-9]+(?:\\.[0-9]+)?)");

    private LibraryNaming() {
    }

    /**
     * Normalize a source or request type into Raven's stored display label.
     *
     * @param rawType raw upstream type text
     * @return normalized display label
     */
    public static String normalizeTypeLabel(String rawType) {
        String normalized = Optional.ofNullable(rawType).orElse("").trim().replaceFirst("(?i)^Type:?\\s*", "");
        if (normalized.isBlank()) {
            return "Manga";
        }

        String lower = normalized.toLowerCase(Locale.ROOT);
        return switch (lower) {
            case "manga", "managa" -> "Manga";
            case "manhwa" -> "Manhwa";
            case "manhua" -> "Manhua";
            case "comic" -> "Comic";
            case "webtoon" -> "Webtoon";
            case "oel" -> "OEL";
            default -> prettifyLabel(normalized);
        };
    }

    /**
     * Normalize a stored display label into Raven's folder-safe slug.
     *
     * @param rawType raw upstream type text
     * @return folder-safe type slug
     */
    public static String normalizeTypeSlug(String rawType) {
        return slugifySegment(normalizeTypeLabel(rawType));
    }

    /**
     * Resolve the backward-compatible media type field used by Moon.
     *
     * @param rawType raw upstream type text
     * @return normalized media type scope
     */
    public static String normalizeMediaType(String rawType) {
        String slug = normalizeTypeSlug(rawType);
        return switch (slug) {
            case "comic" -> "comic";
            case "webtoon" -> "webtoon";
            case "manhwa" -> "manhwa";
            case "manhua" -> "manhua";
            default -> "manga";
        };
    }

    /**
     * Build a filesystem-safe title folder segment.
     *
     * @param titleName human title
     * @return sanitized folder segment
     */
    public static String sanitizeTitleFolder(String titleName) {
        String normalized = Optional.ofNullable(titleName).orElse("scriptarr-title").trim();
        if (normalized.isBlank()) {
            normalized = "scriptarr-title";
        }
        return normalized.replaceAll("[^\\p{Alnum}._-]+", "_").replaceAll("_+", "_");
    }

    /**
     * Convert a title folder segment back into a display label.
     *
     * @param folderName folder segment to read
     * @return human display name
     */
    public static String titleFromFolder(String folderName) {
        return Optional.ofNullable(folderName).orElse("Untitled").replace('_', ' ').trim();
    }

    /**
     * Slugify a generic type or identifier segment for storage and routes.
     *
     * @param value raw value
     * @return normalized slug
     */
    public static String slugifySegment(String value) {
        String normalized = Optional.ofNullable(value).orElse("").trim().toLowerCase(Locale.ROOT);
        String slug = normalized
            .replaceAll("[^a-z0-9]+", "-")
            .replaceAll("^-+", "")
            .replaceAll("-+$", "");
        return slug.isBlank() ? "manga" : slug;
    }

    /**
     * Build a chapter archive file name from Raven naming settings.
     *
     * @param settings naming settings
     * @param titleName display title
     * @param rawType source type
     * @param chapterNumber normalized chapter number
     * @param volumeNumber optional volume number
     * @param pageCount saved page count
     * @param domain source domain
     * @return sanitized archive file name
     */
    public static String buildChapterArchiveName(
        RavenNamingSettings settings,
        String titleName,
        String rawType,
        String chapterNumber,
        String volumeNumber,
        int pageCount,
        String domain
    ) {
        RavenNamingSettings naming = normalizedSettings(settings);
        String normalizedTitle = Optional.ofNullable(titleName).orElse("").trim();
        String normalizedType = normalizeTypeLabel(rawType);
        String typeSlug = normalizeTypeSlug(rawType);
        String rawChapter = normalizeChapterToken(chapterNumber);
        String chapterPadded = formatNumber(rawChapter, naming.chapterPad());
        String rawVolume = normalizeVolumeToken(volumeNumber);
        String volumePadded = formatNumber(rawVolume, naming.volumePad());

        String template = Optional.ofNullable(naming.chapterTemplate()).orElse(RavenNamingSettings.DEFAULT_CHAPTER_TEMPLATE).trim();
        String rawName;
        if (template.equals(RavenNamingSettings.DEFAULT_CHAPTER_TEMPLATE)) {
            rawName = buildDefaultChapterArchiveName(normalizedTitle, chapterPadded, volumePadded);
        } else {
            rawName = applyTemplate(template, templateValues(
                normalizedTitle,
                normalizedType,
                typeSlug,
                rawChapter,
                chapterPadded,
                rawVolume,
                volumePadded,
                pageCount,
                domain,
                null,
                null,
                ".cbz"
            ));
        }

        String withExt = rawName == null ? "" : rawName.trim();
        if (!withExt.toLowerCase(Locale.ROOT).endsWith(".cbz")) {
            withExt = withExt + ".cbz";
        }

        String sanitized = sanitizeFileName(withExt);
        if (sanitized.isBlank()) {
            sanitized = sanitizeFileName("Chapter " + chapterPadded + ".cbz");
        }
        return sanitized.isBlank() ? "Chapter.cbz" : sanitized;
    }

    /**
     * Build a page file name from Raven naming settings.
     *
     * @param settings naming settings
     * @param titleName display title
     * @param rawType source type
     * @param chapterNumber normalized chapter number
     * @param volumeNumber optional volume number
     * @param pageIndex one-based page index
     * @param extension file extension with or without leading dot
     * @return sanitized page file name
     */
    public static String buildPageFileName(
        RavenNamingSettings settings,
        String titleName,
        String rawType,
        String chapterNumber,
        String volumeNumber,
        int pageIndex,
        String extension
    ) {
        RavenNamingSettings naming = normalizedSettings(settings);
        String normalizedTitle = Optional.ofNullable(titleName).orElse("").trim();
        String normalizedType = normalizeTypeLabel(rawType);
        String typeSlug = normalizeTypeSlug(rawType);
        String rawChapter = normalizeChapterToken(chapterNumber);
        String chapterPadded = formatNumber(rawChapter, naming.chapterPad());
        String rawVolume = normalizeVolumeToken(volumeNumber);
        String volumePadded = formatNumber(rawVolume, naming.volumePad());
        String normalizedExtension = normalizeExtension(extension, ".jpg");
        String pagePadded = String.format(Locale.ROOT, "%0" + naming.pagePad() + "d", Math.max(1, pageIndex));

        String template = Optional.ofNullable(naming.pageTemplate()).orElse(RavenNamingSettings.DEFAULT_PAGE_TEMPLATE).trim();
        boolean containsExt = template.contains("{ext}");
        String rawName = applyTemplate(template, templateValues(
            normalizedTitle,
            normalizedType,
            typeSlug,
            rawChapter,
            chapterPadded,
            rawVolume,
            volumePadded,
            0,
            "",
            String.valueOf(Math.max(1, pageIndex)),
            pagePadded,
            normalizedExtension
        ));
        if (!containsExt) {
            rawName = rawName + normalizedExtension;
        }

        String sanitized = sanitizeFileName(rawName);
        if (!sanitized.toLowerCase(Locale.ROOT).endsWith(normalizedExtension.toLowerCase(Locale.ROOT))) {
            sanitized = sanitizeFileName(sanitized + normalizedExtension);
        }
        return sanitized;
    }

    /**
     * Extract a chapter number from an archive file name using the active
     * Raven naming settings first, then Raven's legacy fallback patterns.
     *
     * @param fileName archive file name
     * @param settings active naming settings
     * @return normalized chapter number or a stable fallback token
     */
    public static String extractChapterNumber(String fileName, RavenNamingSettings settings) {
        String normalized = Optional.ofNullable(fileName).orElse("");
        String templateMatch = extractTemplateNumber(normalized, normalizedSettings(settings).chapterTemplate(), "chapter");
        if (!templateMatch.isBlank()) {
            return normalizeChapterToken(templateMatch);
        }

        Matcher chapterMatcher = CHAPTER_PATTERN.matcher(normalized);
        if (chapterMatcher.find()) {
            return normalizeChapterToken(chapterMatcher.group(1));
        }

        Matcher fallback = ANY_NUMBER_PATTERN.matcher(normalized);
        return fallback.find()
            ? normalizeChapterToken(fallback.group(1))
            : String.valueOf(Math.abs(normalized.hashCode()));
    }

    /**
     * Extract a page number from an archive entry file name using the active
     * Raven naming settings first, then Raven's legacy fallback patterns.
     *
     * @param fileName page file name
     * @param settings active naming settings
     * @return zero-based page sort key
     */
    public static int extractPageOrder(String fileName, RavenNamingSettings settings) {
        String templateMatch = extractTemplateNumber(Optional.ofNullable(fileName).orElse(""), normalizedSettings(settings).pageTemplate(), "page");
        if (!templateMatch.isBlank()) {
            return parsePositiveInt(templateMatch, Integer.MAX_VALUE);
        }

        Matcher fallback = ANY_NUMBER_PATTERN.matcher(Optional.ofNullable(fileName).orElse(""));
        return fallback.find() ? parsePositiveInt(fallback.group(1), Integer.MAX_VALUE) : Integer.MAX_VALUE;
    }

    /**
     * Sanitize an archive or page file name.
     *
     * @param raw raw file name
     * @return sanitized file name
     */
    public static String sanitizeFileName(String raw) {
        return sanitizePathSegment(raw);
    }

    private static RavenNamingSettings normalizedSettings(RavenNamingSettings settings) {
        return Optional.ofNullable(settings).orElse(RavenNamingSettings.defaults()).normalized();
    }

    private static String buildDefaultChapterArchiveName(String title, String chapterPadded, String volumePadded) {
        boolean hasVolume = volumePadded != null && !volumePadded.isBlank();
        if (title == null || title.isBlank()) {
            return hasVolume
                ? String.format(Locale.ROOT, "c%s (v%s) [Scriptarr].cbz", chapterPadded, volumePadded)
                : String.format(Locale.ROOT, "c%s [Scriptarr].cbz", chapterPadded);
        }
        return hasVolume
            ? String.format(Locale.ROOT, "%s c%s (v%s) [Scriptarr].cbz", title, chapterPadded, volumePadded)
            : String.format(Locale.ROOT, "%s c%s [Scriptarr].cbz", title, chapterPadded);
    }

    private static Map<String, String> templateValues(
        String title,
        String type,
        String typeSlug,
        String chapter,
        String chapterPadded,
        String volume,
        String volumePadded,
        int pages,
        String domain,
        String page,
        String pagePadded,
        String extension
    ) {
        Map<String, String> values = new LinkedHashMap<>();
        values.put("title", title);
        values.put("type", type);
        values.put("type_slug", typeSlug);
        values.put("chapter", chapter);
        values.put("chapter_padded", chapterPadded);
        values.put("volume", volume);
        values.put("volume_padded", volumePadded);
        values.put("pages", String.valueOf(Math.max(0, pages)));
        values.put("domain", Optional.ofNullable(domain).orElse(""));
        values.put("page", Optional.ofNullable(page).orElse(""));
        values.put("page_padded", Optional.ofNullable(pagePadded).orElse(""));
        values.put("ext", Optional.ofNullable(extension).orElse(""));
        return values;
    }

    private static String applyTemplate(String template, Map<String, String> values) {
        if (template == null) {
            return "";
        }
        Matcher matcher = TOKEN_PATTERN.matcher(template);
        StringBuffer output = new StringBuffer();
        while (matcher.find()) {
            String key = matcher.group(1);
            String replacement = values.getOrDefault(key, "");
            matcher.appendReplacement(output, Matcher.quoteReplacement(replacement));
        }
        matcher.appendTail(output);
        return stripBlankVolumeSegments(output.toString()).trim();
    }

    private static String stripBlankVolumeSegments(String value) {
        String withoutEmptyVolume = Optional.ofNullable(value).orElse("")
            .replaceAll("\\s*\\(\\s*v\\s*\\)", "")
            .replaceAll("\\s*\\[\\s*v\\s*\\]", "")
            .replaceAll("\\s{2,}", " ")
            .trim();
        return withoutEmptyVolume.replaceAll("\\s+\\.cbz$", ".cbz");
    }

    private static String sanitizePathSegment(String raw) {
        if (raw == null) {
            return "";
        }

        return raw
            .replaceAll("[\\\\/:*?\"<>|]", "")
            .replaceAll("\\p{Cntrl}", "")
            .replaceAll("\\s+", " ")
            .trim()
            .replaceAll("[ .]+$", "")
            .trim();
    }

    private static String extractTemplateNumber(String value, String template, String tokenName) {
        if (value == null || value.isBlank() || template == null || template.isBlank()) {
            return "";
        }

        String patternSource = buildPatternFromTemplate(template, tokenName);
        if (patternSource.isBlank()) {
            return "";
        }

        Matcher matcher = Pattern.compile(patternSource, Pattern.CASE_INSENSITIVE).matcher(value);
        if (!matcher.find()) {
            return "";
        }

        String direct = groupIfPresent(matcher, captureGroupName(tokenName));
        if (direct != null && !direct.isBlank()) {
            return direct.trim();
        }
        String padded = groupIfPresent(matcher, captureGroupName(tokenName + "_padded"));
        return padded == null ? "" : padded.trim();
    }

    private static String buildPatternFromTemplate(String template, String targetToken) {
        Matcher matcher = TOKEN_PATTERN.matcher(template);
        int cursor = 0;
        StringBuilder pattern = new StringBuilder("^");
        boolean foundTarget = false;
        while (matcher.find()) {
            pattern.append(Pattern.quote(template.substring(cursor, matcher.start())));
            String token = matcher.group(1);
            pattern.append(tokenPattern(token, targetToken));
            if (token.equals(targetToken) || token.equals(targetToken + "_padded")) {
                foundTarget = true;
            }
            cursor = matcher.end();
        }
        pattern.append(Pattern.quote(template.substring(cursor)));
        pattern.append("$");
        return foundTarget ? pattern.toString() : "";
    }

    private static String tokenPattern(String token, String targetToken) {
        return switch (token) {
            case "chapter", "page", "volume" -> token.equals(targetToken)
                ? "(?<" + captureGroupName(token) + ">[0-9]+(?:\\.[0-9]+)?)"
                : "[0-9]+(?:\\.[0-9]+)?";
            case "chapter_padded", "page_padded", "volume_padded" -> token.equals(targetToken + "_padded")
                ? "(?<" + captureGroupName(token) + ">[0-9]+(?:\\.[0-9]+)?)"
                : "[0-9]+(?:\\.[0-9]+)?";
            case "title", "type", "type_slug", "domain" -> ".+?";
            case "pages" -> "[0-9]+";
            case "ext" -> "\\.[A-Za-z0-9]{1,8}";
            default -> ".*?";
        };
    }

    private static String normalizeChapterToken(String value) {
        if (value == null || value.isBlank()) {
            return "0";
        }
        try {
            return new java.math.BigDecimal(value.trim()).stripTrailingZeros().toPlainString();
        } catch (NumberFormatException ignored) {
            return value.trim();
        }
    }

    private static String normalizeVolumeToken(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        try {
            String normalized = new java.math.BigDecimal(value.trim()).stripTrailingZeros().toPlainString();
            return "0".equals(normalized) ? "" : normalized;
        } catch (NumberFormatException ignored) {
            return value.trim();
        }
    }

    private static String formatNumber(String value, int width) {
        String normalized = Optional.ofNullable(value).orElse("").trim();
        if (normalized.isBlank()) {
            return "";
        }

        String[] parts = normalized.split("\\.", 2);
        try {
            int whole = Integer.parseInt(parts[0]);
            String padded = String.format(Locale.ROOT, "%0" + Math.max(1, width) + "d", whole);
            if (parts.length == 2 && !parts[1].isBlank()) {
                return padded + "." + parts[1];
            }
            return padded;
        } catch (NumberFormatException ignored) {
            return normalized;
        }
    }

    private static String normalizeExtension(String extension, String fallback) {
        String normalized = Optional.ofNullable(extension).orElse("").trim();
        if (normalized.isBlank()) {
            return fallback;
        }
        return normalized.startsWith(".") ? normalized : "." + normalized;
    }

    private static int parsePositiveInt(String value, int fallback) {
        try {
            return Math.max(1, Integer.parseInt(Optional.ofNullable(value).orElse("")));
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private static String captureGroupName(String token) {
        return Optional.ofNullable(token).orElse("").replace("_", "");
    }

    private static String groupIfPresent(Matcher matcher, String groupName) {
        try {
            return matcher.group(groupName);
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }

    private static String prettifyLabel(String value) {
        String[] parts = Optional.ofNullable(value).orElse("").trim().split("\\s+");
        StringBuilder output = new StringBuilder();
        for (String part : parts) {
            if (part.isBlank()) {
                continue;
            }
            if (output.length() > 0) {
                output.append(' ');
            }
            output.append(Character.toUpperCase(part.charAt(0)));
            if (part.length() > 1) {
                output.append(part.substring(1).toLowerCase(Locale.ROOT));
            }
        }
        return output.isEmpty() ? "Manga" : output.toString();
    }
}
