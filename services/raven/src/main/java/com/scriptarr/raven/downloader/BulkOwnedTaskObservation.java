package com.scriptarr.raven.downloader;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

/** Pure reconciliation of accepted title outcomes, including work finishing after its parent pauses. */
final class BulkOwnedTaskObservation {
    private BulkOwnedTaskObservation() { }

    /**
     * Observe durable owned tasks without dispatching, cancelling, or spending retry allowances.
     * @param previous last batch checkpoint
     * @param tasks complete owned task history
     * @param stale active-stall classifier, never based on queue age
     * @param now timestamp used only for newly observed terminal receipts
     * @return updated outcome projection with unchanged discovery and attempt evidence
     */
    static Map<String, Object> reconcile(Map<String, Object> previous, List<Map<String, Object>> tasks,
                                         Predicate<Map<String, Object>> stale, String now) {
        Map<String, Object> result = new LinkedHashMap<>(previous), terminals = map(previous.get("terminalOutcomes"));
        Map<String, Map<String, Object>> snapshots = new LinkedHashMap<>();
        tasks.forEach(task -> snapshots.put(text(task.get("taskId")), task));
        Set<String> ids = strings(previous.get("taskIds")); ids.addAll(snapshots.keySet()); ids.addAll(terminals.keySet());
        Set<String> completed = strings(previous.get("completedTaskIds")), failed = new LinkedHashSet<>(), missing = new LinkedHashSet<>(), stalled = new LinkedHashSet<>();
        Map<String, Object> observed = new LinkedHashMap<>(); int queued = 0, running = 0;
        for (String id : ids) {
            Map<String, Object> task = snapshots.get(id);
            String state = task == null ? "missing" : text(task.get("status"));
            if (task != null && (!text(task.get("persistenceError")).isBlank()
                || !text(map(task.get("details")).get("persistenceError")).isBlank())) state = "failed";
            if (completed.contains(id) || "completed".equals(text(map(terminals.get(id)).get("status")))) state = "completed";
            observed.put(id, state);
            switch (state) {
                case "completed" -> {
                    completed.add(id);
                    terminals.putIfAbsent(id, Map.of("status", "completed", "observedAt", now,
                        "titleId", task == null ? "" : text(task.get("titleId"))));
                }
                case "queued", "pending" -> queued++;
                case "running" -> { running++; if (stale.test(task)) stalled.add(id); }
                case "missing" -> missing.add(id);
                default -> failed.add(id);
            }
        }
        result.put("taskIds", List.copyOf(ids)); result.put("queuedTaskIds", List.copyOf(ids));
        result.put("completedTaskIds", List.copyOf(completed)); result.put("failedTaskIds", List.copyOf(failed));
        result.put("missingTaskIds", List.copyOf(missing)); result.put("removedTaskIds", List.of()); result.put("staleTaskIds", List.copyOf(stalled));
        result.put("terminalOutcomes", terminals); result.put("observedStatuses", observed);
        result.put("runningTitleTaskCount", running); result.put("queuedTitleTaskCount", queued);
        result.put("lastFinishedCount", completed.size());
        result.put("terminalCounts", Map.of("completed", completed.size(), "failed", failed.size(), "missing", missing.size(), "removed", 0, "stale", stalled.size()));
        Map<String, Object> recovery = map(result.get("recoveryAction"));
        if (!recovery.isEmpty()) {
            List<String> attention = new ArrayList<>(failed); attention.addAll(missing);
            recovery.put("taskIds", attention); result.put("recoveryAction", recovery);
        }
        return result;
    }

    /** @param left stored JSON value @param right observed JSON value @return equality independent of numeric wrapper types */
    static boolean sameValue(Object left, Object right) {
        if (left instanceof Number && right instanceof Number) return new java.math.BigDecimal(left.toString()).compareTo(new java.math.BigDecimal(right.toString())) == 0;
        if (left instanceof Map<?, ?> a && right instanceof Map<?, ?> b) return a.keySet().equals(b.keySet()) && a.keySet().stream().allMatch(key -> sameValue(a.get(key), b.get(key)));
        if (left instanceof List<?> a && right instanceof List<?> b) {
            if (a.size() != b.size()) return false;
            for (int i = 0; i < a.size(); i++) if (!sameValue(a.get(i), b.get(i))) return false;
            return true;
        }
        return java.util.Objects.equals(left, right);
    }

    private static String text(Object value) { return value == null ? "" : String.valueOf(value); }
    private static Set<String> strings(Object value) {
        Set<String> result = new LinkedHashSet<>();
        if (value instanceof List<?> rows) rows.forEach(row -> result.add(text(row)));
        return result;
    }
    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return value instanceof Map<?, ?> ? new LinkedHashMap<>((Map<String, Object>) value) : new LinkedHashMap<>();
    }
}
