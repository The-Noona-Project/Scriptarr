package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;

/** Preserve retained artwork when a background checkpoint still carries a blank cover snapshot. */
final class LibraryCoverCheckpoint {
    /** Prevent construction of this stateless checkpoint helper. */
    private LibraryCoverCheckpoint() {
    }

    /**
     * Merge only stored cover art from a successful exact-id compact lookup.
     * Vault resolves aliases before filtering and echoes that canonical identity in filters.ids.
     *
     * @param incoming original title checkpoint, including unchanged chapter and ingest state
     * @param response compact card page returned for the one requested title identity
     * @return incoming title with stored artwork retained when present
     * @throws IOException when the lookup is malformed, incomplete or outside its resolved identity
     */
    static LibraryTitle preserve(LibraryTitle incoming, JsonNode response) throws IOException {
        if (response == null || !response.isObject() || response.hasNonNull("error") || response.hasNonNull("degraded")) {
            throw invalid();
        }
        JsonNode cards = response.path("titles"), ids = response.path("filters").path("ids"), page = response.path("pageInfo");
        if (!cards.isArray() || cards.size() > 1 || !ids.isArray() || ids.size() != 1
            || !ids.get(0).isTextual() || ids.get(0).asText().isBlank()
            || !page.path("hasMore").isBoolean() || page.path("hasMore").asBoolean()
            || !page.path("total").isIntegralNumber() || page.path("total").asLong() != cards.size()) {
            throw invalid();
        }
        if (cards.isEmpty()) {
            return incoming;
        }
        JsonNode card = cards.get(0);
        if (!card.isObject() || !card.path("id").isTextual() || !ids.get(0).asText().equals(card.path("id").asText())
            || !card.path("coverUrl").isTextual()) {
            throw invalid();
        }
        String cover = card.path("coverUrl").asText();
        return cover.isBlank() ? incoming : incoming.withCoverUrl(cover);
    }

    /**
     * Describe a failed strict lookup without exposing provider URLs or transport details.
     *
     * @return bounded lookup failure to propagate before any title write
     */
    private static IOException invalid() {
        return new IOException("Could not verify the stored cover for this title checkpoint.");
    }
}
