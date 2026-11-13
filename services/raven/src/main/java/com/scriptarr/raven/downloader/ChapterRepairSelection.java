package com.scriptarr.raven.downloader;

import com.scriptarr.raven.library.LibraryChapter;
import com.scriptarr.raven.library.LibraryTitle;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/** Validate owner-selected repair scope independently from mutable source searches. */
final class ChapterRepairSelection {
    private ChapterRepairSelection() { }

    /** @param body caller selection @return bounded sorted exact chapter identities */
    static List<String> ids(Map<String, Object> body) {
        Object raw = body.get("chapterIds");
        if (!(raw instanceof List<?> values) || values.isEmpty() || values.size() > 50
            || values.stream().anyMatch(v -> !(v instanceof String text) || (!text.matches("[A-Za-z0-9_.:-]{1,160}") || List.of(".", "..").contains(text)))) throw new IllegalArgumentException("Select between 1 and 50 chapter IDs.");
        List<String> ids = values.stream().map(String.class::cast).distinct().sorted().toList();
        if (ids.size() != values.size()) throw new IllegalArgumentException("Chapter IDs must be unique.");
        return ids;
    }

    /** @param value stable request key @return validated caller key */
    static String requestId(Object value) {
        if (!(value instanceof String text) || !text.matches("[A-Za-z0-9:._-]{1,200}")) throw new IllegalArgumentException("A stable requestId is required.");
        return text;
    }

    /** @param owner authenticated actor @param requestId stable key @return owner-scoped deterministic task identity */
    static String taskId(String owner, String requestId) { return "task_repair_" + hash(owner + "\n" + requestId); }

    /** @param titleId exact canonical title @param owner authenticated actor @param ids sorted chapter identities @return immutable request fingerprint */
    static String fingerprint(String titleId, String owner, List<String> ids) { return hash(titleId + "\n" + owner + "\n" + String.join("\n", ids)); }

    /** @param title current catalog @param ids exact selection @return frozen chapter scopes whose URLs belong to this saved title */
    static List<Map<String, Object>> freeze(LibraryTitle title, List<String> ids) {
        List<Map<String, Object>> chapters = new ArrayList<>();
        for (String id : ids) {
            LibraryChapter chapter = title.chapters().stream().filter(c -> id.equals(c.id())).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Selected chapter does not belong to this title."));
            if (chapter.available() && "clean".equals(chapter.qualityStatus()) && chapter.missingPageCount() == 0) throw new IllegalArgumentException("Select damaged or unavailable chapters only.");
            String source = chapter.sourceUrl();
            if (source == null || source.isBlank()) throw new IllegalArgumentException("The selected chapter has no verified source URL.");
            java.net.URI series = java.net.URI.create(title.sourceUrl()), url = java.net.URI.create(source);
            if (!"https".equals(url.getScheme()) || url.getUserInfo() != null || url.getPort() != -1 || !java.util.Objects.equals(series.getHost(), url.getHost())
                || !url.getPath().matches("/chapters/[A-Za-z0-9_-]+/?") || url.getQuery() != null || url.getFragment() != null) throw new IllegalArgumentException("The selected chapter source is invalid.");
            chapters.add(Map.of("id", id, "chapter_number", chapter.chapterNumber(), "href", source, "chapter_title", chapter.label() == null ? "Chapter " + chapter.chapterNumber() : chapter.label(),
                "expectedPageCount", chapter.sourcePageCount() != null && chapter.sourcePageCount() > 0 ? chapter.sourcePageCount() : chapter.expectedPageCount()));
        }
        return List.copyOf(chapters);
    }

    private static String hash(String text) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
