package com.scriptarr.raven.downloader;

import java.net.URI;
import java.util.Locale;

/** Shared fail-closed title selection for WeebCentral bulk discovery and enqueueing. */
public final class BulkTitleSelection {
    private static final URI ORIGIN = URI.create("https://weebcentral.com");

    private BulkTitleSelection() { }

    /**
     * Normalize an explicitly supported type without falling back to Manga.
     *
     * @param value requested or confirmed source type
     * @return display type, or null when unknown
     */
    public static String type(String value) {
        return switch (text(value).toLowerCase(Locale.ROOT)) {
            case "manga", "managa" -> "Manga";
            case "manhwa" -> "Manhwa";
            case "manhua" -> "Manhua";
            case "oel" -> "OEL";
            default -> null;
        };
    }

    /**
     * Remove leading punctuation consistently using Unicode code points.
     *
     * @param value visible title
     * @return comparable title
     */
    public static String comparable(String value) {
        String title = text(value);
        int offset = 0;
        while (offset < title.length()) {
            int point = title.codePointAt(offset);
            if (Character.isLetterOrDigit(point)) break;
            offset += Character.charCount(point);
        }
        return title.substring(offset).trim();
    }

    /**
     * Match a visible prefix, including the numeric bulk group.
     *
     * @param title visible title
     * @param prefix requested prefix
     * @return whether the title belongs to the group
     */
    public static boolean matchesPrefix(String title, String prefix) {
        String candidate = comparable(title).toLowerCase(Locale.ROOT);
        String wanted = text(prefix).toLowerCase(Locale.ROOT);
        if (candidate.isEmpty() || wanted.isEmpty()) return false;
        if ("0-9".equals(wanted)) return candidate.charAt(0) >= '0' && candidate.charAt(0) <= '9';
        return candidate.startsWith(wanted);
    }

    /**
     * Require the production HTTPS origin and an exact source series path.
     *
     * @param value candidate source URL
     * @return whether the production provider owns the series URL
     */
    public static boolean validSeriesUrl(String value) { return validSeriesUrl(value, ORIGIN); }

    /** Return a stable production title URL after strict validation.
     * @param value source URL
     * @return canonical URL, or null for a rejected origin/path
     */
    public static String canonicalSeriesUrl(String value) {
        if (!validSeriesUrl(value)) return null;
        return "https://weebcentral.com" + URI.create(value.trim()).getRawPath().replaceAll("/+$", "");
    }

    /** Validate against an explicitly configured source origin for isolated provider tests. */
    static boolean validSeriesUrl(String value, URI origin) {
        try {
            URI uri = URI.create(text(value));
            if (!text(uri.getScheme()).equalsIgnoreCase(origin.getScheme())
                || !text(uri.getHost()).equalsIgnoreCase(origin.getHost())
                || effectivePort(uri) != effectivePort(origin)
                || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) return false;
            String raw = text(uri.getRawPath()).toLowerCase(Locale.ROOT);
            if (raw.contains("%2f") || raw.contains("%5c") || raw.contains("%2e") || raw.contains("\\")) return false;
            String path = text(uri.getPath());
            if (!path.equals(uri.normalize().getPath())) return false;
            String[] parts = path.replaceAll("/+$", "").split("/", -1);
            return (parts.length == 3 || parts.length == 4) && parts[0].isEmpty()
                && "series".equals(parts[1]) && parts[2].matches("[A-Za-z0-9_-]+")
                && (parts.length == 3 || (!parts[3].isBlank() && !".".equals(parts[3]) && !"..".equals(parts[3])));
        } catch (IllegalArgumentException error) { return false; }
    }

    private static int effectivePort(URI uri) {
        return uri.getPort() >= 0 ? uri.getPort() : ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80);
    }

    private static String text(String value) { return value == null ? "" : value.trim(); }
}
