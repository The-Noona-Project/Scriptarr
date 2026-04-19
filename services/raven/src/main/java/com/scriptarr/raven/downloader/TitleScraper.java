package com.scriptarr.raven.downloader;

import com.scriptarr.raven.support.ScriptarrLogger;
import org.jsoup.Connection;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Search and chapter scraper for Raven's current source provider.
 */
@Component
public class TitleScraper {
    private static final String SOURCE_BASE_URL = "https://weebcentral.com";
    private static final String USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

    private final ScriptarrLogger logger;

    /**
     * Create the title scraper with Raven logging support.
     *
     * @param logger shared Raven logger
     */
    public TitleScraper(ScriptarrLogger logger) {
        this.logger = logger;
    }

    /**
     * Search the upstream source for candidate series.
     *
     * @param titleName search query supplied by the user
     * @return normalized title search results
     */
    public List<Map<String, String>> searchManga(String titleName) {
        if (titleName == null || titleName.isBlank()) {
            return List.of();
        }

        try {
            Document doc = fetchSearchData(Map.of(
                "text", titleName.trim(),
                "sort", "Best Match",
                "order", "Ascending",
                "official", "Any",
                "anime", "Any",
                "adult", "Any",
                "display_mode", "Full Display"
            ));
            return parseSearchResults(doc);
        } catch (Exception error) {
            logger.warn("SCRAPER", "Search request failed.", error.getMessage());
            return List.of();
        }
    }

    /**
     * Fetch and normalize the chapter list for a title source page.
     *
     * @param titleUrl source series URL
     * @return normalized chapters ordered by the upstream source
     */
    public List<Map<String, String>> getChapters(String titleUrl) {
        if (titleUrl == null || titleUrl.isBlank()) {
            return List.of();
        }

        try {
            String listUrl = resolveFullChapterListUrl(titleUrl);
            if (listUrl == null || listUrl.isBlank()) {
                return List.of();
            }

            Document doc = Jsoup.connect(listUrl)
                .userAgent(USER_AGENT)
                .timeout(15000)
                .get();

            List<Map<String, String>> rawChapters = new ArrayList<>();
            Elements chapterLinks = doc.select("a[href^=https://weebcentral.com/chapters/], a[href^=/chapters/]");
            for (int index = 0; index < chapterLinks.size(); index++) {
                Element chapter = chapterLinks.get(index);
                String chapterTitle = chapter.text();
                String href = chapter.absUrl("href");
                String chapterNumber = normalizeChapterNumber(extractChapterNumberFull(chapterTitle));

                Map<String, String> data = new HashMap<>();
                data.put("chapter_number", chapterNumber.isEmpty() ? String.valueOf(index + 1) : chapterNumber);
                data.put("chapter_title", chapterTitle);
                data.put("href", href);
                rawChapters.add(data);
            }

            return dedupeExactChapters(rawChapters);
        } catch (Exception error) {
            logger.warn("SCRAPER", "Chapter list request failed.", error.getMessage());
            return List.of();
        }
    }

    private Document fetchSearchData(Map<String, String> queryParameters) throws Exception {
        Connection connection = Jsoup.connect(SOURCE_BASE_URL + "/search/data")
            .userAgent(USER_AGENT)
            .timeout(15000);
        for (Map.Entry<String, String> entry : queryParameters.entrySet()) {
            connection.data(entry.getKey(), entry.getValue());
        }
        return connection.get();
    }

    private List<Map<String, String>> parseSearchResults(Document doc) {
        if (doc == null) {
            return List.of();
        }

        Elements resultCards = doc.select("article.bg-base-300");
        if (resultCards.isEmpty()) {
            Elements titleAnchors = doc.select("a.line-clamp-1.link.link-hover");
            for (Element anchor : titleAnchors) {
                Element parent = anchor.parent();
                if (parent != null) {
                    resultCards.add(parent);
                }
            }
        }

        Set<String> seen = new HashSet<>();
        List<Map<String, String>> parsed = new ArrayList<>();
        for (Element card : resultCards) {
            Element link = card.selectFirst("a[href*=/series/], a[href^=https://weebcentral.com/series/]");
            if (link == null) {
                continue;
            }

            String href = link.absUrl("href");
            if (href == null || href.isBlank() || !seen.add(href)) {
                continue;
            }

            String title = href;
            Element titleAnchor = card.selectFirst("a.line-clamp-1.link.link-hover");
            if (titleAnchor != null && !titleAnchor.text().isBlank()) {
                title = titleAnchor.text();
            }

            Map<String, String> entry = new HashMap<>();
            entry.put("title", title);
            entry.put("href", href);

            Element image = card.selectFirst("img[src]");
            if (image != null) {
                String coverUrl = image.absUrl("src");
                if (!coverUrl.isBlank()) {
                    entry.put("coverUrl", coverUrl);
                }
            }

            String mediaType = extractMediaTypeFromCard(card);
            if (mediaType != null) {
                entry.put("type", mediaType);
            }

            parsed.add(entry);
        }
        return parsed.isEmpty() ? List.of() : List.copyOf(parsed);
    }

