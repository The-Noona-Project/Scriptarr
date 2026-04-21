package com.scriptarr.raven.library;

import java.util.Locale;

/**
 * Normalize upstream provider lifecycle labels into the shared Scriptarr title
 * status vocabulary used by Moon, Sage, and Raven.
 */
public final class SeriesLifecycle {
    private SeriesLifecycle() {
    }

    /**
     * Convert a provider-specific lifecycle string into Raven's canonical
     * status labels.
     *
     * @param rawStatus upstream lifecycle label
     * @return normalized status or an empty string when no useful status exists
     */
    public static String normalizeStatus(String rawStatus) {
        if (rawStatus == null || rawStatus.isBlank()) {
            return "";
        }

        String normalized = rawStatus.trim()
            .toLowerCase(Locale.ROOT)
            .replace('_', ' ')
            .replace('-', ' ')
            .replaceAll("\\s+", " ");

        return switch (normalized) {
            case "completed", "complete", "finished", "ended", "end", "publishing finished" -> "completed";
            case "ongoing", "publishing", "releasing", "currently publishing", "continuing", "active" -> "active";
            case "hiatus", "on hiatus", "on hold", "paused" -> "hiatus";
            case "cancelled", "canceled", "discontinued" -> "cancelled";
            case "not yet released", "upcoming", "unreleased", "tba" -> "upcoming";
            default -> normalized.isBlank() ? "" : normalized.replace(' ', '-');
        };
    }
}
