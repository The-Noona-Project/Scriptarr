package com.scriptarr.raven.library;

import java.math.BigDecimal;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/** Restore only explicitly planned, source-bound chapter identities; never infer numeric gaps. */
final class PlannedChapterGaps {
    private PlannedChapterGaps() { }

    /**
     * Validate a frozen plan and return missing catalog rows without inventing page counts.
     * @param title canonical owner loaded under its operation lock
     * @param source original frozen series URL
     * @param expected explicit accepted source chapters
     * @param identity stable chapter identity factory
     * @return absent rows to checkpoint individually
     */
    static List<LibraryChapter> absent(LibraryTitle title, String source, List<Map<String, String>> expected, Function<String, String> identity) {
        if (!source.equals(title.sourceUrl())) throw new IllegalStateException("Planned chapter source no longer owns this title.");
        URI series = URI.create(source);
        Set<String> present = new HashSet<>();
        title.chapters().forEach(chapter -> present.add(number(chapter.chapterNumber())));
        List<LibraryChapter> missing = new ArrayList<>();
        for (Map<String, String> row : expected) {
            String value = row.getOrDefault("chapter_number", "").trim(), url = row.getOrDefault("href", "").trim();
            URI chapter = URI.create(url);
            if (value.isBlank() || !"https".equals(chapter.getScheme()) || chapter.getUserInfo() != null || chapter.getPort() != -1
                || !java.util.Objects.equals(series.getHost(), chapter.getHost()) || !chapter.getPath().matches("/chapters/[A-Za-z0-9_-]+/?")
                || chapter.getQuery() != null || chapter.getFragment() != null) throw new IllegalStateException("Frozen chapter source identity is invalid.");
            if (!present.add(number(value))) continue;
            missing.add(new LibraryChapter(identity.apply(value), row.getOrDefault("chapter_title", "Chapter " + value), value, 0,
                row.get("release_date"), false, "", url, "missing_content", 0, 0, List.of(),
                List.of("An accepted source chapter has no canonical archive. Source page counts remain unverified."),
                "missing", "", 0, null, "", "", null));
        }
        return List.copyOf(missing);
    }

    private static String number(String value) {
        try { return new BigDecimal(value).stripTrailingZeros().toPlainString(); }
        catch (RuntimeException invalid) { return value == null ? "" : value.trim(); }
    }
}
