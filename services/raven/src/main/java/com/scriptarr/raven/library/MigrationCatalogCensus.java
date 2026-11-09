package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.scriptarr.raven.settings.RavenBrokerClient;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Strict background-only catalog census; public compact cards cannot establish complete migration ownership. */
final class MigrationCatalogCensus {
    /** Prevent construction of this census utility. */
    private MigrationCatalogCensus() { }

    /** @param broker existing Sage catalog transport @return every distinct canonical identity, without retaining chapter bodies @throws IllegalStateException when the complete raw census is unavailable or malformed */
    static List<Title> read(RavenBrokerClient broker) {
        try {
            JsonNode rows = broker.listLibraryTitles();
            if (rows == null || !rows.isArray()) throw invalid();
            List<Title> titles = new ArrayList<>(); Set<String> ids = new HashSet<>();
            for (JsonNode row : rows) {
                Title title = describe(row); if (!ids.add(title.id())) throw invalid(); titles.add(title);
            }
            return List.copyOf(titles);
        } catch (Exception unavailable) {
            if (unavailable instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new IllegalStateException("Could not enumerate the complete migration catalog.", unavailable);
        }
    }

    /** @param row full raw title or exact ownership reload @return validated tiny canonical identity @throws IllegalStateException when missing fields could silently exclude content */
    static Title describe(JsonNode row) {
        if (row == null || !row.isObject() || row.has("error") || !text(row, "id") || !text(row, "title") || !text(row, "libraryTypeSlug") || !row.path("chapters").isArray()) throw invalid();
        boolean eligible = false; Set<String> chapterIds = new HashSet<>();
        for (JsonNode chapter : row.path("chapters")) {
            if (!chapter.isObject() || chapter.has("error") || !text(chapter, "id") || !chapterIds.add(chapter.path("id").asText())
                || !chapter.path("available").isBoolean() || !chapter.has("archivePath") || !(chapter.path("archivePath").isTextual() || chapter.path("archivePath").isNull())) throw invalid();
            eligible |= chapter.path("available").asBoolean() && chapter.path("archivePath").isTextual() && !chapter.path("archivePath").asText().isBlank();
        }
        return new Title(row.path("id").asText(), row.path("title").asText(), LibraryNaming.normalizeTypeSlug(row.path("libraryTypeSlug").asText()), eligible);
    }

    /** @param row raw catalog object @param key required text field @return whether exact text is present and nonblank */
    private static boolean text(JsonNode row, String key) { return row.path(key).isTextual() && !row.path(key).asText().isBlank(); }

    /** @return bounded failure without catalog values or provider data */
    private static IllegalStateException invalid() { return new IllegalStateException("The complete migration catalog response is malformed."); }

    /** Tiny canonical migration scope; equal display names never collapse distinct IDs. */
    record Title(String id, String title, String type, boolean eligible) { }
}