    /**
     * Fetch rich title details from the upstream source page.
     *
     * @param titleUrl source series URL
     * @return normalized title detail payload, or {@code null} on failure
     */
    public TitleDetails getTitleDetails(String titleUrl) {
        if (titleUrl == null || titleUrl.isBlank()) {
            return null;
        }

        try {
            Document doc = Jsoup.connect(titleUrl.trim())
                .userAgent(USER_AGENT)
                .timeout(15000)
                .get();

            return new TitleDetails(
                extractSummary(doc),
                extractLabeledValue(doc, "Type"),
                extractLabeledList(doc, "Associated Name(s)"),
                extractLabeledValue(doc, "Status"),
                extractLabeledValue(doc, "Released"),
                parseBooleanFlag(extractLabeledValue(doc, "Official Translation")),
                parseBooleanFlag(extractLabeledValue(doc, "Anime Adaptation")),
                extractRelatedSeries(doc)
            );
        } catch (Exception error) {
            logger.warn("SCRAPER", "Title details request failed.", error.getMessage());
            return null;
        }
    }

    private String resolveFullChapterListUrl(String titleUrl) {
        try {
            URI uri = URI.create(titleUrl.trim());
            String[] parts = uri.getPath().split("/");
            String seriesId = null;
            for (int index = 0; index < parts.length; index++) {
                if ("series".equals(parts[index]) && index + 1 < parts.length) {
                    seriesId = parts[index + 1];
                    break;
                }
            }
            if (seriesId == null || seriesId.isBlank()) {
                return null;
            }

            String scheme = uri.getScheme() != null ? uri.getScheme() : "https";
            String host = uri.getHost() != null ? uri.getHost() : "weebcentral.com";
            return scheme + "://" + host + "/series/" + seriesId + "/full-chapter-list";
        } catch (Exception ignored) {
            return null;
        }
    }

    private List<Map<String, String>> dedupeExactChapters(List<Map<String, String>> chapters) {
        Set<String> seenHrefs = new HashSet<>();
        List<Map<String, String>> selected = new ArrayList<>();
        for (Map<String, String> chapter : chapters) {
            String href = chapter.get("href");
            if (href == null || href.isBlank() || !seenHrefs.add(href)) {
                continue;
            }
            selected.add(chapter);
        }
        return selected.isEmpty() ? List.of() : List.copyOf(selected);
    }

    private String extractChapterNumberFull(String text) {
        Matcher chapterMatcher = Pattern.compile("Chapter\\s*(\\d+(\\.\\d+)?)", Pattern.CASE_INSENSITIVE).matcher(text == null ? "" : text);
        if (chapterMatcher.find()) {
            return chapterMatcher.group(1);
        }

        Matcher fallback = Pattern.compile("(\\d+(\\.\\d+)?)").matcher(text == null ? "" : text);
        if (fallback.find()) {
            return fallback.group(1);
        }
        return "";
    }

    private String normalizeChapterNumber(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        try {
            return new BigDecimal(value).stripTrailingZeros().toPlainString();
        } catch (NumberFormatException ignored) {
            return value.trim();
        }
    }

    private String normalizeMediaType(String raw) {
        if (raw == null) {
            return null;
        }

        String trimmed = raw.trim();
        if (trimmed.isBlank()) {
            return null;
        }

        String cleaned = trimmed.replaceFirst("(?i)^Type:?\\s*", "").replaceAll("\\s+", " ").trim();
        if (cleaned.isBlank()) {
            return null;
        }

        String lower = cleaned.toLowerCase(Locale.ROOT);
        return switch (lower) {
            case "manga", "managa" -> "manga";
            case "manhwa" -> "manhwa";
            case "manhua" -> "manhua";
            case "webtoon" -> "webtoon";
            case "comic" -> "comic";
            default -> "manga";
        };
    }

    private String extractSummary(Document doc) {
        Element description = doc.selectFirst("strong:matchesOwn((?i)Description) + p");
        if (description == null) {
            return null;
        }
        String summary = description.text();
        return summary == null || summary.isBlank() ? null : summary.trim();
    }

