package com.scriptarr.raven.downloader;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

/**
 * Stable bulk creation identities and fingerprints for retried Discord requests.
 */
final class BulkRunIdentity {
    private BulkRunIdentity() {
    }

    /**
     * Validate an optional caller creation or decision key.
     *
     * @param value caller key
     * @return trimmed key, or an empty string for legacy callers
     */
    static String requestId(Object value) {
        String raw = value == null ? "" : String.valueOf(value);
        if (raw.length() > 200 || raw.codePoints().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("requestId must contain at most 200 printable characters.");
        }
        return raw.trim();
    }

    /**
     * Derive a namespaced run id, retaining random ids for unkeyed legacy callers.
     *
     * @param requestId optional stable request id
     * @return durable run id
     */
    static String runId(String requestId) {
        return "bulkrun_" + (requestId.isBlank()
            ? UUID.randomUUID().toString().replace("-", "")
            : digest(List.of("scriptarr-raven:bulk-create:v1", requestId)));
    }

    /**
     * Fingerprint canonical command options and its owner using length-prefixed fields.
     *
     * @param type canonical library type
     * @param group canonical title group
     * @param nsfw adult-content policy
     * @param batches approval window size
     * @param actor requesting owner
     * @return canonical fingerprint
     */
    static String fingerprint(String type, String group, boolean nsfw, int batches, String actor) {
        return digest(List.of("weebcentral", type, group, String.valueOf(nsfw), String.valueOf(batches), actor));
    }

    /**
     * Hash unambiguous UTF-8 fields without exposing their original values.
     *
     * @param fields ordered identity fields
     * @return SHA-256 hex digest
     */
    static String digest(List<String> fields) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String field : fields) {
                byte[] bytes = field.getBytes(StandardCharsets.UTF_8);
                digest.update((bytes.length + ":").getBytes(StandardCharsets.US_ASCII));
                digest.update(bytes);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable.", error);
        }
    }
}
