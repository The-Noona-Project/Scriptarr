package com.scriptarr.raven.downloader;

import java.text.Normalizer;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Require a complete source title or provider-declared alias before trusting bulk metadata selection. */
public final class BulkMetadataAnchor {
    private static final Set<String> EDITIONS = Set.of("reboot", "remake", "colored", "novel");

    /** Prevent construction of this stateless metadata policy. */
    private BulkMetadataAnchor() { }

    /**
     * Match full original source labels, preserving edition markers across translated provider aliases.
     * Search queries, partial title matches and undeclared shortened labels are never anchors.
     * @param sourceTitle complete original provider title
     * @param sourceAliases aliases explicitly supplied by the download provider
     * @param metadataSnapshot selected metadata root and optional details object
     * @return whether a full source label matches metadata with compatible edition evidence
     */
    public static boolean matches(String sourceTitle, List<String> sourceAliases, Map<String, Object> metadataSnapshot) {
        String original = normalize(sourceTitle);
        if (original.isEmpty() || metadataSnapshot == null) return false;
        Set<String> sourceLabels = new LinkedHashSet<>();
        sourceLabels.add(original);
        if (sourceAliases != null) for (String alias : sourceAliases) addLabel(sourceLabels, alias);
        Set<String> metadataLabels = new LinkedHashSet<>();
        addMetadataLabels(metadataLabels, metadataSnapshot);
        Map<?, ?> details = metadataSnapshot.get("details") instanceof Map<?, ?> nested ? nested : Map.of();
        addMetadataLabels(metadataLabels, details);
        Set<String> requiredEditions = editions(original);
        Set<String> explicitEditions = new LinkedHashSet<>();
        for (Map<?, ?> fields : List.of(metadataSnapshot, details)) {
            explicitEditions.addAll(editions(normalize(fields.get("editionLabel"))));
            explicitEditions.addAll(editions(normalize(fields.get("editionClass"))));
        }
        for (String label : metadataLabels) {
            if (!sourceLabels.contains(label)) continue;
            Set<String> confirmed = new LinkedHashSet<>(explicitEditions);
            confirmed.addAll(editions(label));
            if (confirmed.containsAll(requiredEditions)) return true;
        }
        return false;
    }

    /**
     * Collect only explicit metadata title/alias fields, never a matched query or search-result explanation.
     * @param labels normalized destination
     * @param fields metadata object
     */
    private static void addMetadataLabels(Set<String> labels, Map<?, ?> fields) {
        addLabel(labels, fields.get("title"));
        Object aliases = fields.get("aliases");
        if (aliases instanceof List<?> list) for (Object alias : list) addLabel(labels, alias);
        else if (aliases instanceof String) addLabel(labels, aliases);
    }

    /**
     * Add one bounded full title label if its type and normalization are usable.
     * @param labels normalized destination
     * @param value potential label
     */
    private static void addLabel(Set<String> labels, Object value) {
        String normalized = normalize(value);
        if (!normalized.isEmpty()) labels.add(normalized);
    }

    /**
     * Normalize case, punctuation and one leading English article while retaining all edition words.
     * @param value optional label
     * @return normalized Unicode letters and digits, or empty for malformed input
     */
    private static String normalize(Object value) {
        if (!(value instanceof String text) || text.length() > 4096) return "";
        String normalized = Normalizer.normalize(text, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT)
            .replaceAll("['\u2018\u2019\u02bc]", "")
            .replaceAll("[^\\p{L}\\p{N}]+", " ").trim();
        return normalized.startsWith("the ") ? normalized.substring(4) : normalized;
    }

    /**
     * Identify supported explicit edition words without removing them from the full label.
     * @param normalized normalized complete label
     * @return edition markers requiring matching metadata evidence
     */
    private static Set<String> editions(String normalized) {
        Set<String> result = new LinkedHashSet<>();
        for (String word : normalized.split(" ")) if (EDITIONS.contains(word)) result.add(word);
        return result;
    }
}
