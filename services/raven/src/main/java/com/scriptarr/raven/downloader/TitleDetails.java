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
    List<Map<String, String>> relatedSeries
) {
}
