package com.scriptarr.raven.downloader;

import java.util.List;
import java.util.Map;

/**
 * Scraped title-detail payload from Raven's source provider.
 * @param summary source synopsis
 * @param type media type
 * @param associatedNames source-declared aliases
 * @param status publication status
 * @param released release year label
 * @param adultContent explicit adult classification or null
 * @param officialTranslation official translation availability
 * @param animeAdaptation adaptation availability
 * @param tags source tags
 * @param relatedSeries related source series
 * @param sourceTitle actual source heading
 * @param authors source creators
 * @param coverUrl source cover URL
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
    /**
     * Preserve provider compatibility when richer source fields are absent.
     * @param summary source synopsis
     * @param type media type
     * @param associatedNames source-declared aliases
     * @param status publication status
     * @param released release year label
     * @param adultContent explicit adult classification or null
     * @param officialTranslation official translation availability
     * @param animeAdaptation adaptation availability
     * @param tags source tags
     * @param relatedSeries related source series
     */
    public TitleDetails(String summary, String type, List<String> associatedNames, String status, String released,
        Boolean adultContent, Boolean officialTranslation, Boolean animeAdaptation, List<String> tags,
        List<Map<String, String>> relatedSeries) {
        this(summary, type, associatedNames, status, released, adultContent, officialTranslation, animeAdaptation,
            tags, relatedSeries, "", List.of(), "");
    }
}
