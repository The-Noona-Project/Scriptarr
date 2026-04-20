package com.scriptarr.raven.downloader.providers;

import com.scriptarr.raven.downloader.BulkBrowseResult;
import com.scriptarr.raven.downloader.SourceFinder;
import com.scriptarr.raven.downloader.TitleDetails;
import com.scriptarr.raven.downloader.TitleScraper;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * WeebCentral download provider implementation.
 */
@Component
public class WeebCentralDownloadProvider implements DownloadProvider {
    private final TitleScraper titleScraper;
    private final SourceFinder sourceFinder;

    /**
     * Create the WeebCentral provider adapter.
     *
     * @param titleScraper WeebCentral title scraper
     * @param sourceFinder WeebCentral page scraper
     */
    public WeebCentralDownloadProvider(TitleScraper titleScraper, SourceFinder sourceFinder) {
        this.titleScraper = titleScraper;
        this.sourceFinder = sourceFinder;
    }

    @Override
    public String id() {
        return "weebcentral";
    }

    @Override
    public String name() {
        return "WeebCentral";
    }

    @Override
    public boolean supportsUrl(String titleUrl) {
        if (titleUrl == null || titleUrl.isBlank()) {
            return false;
        }
        try {
            String host = URI.create(titleUrl.trim()).getHost();
            return host != null && host.toLowerCase(Locale.ROOT).contains("weebcentral");
        } catch (Exception ignored) {
            return false;
        }
    }

    @Override
    public List<Map<String, String>> searchTitles(String query) {
        return titleScraper.searchManga(query);
    }

    @Override
    public BulkBrowseResult browseTitlesAlphabetically(String type, boolean adultContent, String titlePrefix) {
        return titleScraper.browseTitlesAlphabetically(type, adultContent, titlePrefix);
    }

    @Override
    public TitleDetails getTitleDetails(String titleUrl) {
        return titleScraper.getTitleDetails(titleUrl);
    }

    @Override
    public List<Map<String, String>> getChapters(String titleUrl) {
        return titleScraper.getChapters(titleUrl);
    }

    @Override
    public List<String> resolvePages(String chapterUrl) {
        return sourceFinder.findSource(chapterUrl);
    }
}
