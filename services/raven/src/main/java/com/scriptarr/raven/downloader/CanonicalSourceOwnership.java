package com.scriptarr.raven.downloader;

import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryTitle;

import java.net.URI;
import java.util.Locale;

/** Pure source identity checks before canonical archive reuse or catalog writes. */
public final class CanonicalSourceOwnership {
    /** Prevent construction of the stateless ownership policy. */
    private CanonicalSourceOwnership() { }

    /**
     * Resolve a source identity without trusting its display slug or query parameters.
     * Known providers use their stable series identifiers; other URLs retain origin and normalized path.
     * @param url retained or requested source URL
     * @return normalized source key, or empty for a blank source
     * @throws IllegalStateException when a nonblank source cannot be safely identified
     */
    public static String sourceKey(String url) {
        String value = text(url);
        if (value.isEmpty()) return "";
        if (value.length() > 8192 || value.chars().anyMatch(Character::isISOControl)) throw conflict();
        try {
            URI uri = new URI(value).normalize();
            String scheme = text(uri.getScheme()).toLowerCase(Locale.ROOT);
            String host = text(uri.getHost()).toLowerCase(Locale.ROOT);
            if (!(scheme.equals("https") || scheme.equals("http")) || host.isEmpty() || uri.getUserInfo() != null
                || uri.getPort() < -1 || uri.getPort() > 65535 || uri.getPort() == 0) throw conflict();
            String rawPath = text(uri.getRawPath());
            if (rawPath.toLowerCase(Locale.ROOT).matches(".*%(?:2f|5c|00|0a|0d).*")) throw conflict();
            int port = uri.getPort();
            String origin = scheme + "://" + host + (port < 0 || scheme.equals("https") && port == 443 || scheme.equals("http") && port == 80 ? "" : ":" + port);
            String decodedPath = text(uri.getPath());
            String[] parts = decodedPath.split("/", -1);
            if (scheme.equals("https") && host.equals("weebcentral.com") && parts.length >= 3 && parts[1].equals("series")) {
                String id = parts[2].toUpperCase(Locale.ROOT);
                if (!id.matches("[0-9A-HJKMNP-TV-Z]{26}")) throw conflict();
                return origin + "/series/" + id.toLowerCase(Locale.ROOT);
            }
            if (scheme.equals("https") && host.equals("mangadex.org") && parts.length >= 3 && parts[1].equals("title")) {
                String id = parts[2].toLowerCase(Locale.ROOT);
                if (!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")) throw conflict();
                return origin + "/title/" + id;
            }
            String path = rawPath.isEmpty() ? "/" : rawPath;
            while (path.length() > 1 && path.endsWith("/")) path = path.substring(0, path.length() - 1);
            return origin + path;
        } catch (Exception invalid) {
            throw conflict();
        }
    }

    /**
     * Reject reuse of content whose canonical source is different or no longer provable.
     * A source-less placeholder is permitted only while it contains no downloaded/ready content evidence.
     * @param catalog existing full catalog title, or null for a genuinely new title
     * @param requestedSourceUrl requested source identity
     * @throws IllegalStateException when existing content has incompatible or ambiguous ownership
     */
    public static void assertCompatible(LibraryTitle catalog, String requestedSourceUrl) {
        if (catalog == null) return;
        if (text(catalog.sourceUrl()).isEmpty()) {
            boolean content = catalog.chaptersDownloaded() > 0 || catalog.ingestedChapterCount() > 0;
            if (catalog.chapters() != null) {
                for (LibraryChapter chapter : catalog.chapters()) {
                    if (chapter == null || chapter.available() || !text(chapter.archivePath()).isEmpty()) content = true;
                }
            }
            if (content) throw conflict();
            return;
        }
        assertSameSource(catalog.sourceUrl(), requestedSourceUrl);
    }

    /**
     * Require the same normalized retained/requested source whenever ownership already exists.
     * @param retainedSourceUrl saved source identity
     * @param requestedSourceUrl incoming source identity
     * @throws IllegalStateException when an existing identity is missing or incompatible in the request
     */
    public static void assertSameSource(String retainedSourceUrl, String requestedSourceUrl) {
        String retained = sourceKey(retainedSourceUrl), requested = sourceKey(requestedSourceUrl);
        if (!retained.isEmpty() && !retained.equals(requested)) throw conflict();
    }

    /**
     * Normalize nullable input without exposing it through an error message.
     * @param value optional input
     * @return trimmed text
     */
    private static String text(String value) { return value == null ? "" : value.trim(); }

    /**
     * Build the bounded ownership failure shared by all rejected paths.
     * @return error containing no URL, credential, title or filesystem value
     */
    private static IllegalStateException conflict() {
        return new IllegalStateException("source_identity_conflict: canonical source ownership is different or ambiguous.");
    }
}
