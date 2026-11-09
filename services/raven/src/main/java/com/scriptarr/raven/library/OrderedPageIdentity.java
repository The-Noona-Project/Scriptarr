package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/** Versioned logical page ordering shared by content jobs, worker artifacts and immutable reader revisions. */
public final class OrderedPageIdentity {
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Prevent construction of this identity utility. */
    private OrderedPageIdentity() { }

    /** @param entries exact ordered ZIP names @return unambiguous compact-JSON order digest @throws IOException when entries cannot be hashed */
    public static String digest(List<String> entries) throws IOException {
        if (entries == null || entries.isEmpty() || entries.stream().anyMatch(java.util.Objects::isNull)) throw new IOException("Frozen source page order is unavailable.");
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(JSON.writeValueAsBytes(entries))); }
        catch (NoSuchAlgorithmException unavailable) { throw new IOException("Source page identity is unavailable.", unavailable); }
    }

    /** @param entries exact ordered ZIP names @return explicit new content identity fields @throws IOException when ordering is unavailable */
    public static Map<String, Object> create(List<String> entries) throws IOException {
        return Map.of("contentIdentityVersion", 2, "orderedEntriesSha256", digest(entries));
    }

    /** @param value input, bundle or saved manifest @return strict versioned fields, or empty for an unchanged legacy identity @throws IOException when fields are partial or unsupported */
    public static Map<String, Object> fields(JsonNode value) throws IOException {
        if (value == null || !value.isObject()) throw new IOException("Source page identity is unavailable.");
        boolean version = value.has("contentIdentityVersion"), order = value.has("orderedEntriesSha256");
        if (!version && !order) return Map.of();
        if (!version || !order || !value.path("contentIdentityVersion").isIntegralNumber() || !value.path("contentIdentityVersion").canConvertToInt() || value.path("contentIdentityVersion").asInt() != 2
            || !value.path("orderedEntriesSha256").isTextual() || !value.path("orderedEntriesSha256").asText().matches("[a-f0-9]{64}")) throw new IOException("Unsupported source page identity.");
        return Map.of("contentIdentityVersion", 2, "orderedEntriesSha256", value.path("orderedEntriesSha256").asText());
    }

    /** @param input immutable job input @return validated identity fields @throws IOException when the declared digest differs from the frozen entries */
    public static Map<String, Object> validateInput(JsonNode input) throws IOException {
        Map<String, Object> identity = fields(input);
        if (identity.isEmpty()) return identity;
        JsonNode values = input.path("entries"); List<String> entries = new ArrayList<>();
        if (!values.isArray()) throw new IOException("Frozen source page order is unavailable.");
        for (JsonNode entry : values) { if (!entry.isTextual()) throw new IOException("Frozen source page order is unavailable."); entries.add(entry.asText()); }
        if (!digest(entries).equals(identity.get("orderedEntriesSha256"))) throw new IOException("Frozen source page order differs.");
        return identity;
    }

    /** @param bundle accepted worker metadata @param input immutable job input @throws IOException when artifact ordering is not the exact frozen ordering */
    public static void requireBundle(JsonNode bundle, JsonNode input) throws IOException {
        if (!fields(bundle).equals(validateInput(input))) throw new IOException("Worker source page identity differs.");
    }
}