    private String extractLabeledValue(Document doc, String label) {
        Element section = findLabeledSection(doc, label);
        if (section == null) {
            return null;
        }

        Element labelElement = section.selectFirst("strong");
        Element sibling = labelElement != null ? labelElement.nextElementSibling() : null;
        while (sibling != null) {
            String siblingText = sibling.text();
            if (siblingText != null && !siblingText.isBlank()) {
                return siblingText.trim();
            }
            sibling = sibling.nextElementSibling();
        }

        String sectionText = section.text();
        if (sectionText == null || sectionText.isBlank()) {
            return null;
        }

        String cleaned = sectionText
            .replaceFirst("(?i)^\\s*" + Pattern.quote(label) + "\\s*:?\\s*", "")
            .trim();
        return cleaned.isBlank() ? null : cleaned;
    }

    private List<String> extractLabeledList(Document doc, String label) {
        Element section = findLabeledSection(doc, label);
        if (section == null) {
            return List.of();
        }

        Elements items = section.select("> ul > li");
        if (items.isEmpty()) {
            items = section.select("ul > li");
        }

        List<String> values = new ArrayList<>();
        for (Element item : items) {
            String text = cleanExtractedValue(item.text());
            if (text != null && !text.isBlank()) {
                values.add(text);
            }
        }
        return values.isEmpty() ? List.of() : List.copyOf(values);
    }

    private List<Map<String, String>> extractRelatedSeries(Document doc) {
        Element section = findLabeledSection(doc, "Related Series(s)");
        if (section == null) {
            return List.of();
        }

        Elements items = section.select("> ul > li");
        if (items.isEmpty()) {
            items = section.select("ul > li");
        }

        List<Map<String, String>> values = new ArrayList<>();
        for (Element item : items) {
            Element link = item.selectFirst("a[href]");
            String title = cleanExtractedValue(link != null ? link.text() : item.ownText());
            String sourceUrl = link != null ? cleanExtractedValue(link.absUrl("href")) : null;
            String relation = null;
            Element relationElement = item.selectFirst("span");
            if (relationElement != null) {
                relation = cleanRelationValue(relationElement.text());
            }

            Map<String, String> entry = new LinkedHashMap<>();
            if (title != null && !title.isBlank()) {
                entry.put("title", title);
            }
            if (sourceUrl != null && !sourceUrl.isBlank()) {
                entry.put("sourceUrl", sourceUrl);
            }
            if (relation != null && !relation.isBlank()) {
                entry.put("relation", relation);
            }
            if (!entry.isEmpty()) {
                values.add(entry);
            }
        }

        return values.isEmpty() ? List.of() : List.copyOf(values);
    }

    private Element findLabeledSection(Document doc, String label) {
        String normalizedTarget = normalizeLabelText(label);
        for (Element strong : doc.select("strong")) {
            String ownText = strong.ownText();
            if (ownText == null || ownText.isBlank()) {
                continue;
            }
            if (!normalizedTarget.equals(normalizeLabelText(ownText))) {
                continue;
            }
            Element parent = strong.parent();
            if (parent != null) {
                return parent;
            }
        }
        return null;
    }

    private String normalizeLabelText(String value) {
        return value == null ? "" : value.replace(":", "").trim().toLowerCase(Locale.ROOT);
    }

    private String cleanExtractedValue(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isBlank() ? null : trimmed;
    }

    private String cleanRelationValue(String value) {
        String cleaned = cleanExtractedValue(value);
        if (cleaned == null) {
            return null;
        }
        return cleaned
            .replaceFirst("^[\\(\\[]\\s*", "")
            .replaceFirst("\\s*[\\)\\]]$", "")
            .trim();
    }

    private Boolean parseBooleanFlag(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case "yes", "true", "1", "adult", "explicit", "nsfw" -> true;
            case "no", "false", "0", "safe", "clean" -> false;
            default -> null;
        };
    }

    private String extractMediaTypeFromCard(Element card) {
        Element typeLabel = card.selectFirst("strong:matchesOwn((?i)^Type:?)");
        if (typeLabel != null) {
            Element parent = typeLabel.parent();
            if (parent != null) {
                Element typeValue = parent.selectFirst("span");
                if (typeValue != null && !typeValue.text().isBlank()) {
                    return normalizeMediaType(typeValue.text());
                }
                String raw = parent.text();
                if (raw != null && !raw.isBlank()) {
                    return normalizeMediaType(raw.replaceFirst("(?i)^Type:?\\s*", ""));
                }
            }
        }

        for (Element tooltip : card.select("span.tooltip[data-tip]")) {
            String normalized = normalizeMediaType(tooltip.attr("data-tip"));
            if (normalized != null) {
                return normalized;
            }
        }

        return null;
    }
}
