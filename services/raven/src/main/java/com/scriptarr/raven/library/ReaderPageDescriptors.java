package com.scriptarr.raven.library;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.MissingNode;
import java.util.List;
import java.util.Map;
import java.util.stream.IntStream;

/** Build logical-page descriptors from one manifest snapshot and validate reader selectors. */
final class ReaderPageDescriptors {
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Prevent construction of this reader projection utility. */
    private ReaderPageDescriptors() { }

    /**
     * Read the chapter manifest once, retaining legacy descriptors when it is unavailable.
     * @param chapter saved chapter
     * @param count logical page count
     * @param mediaType saved image MIME type
     * @return one descriptor per logical page from a consistent snapshot
     */
    static List<ReaderPage> describe(LibraryChapter chapter, int count, String mediaType) {
        JsonNode snapshot;
        try { snapshot = DerivedPageManifest.read(chapter).path("pages"); }
        catch (Exception unavailable) { snapshot = MissingNode.getInstance(); }
        JsonNode pages = snapshot;
        return IntStream.range(0, count).mapToObj(index -> {
            JsonNode row = pages.path(index);
            List<Map<String, Object>> segments = row.path("segments").isArray()
                ? JSON.convertValue(row.path("segments"), new TypeReference<>() { }) : List.of();
            Map<String, Object> thumbnail = row.path("thumbnail").isObject()
                ? JSON.convertValue(row.path("thumbnail"), new TypeReference<>() { }) : Map.of();
            return new ReaderPage(index, "Page " + (index + 1), mediaType, row.path("width").asInt(), row.path("height").asInt(), segments, thumbnail);
        }).toList();
    }

    /**
     * Reject malformed selectors without marking otherwise healthy content as damaged.
     * @param payload saved reader chapter
     * @param index logical page index
     * @param segment optional exact segment
     * @param thumbnail whole-first-page variant
     * @return whether the selector addresses a declared logical page variant
     */
    static boolean validSelector(ReaderChapterPayload payload, int index, Integer segment, boolean thumbnail) {
        if (payload == null || index < 0 || index >= payload.pages().size() || (segment != null && segment < 0)) return false;
        if (thumbnail) return index == 0 && segment == null;
        int segments = payload.pages().get(index).segments().size();
        if (segments == 0) return segment == null || segment == 0;
        return segment == null ? segments == 1 : segment < segments;
    }
}
