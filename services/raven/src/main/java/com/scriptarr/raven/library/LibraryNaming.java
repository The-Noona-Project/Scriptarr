package com.scriptarr.raven.library;

import java.util.Locale;
import java.util.Optional;

/**
 * Shared naming and type-normalization helpers for Raven library storage.
 */
public final class LibraryNaming {
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
