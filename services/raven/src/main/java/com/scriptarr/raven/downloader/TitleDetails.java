package com.scriptarr.raven.downloader;

import java.util.List;
import java.util.Map;

/**
 * Scraped title-detail payload from Raven's source provider.
 */
public record TitleDetails(
    String summary,
    String type,
    List<String> associatedNames,
    String status,
    String released,
    Boolean adultContent,
    Boolean officialTranslation,
    Boolean animeAdaptation,
    List<String> tags,
    List<Map<String, String>> relatedSeries,
    String sourceTitle,
    List<String> authors,
    String coverUrl
) {
    /** Preserve provider and fixture compatibility when richer source fields are absent. */
    public TitleDetails(String summary, String type, List<String> associatedNames, String status, String released,
        Boolean adultContent, Boolean officialTranslation, Boolean animeAdaptation, List<String> tags,
        List<Map<String, String>> relatedSeries) {
        this(summary, type, associatedNames, status, released, adultContent, officialTranslation, animeAdaptation,
            tags, relatedSeries, "", List.of(), "");
    }
}
