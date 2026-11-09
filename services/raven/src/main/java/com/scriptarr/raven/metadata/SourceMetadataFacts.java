package com.scriptarr.raven.metadata;

import com.scriptarr.raven.downloader.BulkMetadataAnchor;
import com.scriptarr.raven.downloader.BulkTitleSelection;
import com.scriptarr.raven.downloader.TitleDetails;
import java.text.Normalizer;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Source evidence and metadata provenance shared by identification and bulk recovery. */
public final class SourceMetadataFacts {
    private SourceMetadataFacts() { }

    /** Check complete aliases and explicit source years without erasing edition distinctions. */
    public static boolean matches(String title, TitleDetails source, Map<String, Object> metadata) {
        if (source == null || metadata == null || metadata.containsKey("error")) return false;
        if (!text(source.sourceTitle()).isEmpty() && !normalize(title).equals(normalize(source.sourceTitle()))
            && (source.associatedNames() == null || source.associatedNames().stream().noneMatch(alias -> normalize(title).equals(normalize(alias))))) return false;
        String year = year(source.released());
        String candidateYear = year(metadata.get("releaseLabel"));
        if (!year.isEmpty() && !year.equals(candidateYear)) return false;
        if (Boolean.TRUE.equals(metadata.get("adultContent")) && Boolean.FALSE.equals(source.adultContent())) return false;
        String type = text(metadata.get("type"));
        if (!type.isEmpty() && !java.util.Objects.equals(BulkTitleSelection.type(source.type()), BulkTitleSelection.type(type))) return false;
        if (BulkMetadataAnchor.matches(title, source.associatedNames(), metadata)) return true;
        // A provider-declared year alias can establish a reboot whose provider does not name it "Reboot".
        if (year.isEmpty() || !year.equals(candidateYear) || source.associatedNames() == null) return false;
        List<String> labels = new ArrayList<>(strings(metadata.get("aliases")));
        labels.add(text(metadata.get("title")));
        for (String alias : source.associatedNames()) for (String label : labels) {
            if (!label.isBlank() && normalize(alias).equals(normalize(label + " (" + year + ")"))) return true;
        }
        return false;
    }

    /** Detect adult classification conflicts only after the candidate's actual identity matches. */
    public static boolean adultConflict(String title, TitleDetails source, Map<String, Object> metadata) {
        if (!Boolean.TRUE.equals(metadata.get("adultContent")) || !Boolean.FALSE.equals(source.adultContent())) return false;
        Map<String, Object> identity = new LinkedHashMap<>(metadata);
        identity.remove("adultContent");
        return matches(title, source, identity);
    }

    /** Build a verified source-backed fallback; unknown adult classification never qualifies. */
    public static Map<String, Object> fallback(String provider, String url, String title, TitleDetails source) {
        if (!BulkTitleSelection.validSeriesUrl(url) || source == null || !Boolean.FALSE.equals(source.adultContent())
            || text(title).isBlank() || BulkTitleSelection.type(source.type()) == null || text(source.summary()).isBlank()
            || text(source.sourceTitle()).isBlank() || !normalize(title).equals(normalize(source.sourceTitle()))) {
            throw new IllegalStateException("Source metadata is incomplete or not explicitly non-adult.");
        }
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("provider", "source"); metadata.put("providerSeriesId", url);
        metadata.put("title", title); metadata.put("summary", source.summary()); metadata.put("url", url);
        metadata.put("releaseLabel", text(source.released())); metadata.put("status", text(source.status()));
        metadata.put("author", String.join(", ", source.authors() == null ? List.of() : source.authors()));
        metadata.put("aliases", source.associatedNames() == null ? List.of() : source.associatedNames());
        metadata.put("tags", source.tags() == null ? List.of() : source.tags());
        metadata.put("type", source.type()); metadata.put("coverUrl", text(source.coverUrl()));
        metadata.put("adultContent", false);
        return bind(provider, url, title, source, metadata, "source-backed");
    }

    /** Attach original source facts and tag origins to a verified provider detail snapshot. */
    public static Map<String, Object> bind(String provider, String url, String title, TitleDetails source,
        Map<String, Object> metadata, String decision) {
        Map<String, Object> result = new LinkedHashMap<>(metadata);
        result.put("displayTitle", title);
        Map<String, Object> facts = sourceFacts(provider, url, title, source);
        result.put("sourceBinding", Map.of("version", 1, "decision", decision, "source", facts,
            "provider", text(metadata.get("provider")), "providerSeriesId", text(metadata.get("providerSeriesId")),
            "verifiedAt", Instant.now().toString()));
        List<Map<String, Object>> origins = new ArrayList<>();
        LinkedHashSet<String> tags = new LinkedHashSet<>();
        for (String tag : strings(metadata.get("tags"))) addTag(tags, origins, tag, text(metadata.get("provider")));
        if (source.tags() != null) for (String tag : source.tags()) addTag(tags, origins, tag, provider);
        result.put("tags", List.copyOf(tags)); result.put("tagOrigins", origins);
        return result;
    }

    /** Collect source facts without claiming a verified provider binding or writing durable state. */
    public static Map<String, Object> sourceFacts(String provider, String url, String title, TitleDetails source) {
        Map<String, Object> facts = new LinkedHashMap<>();
        facts.put("provider", provider); facts.put("url", url); facts.put("title", title);
        facts.put("aliases", source.associatedNames() == null ? List.of() : source.associatedNames());
        facts.put("year", text(source.released())); facts.put("status", text(source.status()));
        facts.put("type", text(source.type())); facts.put("adultContent", source.adultContent());
        facts.put("authors", source.authors() == null ? List.of() : source.authors());
        facts.put("summary", text(source.summary())); facts.put("coverUrl", text(source.coverUrl()));
        facts.put("tags", source.tags() == null ? List.of() : source.tags());
        return facts;
    }

    /** Return a four-digit release year when a provider actually supplied one. */
    public static String year(Object value) {
        var matcher = java.util.regex.Pattern.compile("(?<![0-9])(?:19|20)[0-9]{2}(?![0-9])").matcher(text(value));
        return matcher.find() ? matcher.group() : "";
    }

    /** Read bounded string arrays without interpreting provider data as instructions. */
    public static List<String> strings(Object value) {
        if (!(value instanceof Iterable<?> values)) return List.of();
        List<String> result = new ArrayList<>();
        for (Object item : values) if (item instanceof String tag && !tag.isBlank() && tag.length() <= 512 && result.size() < 200) result.add(tag.trim());
        return result;
    }

    private static void addTag(LinkedHashSet<String> tags, List<Map<String, Object>> origins, String tag, String provider) {
        String existing = tags.stream().filter(t -> normalize(t).equals(normalize(tag))).findFirst().orElse(tag);
        tags.add(existing); origins.add(Map.of("tag", existing, "provider", provider));
    }
    private static String normalize(String value) {
        return Normalizer.normalize(text(value), Normalizer.Form.NFKC).toLowerCase(Locale.ROOT)
            .replaceAll("['’]", "").replaceAll("[^\\p{L}\\p{N}]+", " ").trim().replaceFirst("^the ", "");
    }
    private static String text(Object value) { return value instanceof String text ? text.trim() : ""; }
}
