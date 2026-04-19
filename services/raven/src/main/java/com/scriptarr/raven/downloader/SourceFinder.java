package com.scriptarr.raven.downloader;

import com.scriptarr.raven.support.ScriptarrLogger;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Source page scraper that extracts chapter image URLs from supported hosts.
 */
@Component
public class SourceFinder {
    private static final String USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

    private final ScriptarrLogger logger;

    /**
     * Create the source finder with Raven logging support.
     *
     * @param logger shared Raven logger
     */
    public SourceFinder(ScriptarrLogger logger) {
        this.logger = logger;
    }

    /**
     * Find page image URLs for a chapter source page.
     *
     * @param chapterUrl chapter URL to inspect
     * @return ordered page image URLs
     */
    public List<String> findSource(String chapterUrl) {
        if (chapterUrl == null || chapterUrl.isBlank()) {
            return List.of();
        }

        String normalizedUrl = chapterUrl.trim();
        if (normalizedUrl.contains("weebcentral.com/chapters/")) {
            List<String> weebCentral = scrapeWeebCentral(normalizedUrl);
            if (!weebCentral.isEmpty()) {
                return weebCentral;
            }
        }

        return genericImageScrape(normalizedUrl);
    }

    private List<String> scrapeWeebCentral(String chapterUrl) {
        String base = chapterUrl.endsWith("/") ? chapterUrl.substring(0, chapterUrl.length() - 1) : chapterUrl;
        String imagesUrl = base + "/images?is_prev=False&current_page=1&reading_style=long_strip";

        try {
            Document doc = Jsoup.connect(imagesUrl)
                .userAgent(USER_AGENT)
                .timeout(15000)
                .get();
            return extractImageUrls(doc.select("img[src], img[data-src]"));
        } catch (Exception error) {
            logger.warn("SOURCE", "WeebCentral image scrape failed.", error.getMessage());
            return List.of();
        }
    }

    private List<String> genericImageScrape(String chapterUrl) {
        try {
            Document doc = Jsoup.connect(chapterUrl)
                .userAgent(USER_AGENT)
                .timeout(15000)
                .get();
            Elements images = doc.select("main img[src], img[src*=/media/], img[data-src]");
            return extractImageUrls(images);
        } catch (Exception error) {
            logger.warn("SOURCE", "Generic image scrape failed.", error.getMessage());
            return List.of();
        }
    }

    private List<String> extractImageUrls(Elements images) {
        Set<String> unique = new LinkedHashSet<>();
        for (Element image : images) {
            String src = image.hasAttr("data-src") ? image.absUrl("data-src") : image.absUrl("src");
            if (src == null || src.isBlank()) {
                continue;
            }
            unique.add(src);
        }
        return unique.isEmpty() ? List.of() : List.copyOf(new ArrayList<>(unique));
    }
}
