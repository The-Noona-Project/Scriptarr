package com.scriptarr.raven.downloader;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Immutable membership and deterministic ordering for a capped type/letter batch. */
final class BulkTitleLimit {
    private final int limit;
    private final boolean frozen;
    private final Set<String> selected = new LinkedHashSet<>();
    private final Set<String> considered = new LinkedHashSet<>();
    private final Set<String> deferredRechecks = new LinkedHashSet<>();

    /** @param value optional positive integer @return zero for legacy unlimited runs */
    static int parse(Object value) {
        if (value == null) return 0;
        String raw = String.valueOf(value);
        if (!raw.matches("[1-9][0-9]*")) throw new IllegalArgumentException("titleLimit must be a positive integer.");
        try { return Integer.parseInt(raw); }
        catch (NumberFormatException error) { throw new IllegalArgumentException("titleLimit is too large."); }
    }

    /** @param limit positive cap or zero @param saved durable frozen membership, or null during preparation */
    BulkTitleLimit(int limit, Map<String, Object> saved) {
        this.limit = limit;
        frozen = saved != null;
        if (saved != null) {
            if (parse(saved.get("titleLimit")) != limit || !(saved.get("selectedUrls") instanceof List<?> urls)
                || !(saved.get("consideredUrls") instanceof List<?> visited)) throw new IllegalStateException("Malformed capped selection; reconcile its durable identity.");
            urls.forEach(url -> selected.add(String.valueOf(url)));
            visited.forEach(url -> considered.add(String.valueOf(url)));
            if (selected.size() != urls.size() || selected.size() > limit || !considered.containsAll(selected)) throw new IllegalStateException("Invalid capped selection membership.");
        }
    }

    /** @param rows complete discovered candidates @return deterministic order for capped runs */
    List<Map<String, String>> ordered(List<Map<String, String>> rows) {
        if (limit == 0) return rows;
        Set<String> discovered = new LinkedHashSet<>();
        rows.forEach(row -> discovered.add(row.getOrDefault("href", "")));
        if (!discovered.containsAll(considered)) throw new IllegalStateException("Frozen capped selection is missing from durable discovery.");
        return rows.stream().sorted(Comparator.comparing((Map<String, String> row) -> row.getOrDefault("title", "").toLowerCase(Locale.ROOT))
            .thenComparing(row -> row.getOrDefault("href", ""))).toList();
    }

    /** @param url source identity @return whether this candidate belongs to the preparation/execution window */
    boolean consider(String url) {
        if (limit == 0) return true;
        if (frozen) return considered.contains(url);
        if (selected.size() >= limit) return false;
        considered.add(url);
        return true;
    }

    /** @param url prepared or unresolved identity; a failed slot is never replaced */
    void select(String url) {
        if (limit == 0) return;
        if (frozen && !selected.contains(url)) throw new IllegalStateException("A frozen selection cannot admit another title.");
        selected.add(url);
        if (selected.size() > limit) throw new IllegalStateException("Capped batch exceeded its title limit.");
    }

    /** @param url source identity @return whether work was selected in the frozen manifest */
    boolean selected(String url) { return selected.contains(url); }

    /** @param url explicitly reopened policy skip outside immutable membership */
    void deferRecheck(String url) {
        if (!frozen || selected.contains(url) || !considered.contains(url)) throw new IllegalStateException("Invalid out-of-scope metadata recheck.");
        deferredRechecks.add(url);
    }

    /** @return whether a durable membership manifest already exists */
    boolean frozen() { return frozen; }

    /** @return durable manifest; caller persists before any enqueue */
    Map<String, Object> payload() { return Map.of("titleLimit", limit, "selectedUrls", new ArrayList<>(selected), "consideredUrls", new ArrayList<>(considered)); }

    /** @param total complete discovery count @return observational selection counters */
    Map<String, Object> counts(int total) { return Map.of("titleLimit", limit, "selectedCount", selected.size(), "deferredByLimitCount", Math.max(0, total - considered.size()) + deferredRechecks.size()); }
}
