package com.scriptarr.raven.downloader;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Validate and apply durable chapter selections consistently for initial and append downloads. */
final class ChapterSelection {
    private ChapterSelection() { }

    /** @return whether the caller supplied an explicit selection, including invalid empty selections */
    static boolean explicit(Map<String, Object> selected) {
        return selected != null && selected.containsKey("chapterNumbers");
    }

    /** @return normalized requested numbers; absence retains the legacy unbounded initial-download contract */
    static Set<String> numbers(Map<String, Object> selected) {
        if (!explicit(selected)) return Set.of();
        if (!(selected.get("chapterNumbers") instanceof List<?> values) || values.isEmpty()) {
            throw new IllegalArgumentException("chapterNumbers must be a nonempty list of chapter numbers.");
        }
        Set<String> wanted = new LinkedHashSet<>();
        for (Object value : values) {
            if (!(value instanceof String || value instanceof Number) || value.toString().isBlank()
                || value instanceof Double d && !Double.isFinite(d) || value instanceof Float f && !Float.isFinite(f)) {
                throw new IllegalArgumentException("chapterNumbers contains an invalid chapter number.");
            }
            wanted.add(normalize(value.toString()));
        }
        if (selected.get("expectedChapters") instanceof List<?> rows && !rows.isEmpty()) {
            Set<String> covered = new LinkedHashSet<>();
            for (Object row : rows) if (row instanceof Map<?, ?> fields && fields.get("chapter_number") != null) {
                covered.add(normalize(fields.get("chapter_number").toString()));
            }
            if (!covered.containsAll(wanted)) throw new IllegalArgumentException("expectedChapters must cover every selected chapter number.");
        }
        return wanted;
    }

    /** @return the requested recovery scope before a source chapter snapshot has been persisted */
    static List<Map<String, String>> expected(Map<String, Object> selected) {
        return numbers(selected).stream().map(n -> Map.of("chapter_number", n)).toList();
    }

    /** @return source-ordered chapters inside the explicit scope; append without a scope never expands to all chapters */
    static List<Map<String, String>> select(List<Map<String, String>> source, Map<String, Object> selected, boolean append) {
        Set<String> wanted = numbers(selected);
        if (!explicit(selected)) return append ? List.of() : source;
        return source.stream().filter(row -> wanted.contains(normalize(row.getOrDefault("chapter_number", ""))))
            .map(row -> (Map<String, String>) new LinkedHashMap<>(row)).toList();
    }

    private static String normalize(String value) {
        try { return new BigDecimal(value.trim()).stripTrailingZeros().toPlainString(); }
        catch (NumberFormatException ignored) { return value.trim(); }
    }
}
