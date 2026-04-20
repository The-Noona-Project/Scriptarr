package com.scriptarr.raven.downloader;

import com.scriptarr.raven.support.ScriptarrLogger;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Source page scraper that extracts chapter image URLs from supported hosts.
 */
@Component
public class SourceFinder {
    private static final String USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    private static final int SCRAPE_RETRY_ATTEMPTS = 3;
    private static final Duration SCRAPE_TIMEOUT = Duration.ofSeconds(30);
    private static final long RETRY_BACKOFF_MS = 1_500L;

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
            return scrapeWeebCentralChapter(normalizedUrl);
        }

        return genericImageScrape(normalizedUrl);
    }

    /**
     * Scrape a WeebCentral chapter's image endpoint with bounded retries.
     *
     * @param chapterUrl chapter URL whose images Raven should resolve
     * @return ordered page image URLs
     */
    List<String> scrapeWeebCentralChapter(String chapterUrl) {
        String base = chapterUrl.endsWith("/") ? chapterUrl.substring(0, chapterUrl.length() - 1) : chapterUrl;
        String imagesUrl = base + "/images?is_prev=False&current_page=1&reading_style=long_strip";

        for (int attempt = 1; attempt <= SCRAPE_RETRY_ATTEMPTS; attempt++) {
            try {
                Document doc = connect(imagesUrl)
                    .referrer(chapterUrl)
                    .get();
                List<String> urls = extractImageUrls(doc.select("img[src], img[data-src]"));
                if (!urls.isEmpty()) {
                    return urls;
                }
                logger.warn(
                    "SOURCE",
                    "WeebCentral image scrape returned no page URLs.",
                    "attempt=" + attempt + "/" + SCRAPE_RETRY_ATTEMPTS
                );
            } catch (Exception error) {
                logger.warn("SOURCE", "WeebCentral image scrape failed.", error.getMessage());
            }

            if (attempt < SCRAPE_RETRY_ATTEMPTS && !sleepBeforeRetry(imagesUrl, attempt)) {
                break;
            }
        }
        return List.of();
    }

    private List<String> genericImageScrape(String chapterUrl) {
        for (int attempt = 1; attempt <= SCRAPE_RETRY_ATTEMPTS; attempt++) {
            try {
                Document doc = connect(chapterUrl).get();
                Elements images = doc.select("main img[src], img[src*=/media/], img[data-src]");
                List<String> urls = extractImageUrls(images);
                if (!urls.isEmpty()) {
                    return urls;
                }
                logger.warn(
                    "SOURCE",
                    "Generic image scrape returned no page URLs.",
                    "attempt=" + attempt + "/" + SCRAPE_RETRY_ATTEMPTS
                );
            } catch (Exception error) {
                logger.warn("SOURCE", "Generic image scrape failed.", error.getMessage());
            }

            if (attempt < SCRAPE_RETRY_ATTEMPTS && !sleepBeforeRetry(chapterUrl, attempt)) {
                break;
            }
        }
        return List.of();
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

    private org.jsoup.Connection connect(String url) {
        return Jsoup.connect(url)
            .userAgent(USER_AGENT)
            .timeout((int) SCRAPE_TIMEOUT.toMillis());
    }

    private boolean sleepBeforeRetry(String url, int attempt) {
        long delay = isRateLimited(url) ? RETRY_BACKOFF_MS * (attempt + 1L) : RETRY_BACKOFF_MS;
        try {
            Thread.sleep(delay);
            return true;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            logger.warn("SOURCE", "Interrupted while retrying source scraping.", interrupted.getMessage());
            return false;
        }
    }

    private boolean isRateLimited(String url) {
        String normalized = url == null ? "" : url.toLowerCase(Locale.ROOT);
        return normalized.contains("weebcentral");
    }
}
